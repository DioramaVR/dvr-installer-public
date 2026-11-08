// The installer engine: which mods exist, which games are here, and putting a
// mod into (and exactly back out of) a game folder. The CLI and the Electron
// app are both thin layers over this.
const fs = require('fs');
const path = require('path');
const steam = require('./steam');
const shortcuts = require('./shortcuts');
const options = require('./options');
const loaders = require('./loaders');
const cfg = require('./cfg');
const preflight = require('./preflight');
const vr = require('./vr');
const pkg = require('./package');
const remote = require('./remote');
const download = require('./download');
const gamedata = require('./gamedata');
const active = require('./active');
const dvr = require('dvr-package');
const { compareVersions, appVersion } = require('./version');

const MANIFEST_DIR = '.dvr';

// mods/<id>/ in this checkout (dev builds made with build-mods), or
// DVR_MODS_DIR. The packaged app ships no mods: it downloads them.
function modsDir() {
  if (process.env.DVR_MODS_DIR) return process.env.DVR_MODS_DIR;
  return path.join(__dirname, '..', 'mods');
}

// Mods kept outside the installer (unreleased ones, in their own repos):
// DVR_EXTRA_MODS lists folders that each hold a mod.json, separated by ";".
// Only this PC's environment adds them; they're never packaged.
function extraModDirs() {
  return (process.env.DVR_EXTRA_MODS || '').split(';').map((d) => d.trim()).filter(Boolean);
}

// Where a version came from:
//   dev       a mod folder with a payload: mods/<id>/ (build-mods) or DVR_EXTRA_MODS
//   download  a package downloaded from the game's index (installRelease)
//   file      a package loaded from a file (sideload; closed betas)
const SOURCES = ['dev', 'download', 'file'];

// Dev builds: mods/<id>/ and DVR_EXTRA_MODS folders.
function loadDev(dir = modsDir()) {
  let ids = [];
  try { ids = fs.readdirSync(dir); } catch { }
  const dirs = [...ids.map((id) => path.join(dir, id)), ...extraModDirs()];
  const mods = [];
  for (const modDir of dirs) {
    const file = path.join(modDir, 'mod.json');
    if (!fs.existsSync(file)) continue;
    const mod = JSON.parse(fs.readFileSync(file, 'utf8'));
    mod.id = mod.id || path.basename(modDir);
    mod.dir = modDir;
    mod.payloadDir = path.join(mod.dir, mod.payload || 'payload');
    const info = path.join(mod.dir, 'payload.json');
    mod.build = fs.existsSync(info) ? JSON.parse(fs.readFileSync(info, 'utf8')) : null;
    mod.source = 'dev';
    mod.maturity = null;
    mod.coreVersion = mod.build?.coreVersion || null;
    mod.knownIssues = [];
    mods.push(mod);
  }
  return mods;
}

// Unpacked packages in the cache (package.js): source "download" or "file",
// as packages.json recorded when they arrived (unknown: "file").
// DVR_CACHE_DIR points the cache elsewhere (tests: an empty temp folder).
function loadPackages() {
  let found = [];
  try { found = pkg.list(); } catch { return []; }
  const mods = [];
  for (const p of found) {
    let mod;
    try { mod = JSON.parse(fs.readFileSync(path.join(p.dir, 'mod.json'), 'utf8')); } catch { continue; }
    const m = p.manifest;
    const from = pkg.origin(m.id, m.version);
    mod.id = m.id;
    mod.dir = p.dir;
    mod.payloadDir = path.join(p.dir, mod.payload || 'payload');
    // The same shape payload.json gives a dev build, so version shows the same way.
    mod.build = { version: m.version, coreVersion: m.coreVersion, ...(m.source || {}), loader: m.loader || mod.loader };
    mod.source = from?.source === 'download' ? 'download' : 'file';
    mod.zipSha256 = from?.sha256 || null;
    // The zip's own label; for a listed release the index's wins (see listedMaturity).
    mod.maturity = m.maturity;
    mod.package = {
      version: m.version, maturity: m.maturity, date: m.date || null,
      coreVersion: m.coreVersion || null, minAppVersion: m.minAppVersion || null, notes: m.notes || null,
    };
    // The release's own facts win over its mod.json's: the manifest is signed.
    if (Array.isArray(m.testedBuildIds)) mod.testedBuildIds = m.testedBuildIds.map(String);
    mod.coreVersion = m.coreVersion || null;
    // The game's known issues when this zip was built (SPEC section 3).
    mod.knownIssues = Array.isArray(m.knownIssues) ? m.knownIssues : [];
    mods.push(mod);
  }
  return mods;
}

const versionOf = (mod) => mod.build?.version || null;
// When a version was made: a package's release date, a dev build's builtAt.
const dateOf = (mod) => {
  const d = mod.package?.date || String(mod.build?.builtAt || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
};
// Newest first. Dev and package versions use different schemes
// (2026.11.01 vs 0.1.0), so the date decides first and the version breaks ties.
// On the same day, the later build time (builtAt, an ISO string) wins.
const builtAtOf = (mod) => String(mod.build?.builtAt || '');
const newestFirst = (a, b) => dateOf(b).localeCompare(dateOf(a)) || builtAtOf(b).localeCompare(builtAtOf(a))
  || compareVersions(versionOf(b), versionOf(a));

// Every version on this PC, grouped by mod id: { id: [mod, ...] }, dev first.
function allVersions(dir = modsDir()) {
  const byId = new Map();
  for (const mod of [...loadDev(dir), ...loadPackages()]) {
    if (!byId.has(mod.id)) byId.set(mod.id, []);
    byId.get(mod.id).push(mod);
  }
  return byId;
}

// The active version of one mod among those on this PC: the package
// active.json names, else a dev build, else the newest package. A named
// version that isn't here yet (backToPublic before its download) falls back
// the same way here; status() reports it as pending. Several dev entries for
// one id (mods/ and DVR_EXTRA_MODS) all stay, as before.
function pickActive(id, list) {
  const dev = list.filter((m) => m.source === 'dev');
  const packages = list.filter((m) => m.source !== 'dev');
  const chosen = active.get(id);
  const named = chosen && packages.find((m) => m.build.version === chosen);
  if (named) return [named];
  if (dev.length) return dev;
  return packages.length ? [[...packages].sort(newestFirst)[0]] : [];
}

// One entry per mod on this PC: its ACTIVE version (see pickActive), so
// install and uninstall work on whatever version the player chose.
function loadMods(dir = modsDir()) {
  const mods = [];
  for (const [id, list] of allVersions(dir)) {
    for (const mod of pickActive(id, list)) {
      mod.versionCount = list.length;
      mods.push(mod);
    }
  }
  return mods.sort((a, b) => a.game.localeCompare(b.game));
}

function getMod(id) {
  const mods = loadMods();
  const mod = mods.find((m) => m.id === id || m.appid === Number(id));
  if (!mod) throw new Error(`No mod "${id}". Known: ${mods.map((m) => m.id).join(', ')}`);
  return mod;
}

const MATURITY_LABELS = { 'closed-beta': 'Closed beta', 'open-beta': 'Open beta', stable: 'Stable' };
// "Closed beta" etc.; null for a dev build (no maturity) or an unknown value.
const maturityLabel = (m) => MATURITY_LABELS[m] || null;

// The game folder for a mod: gameDirs[id] (tests, a chosen folder) or Steam's.
function findGameDir(mod, gameDirs = {}) {
  if (gameDirs[mod.id]) return gameDirs[mod.id];
  const steamDir = steam.findSteam();
  const game = steamDir ? steam.findApp(steamDir, mod.appid) : null;
  return game && fs.existsSync(path.join(game.dir, mod.exe)) ? game.dir : null;
}

// The known issues that apply to version v (SPEC section 5): since <= v
// (or no since) and v < fixedIn (or no fixedIn). v null: none apply.
function issuesFor(list, v) {
  if (!v) return [];
  return (list || []).filter((k) => (!k.since || compareVersions(k.since, v) <= 0) && (!k.fixedIn || compareVersions(v, k.fixedIn) < 0));
}

// ---------- the registry and indexes (engine/remote.js) ----------
// The last refresh(): remote.load()'s result, kept in memory. null until the
// first refresh; status() then shows only what's on this PC.
let remoteState = null;
let remoteAt = 0;
const REFRESH_MS = 60 * 1000;

// Fetches the registry and every game's index (signed; cached; never throws).
// opts.force: fetch even if the last refresh was under a minute ago.
// opts.trustedKeys: tests only. Returns { offline, newerInstaller, announcements, errors }.
async function refresh({ force = false, trustedKeys, timeoutMs } = {}) {
  if (force || !remoteState || Date.now() - remoteAt > REFRESH_MS) {
    remoteState = await remote.load({ trustedKeys, timeoutMs, allowUnsigned: pkg.allowUnsigned() });
    remoteAt = Date.now();
  }
  const { offline, newerInstaller, announcements, errors } = remoteState;
  return { offline, newerInstaller, announcements, errors };
}

// The registry's entry for a game (with its index, if it has one), or null.
const remoteGame = (id) => remoteState?.games.find((g) => g.id === id) || null;

// A game's index release for a version, or null.
const indexRelease = (g, version) => (g?.index?.releases || []).find((r) => r.version === version) || null;

// The maturity a version is shown with: a listed release's from its index
// (authoritative, SPEC section 3), when it's the same zip; else the zip's own.
function listedMaturity(mod, g = remoteGame(mod.id)) {
  const r = indexRelease(g, versionOf(mod));
  if (!r || mod.source === 'dev') return mod.maturity;
  if (mod.source === 'download' || (mod.zipSha256 && String(r.sha256).toUpperCase() === mod.zipSha256.toUpperCase())) return r.maturity;
  return mod.maturity;
}

// Every version of a mod on this PC, newest first:
// [{ version, maturity, source, active, installed, date, coreVersion,
//    testedBuildIds, knownIssues }]. installed: it's the version in the game's
// .dvr manifest (gameDirs as for status()). knownIssues: the index's list
// (newer) for a listed game, else that version's own, filtered to that version.
function versions(modId, { gameDirs = {} } = {}) {
  const cur = getMod(modId);
  const list = allVersions().get(cur.id) || [];
  const gameDir = findGameDir(cur, gameDirs);
  const manifest = gameDir ? readManifest(gameDir, cur) : null;
  const activeDirs = new Set(pickActive(cur.id, list).map((m) => m.dir));
  const g = remoteGame(cur.id);
  return [...list].sort(newestFirst).map((m) => ({
    version: versionOf(m),
    maturity: listedMaturity(m, g),
    source: m.source,
    active: activeDirs.has(m.dir),
    installed: !!manifest && manifest.version === versionOf(m) && installedSourceOf(manifest) === m.source,
    date: dateOf(m) || null,
    coreVersion: m.coreVersion || null,
    testedBuildIds: (m.testedBuildIds || []).map(String),
    knownIssues: issuesFor(g?.index?.knownIssues || m.knownIssues, versionOf(m)),
  }));
}

// A game manifest's source, in today's words: 0.2.0 builds before downloads
// wrote "bundled" (now dev) and "package" (a loaded file).
function installedSourceOf(manifest) {
  if (!manifest) return null;
  const s = manifest.source;
  if (SOURCES.includes(s)) return s;
  return s === 'package' ? 'file' : 'dev';
}

// Makes a version active. version null (or "dev") = the default (a dev build,
// else the newest package here). Otherwise a package version on this PC, or a
// release the game's index lists (it downloads on the next installRelease).
// Throws if it's neither.
function setActive(modId, version) {
  const id = modIdOf(modId);
  if (version == null || version === 'dev') { active.set(id, null); return; }
  const list = allVersions().get(id) || [];
  const here = list.some((m) => m.source !== 'dev' && versionOf(m) === version);
  if (!here && !indexRelease(remoteGame(id), version)) {
    throw new Error(`${nameOf(id)} ${version} isn't available. Load its file, or pick a listed version.`);
  }
  active.set(id, version);
}

// A mod id from an id or appid, whether or not it's on this PC.
function modIdOf(modId) {
  const local = loadMods().find((m) => m.id === modId || m.appid === Number(modId));
  if (local) return local.id;
  const g = remoteState?.games.find((x) => x.id === modId || x.appid === Number(modId));
  if (g) return g.id;
  throw new Error(`No mod "${modId}"`);
}
const nameOf = (id) => loadMods().find((m) => m.id === id)?.name || remoteGame(id)?.name || id;

// What a player is told when a mod file can't be used, by error code
// (dvr-package's SPEC section 9, plus the installer's own).
const NOT_SIGNED = "This file isn't signed by DioramaVR, so it can't be installed. Only use files from DioramaVR or its Patreon.";
const DAMAGED = 'This file is damaged or has been changed. Download it again.';
const PLAYER_MESSAGES = {
  'not-a-mod': "This isn't a DioramaVR mod file, or it's damaged. Download it again.",
  format: 'This mod needs a newer DioramaVR installer.',
  'app-version': (d) => `This mod needs DioramaVR ${d.minAppVersion || 'a newer version'} or newer. You have ${d.appVersion}.`,
  unsigned: NOT_SIGNED,
  signature: NOT_SIGNED,
  'untrusted-key': NOT_SIGNED,
  'unsafe-path': DAMAGED,
  'extra-file': DAMAGED,
  'missing-file': DAMAGED,
  hash: DAMAGED,
  'wrong-game': (d) => `This mod is for ${d.game || 'a game'}, which isn't installed in Steam on this PC.`,
  'no-file': (d) => `${d.file || 'That file'} isn't there any more.`,
  download: "Couldn't download the mod. Check your internet connection and try again.",
  'not-listed': (d) => `${d.name || 'This mod'} ${d.version || ''} isn't in the list of releases any more. Refresh and pick another version.`.replace(/ {2}/g, ' '),
  offline: "Couldn't reach DioramaVR's list of mods. Check your internet connection and try again.",
  unavailable: (d) => `Couldn't get the list of ${d.name || 'this mod'}'s releases just now. Try again later.`,
};

// An Error with the player's words as .message, the code as .code and the
// technical reason as .detail (for logs).
function playerError(code, detail, data = {}) {
  const m = PLAYER_MESSAGES[code];
  const e = new Error(typeof m === 'function' ? m({ appVersion: appVersion(), ...data }) : m || `Couldn't load the file: ${detail}`);
  e.code = code;
  e.detail = detail;
  return e;
}

// The installer's own refusals in a sideload check, with a SPEC code.
const refuse = (code, detail) => Object.assign(new Error(detail), { code });

// The installer's own check on an unpacked package, before it goes into the
// cache: a mod this installer can run, for the game its id belongs to.
// expect: { id, version } it must be (a download: what the index said).
function runnableCheck(expect = {}) {
  const dev = loadDev();
  return (dir, m) => {
    const mod = JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8'));
    for (const k of ['name', 'game', 'exe']) if (typeof mod[k] !== 'string' || !mod[k]) throw refuse('not-a-mod', `its mod.json has no ${k}`);
    if (!mod.plugin?.folder) throw refuse('not-a-mod', 'its mod.json has no plugin folder');
    try { loaders.get(mod.loader?.type); } catch (e) { throw refuse('format', e.message); }
    const known = dev.find((b) => b.id === m.id) || remoteGame(m.id);
    if (known && known.appid !== m.appid) throw refuse('not-a-mod', `it says ${m.id} is for appid ${m.appid}, but ${m.id} is for ${known.appid}`);
    if (expect.id && m.id !== expect.id) throw refuse('not-a-mod', `the index's ${expect.id} download is a package for ${m.id}`);
    if (expect.version && m.version !== expect.version) throw refuse('not-a-mod', `the index's ${expect.version} download is version ${m.version}`);
    if (!fs.existsSync(path.join(dir, mod.payload || 'payload'))) throw refuse('not-a-mod', 'it has no payload folder');
  };
}

// A refusal from unpacking, in the player's words.
function unpackError(e, zipPath, opts = {}) {
  if (!e.code || !PLAYER_MESSAGES[e.code]) return playerError(null, e.message);
  const data = {};
  if (e.code === 'app-version') {
    try { data.minAppVersion = JSON.parse(dvr.zip.readEntry(zipPath, 'dvr-package.json').toString('utf8')).minAppVersion; } catch { }
    if (opts.appVersion) data.appVersion = opts.appVersion;
  }
  return playerError(e.code, e.message, data);
}

// Loads a mod package zip the player chose (a closed-beta build from
// Patreon, say). dvr-package's reader checks it and unpacks it into the cache
// (pkg.unpack: format, minAppVersion, signature, every file); the installer
// then checks it can run it, and makes it the active version of its mod.
// The game needn't be installed yet: a tester may load before installing it
// (install refuses with wrong-game until it is). opts.trustedKeys and
// opts.appVersion: tests only.
// Returns { id, version, maturity, name, game, appid, gameInstalled, message }.
// Throws a playerError (see PLAYER_MESSAGES).
function sideload(zipPath, opts = {}) {
  if (!zipPath || !fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) {
    throw playerError('no-file', `no file at ${zipPath}`, { file: zipPath ? path.basename(zipPath) : null });
  }
  let res;
  try {
    res = pkg.unpack(zipPath, { trustedKeys: opts.trustedKeys, appVersion: opts.appVersion, check: runnableCheck() });
  } catch (e) {
    throw unpackError(e, zipPath, opts);
  }
  // A file; its SHA-256 says whether it's a listed release (then the index's maturity shows).
  pkg.setOrigin(res.id, res.version, { source: 'file', sha256: pkg.sha256File(zipPath) });
  active.set(res.id, res.version);
  const mod = getMod(res.id);
  const gameInstalled = !!findGameDir(mod);
  // A listed release (the same zip) shows the index's maturity: promotion never
  // rebuilds, so a public open beta's own manifest still says closed-beta.
  const maturity = listedMaturity(mod) || res.maturity;
  const label = maturityLabel(maturity);
  return {
    id: res.id, version: res.version, maturity, name: mod.name, game: mod.game, appid: mod.appid, gameInstalled,
    message: `Loaded ${mod.name} ${res.version}${label ? ` (${label})` : ''}.${gameInstalled ? '' : ` Install ${mod.game} in Steam to use it.`}`,
  };
}

const manifestPath = (gameDir, mod) => path.join(gameDir, MANIFEST_DIR, `${mod.id}.json`);

function readManifest(gameDir, mod) {
  try { return JSON.parse(fs.readFileSync(manifestPath(gameDir, mod), 'utf8')); } catch { return null; }
}

// One entry per game: every mod on this PC (its active version) and every
// game the registry lists (from the last refresh()), owned or not.
// gameDirs lets a caller (tests, a "browse for folder" fallback) say where a
// game is instead of asking Steam. Each entry:
//   id, name, game, appid, description, owned, gameDir, buildid,
//   installed, installedVersion, installedMaturity, installedSource,
//   source ('download' | 'file' | 'dev' | null: the active version's),
//   wave ({id, name} | null), status ('stable' | 'open-beta' | 'coming' | null
//   for a mod the registry doesn't list), closedBeta,
//   active ({version, maturity, coreVersion, pending?} | null; pending: chosen
//   with backToPublic and not downloaded yet), releases (usable, newest first:
//   {version, maturity, date, coreVersion, size, tested, notes}),
//   recommended ({version, maturity} | null), updateAvailable ({version,
//   maturity} | null: newer than what's installed; for a file install it's the
//   newer public version on offer, never applied by itself), optInBeta,
//   buildTested, testedBuildIds, knownIssues ([{id, title, text, severity}] for
//   the installed version, else the active, else the recommended one),
//   and as before: version, maturity, maturityLabel, coreVersion, versionCount,
//   tutorial, needToKnow, firstLaunch, storeUrl, installedOptions,
//   steamShortcut, payloadReady, art, options, video.
function status({ gameDirs = {} } = {}) {
  const steamDir = steam.findSteam();
  const local = new Map(loadMods().map((m) => [m.id, m]));
  const ids = [...new Set([...local.keys(), ...(remoteState?.games || []).map((g) => g.id)])];
  return ids.map((id) => {
    const mod = local.get(id) || null;
    const g = remoteGame(id);
    const appid = mod?.appid ?? g?.appid;
    let game = null;
    if (gameDirs[id]) game = { dir: gameDirs[id], buildid: null, manual: true };
    else if (steamDir) game = steam.findApp(steamDir, appid);
    if (game && mod && !fs.existsSync(path.join(game.dir, mod.exe))) game = null;
    const manifest = game ? readManifest(game.dir, { id }) : null;
    const optInBeta = remote.betaOptIn(id);
    const index = g?.index || null;
    const buildid = game?.buildid || null;
    const rec = index ? remote.pickRelease(index, { optInBeta, buildid }) : null;
    const recommended = rec ? { version: rec.version, maturity: rec.maturity } : null;

    // The active version: one on this PC, or a listed one chosen but not downloaded yet.
    const chosen = active.get(id);
    const pendingRelease = chosen && (!mod || versionOf(mod) !== chosen) ? indexRelease(g, chosen) : null;
    const act = pendingRelease
      ? { version: pendingRelease.version, maturity: pendingRelease.maturity, coreVersion: pendingRelease.coreVersion || null, pending: true }
      : mod ? { version: versionOf(mod), maturity: listedMaturity(mod, g) || null, coreVersion: mod.coreVersion || null } : null;
    const source = pendingRelease ? 'download' : mod?.source || null;

    const installedVersion = manifest?.version || null;
    const installedSource = installedSourceOf(manifest);
    const installedRelease = installedSource === 'download' ? indexRelease(g, installedVersion) : null;
    const installedMaturity = manifest ? (installedRelease?.maturity || manifest.maturity || null) : null;
    // An update: among the usable releases newer than what's installed, one
    // tested on this build if there is one, else the newest.
    const usable = index ? remote.usableReleases(index, { optInBeta }) : [];
    const newer = manifest && installedVersion ? usable.filter((r) => compareVersions(r.version, installedVersion) > 0) : [];
    const upd = newer.find((r) => remote.isTested(r, buildid)) || newer[0] || null;
    const updateAvailable = upd ? { version: upd.version, maturity: upd.maturity } : null;

    // The game-update warning: the active version's tested builds (a package's from its signed manifest).
    const tested = ((pendingRelease || !mod) ? (pendingRelease || rec)?.testedBuildIds : mod.testedBuildIds) || [];
    const testedIds = tested.map(String);
    const issuesVersion = installedVersion || act?.version || rec?.version || null;
    const issues = issuesFor(index?.knownIssues || mod?.knownIssues || [], issuesVersion)
      .map((k) => ({ id: k.id, title: k.title, text: k.text, severity: k.severity }));
    const wave = g?.wave ? (remoteState.waves || []).find((w) => w.id === g.wave) : null;
    return {
      id,
      name: mod?.name || g?.name || id,
      game: mod?.game || g?.game || '',
      appid,
      description: index?.description || null,
      tutorial: mod?.tutorial || null,
      needToKnow: mod?.needToKnow || [],
      firstLaunch: mod?.firstLaunch || null,
      storeUrl: `https://store.steampowered.com/app/${appid}/`,
      owned: !!game,
      gameDir: game?.dir || null,
      buildid,
      // Unknown build (manual folder) counts as untested only if we know one.
      buildTested: !buildid || testedIds.length === 0 || testedIds.includes(String(buildid)),
      testedBuildIds: testedIds,
      installed: !!manifest,
      installedVersion,
      installedMaturity,
      installedSource,
      installedOptions: manifest?.options || null,
      steamShortcut: manifest?.steamShortcut || null,
      source,
      wave: wave ? { id: wave.id, name: wave.name } : null,
      status: g?.status || null,
      closedBeta: g?.closedBeta === true,
      // Listed, but its index didn't load or verify and there's no good cached
      // copy: shown, with no releases, until a refresh gets it.
      unavailable: g?.unavailable === true,
      active: act,
      releases: usable.map((r) => ({
        version: r.version, maturity: r.maturity, date: r.date || null, coreVersion: r.coreVersion || null,
        size: r.size, tested: remote.isTested(r, buildid), notes: r.notes || null,
      })),
      recommended,
      updateAvailable,
      optInBeta,
      knownIssues: issues,
      // The version known issues are shown for (gameData filters the zip's by it too).
      issuesVersion,
      // From the game's data zip, when it's already cached for the index's hash
      // (the gallery card); the page fetches it with gameData().
      line: gamedata.cached(id, index)?.line || null,
      hover: (gamedata.cached(id, index)?.media || []).find((m) => m.role === 'hover' && m.kind === 'video') || null,
      payloadReady: !!mod && fs.existsSync(mod.payloadDir),
      version: act?.version || null,
      maturity: act?.maturity || null,
      maturityLabel: maturityLabel(act?.maturity),
      coreVersion: act?.coreVersion || null,
      versionCount: mod?.versionCount || 0,
      art: steamDir && appid ? steam.art(steamDir, appid) : {},
      options: mod ? options.forMod(mod) : [],
      video: mod?.video ? path.join(mod.dir, mod.video) : null,
    };
  }).sort((a, b) => a.game.localeCompare(b.game));
}

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out;
}

function assertNotRunning(mod) {
  if (process.env.DVR_SKIP_PROCESS_CHECK) return;
  if (steam.processRunning(path.basename(mod.exe))) throw new Error(`${mod.game} is running. Close it first.`);
}

const under = (rel, root) => rel.toLowerCase() === root.toLowerCase() || rel.toLowerCase().startsWith(root.toLowerCase() + '/');

// Copies the mod into gameDir. onProgress({ step, done, total, file }).
async function install({ modId, gameDir, chosen = {}, onProgress = () => {} }) {
  const mod = getMod(modId);
  const loader = loaders.get(mod.loader.type);
  if (!fs.existsSync(path.join(gameDir, mod.exe))) {
    // A loaded zip may be for a game this PC doesn't have (sideload allows
    // that, so a tester can load first); say so in the player's words.
    if (mod.source !== 'dev') throw playerError('wrong-game', `${mod.exe} isn't in ${gameDir}`, { game: mod.game });
    throw new Error(`${mod.exe} isn't in ${gameDir}`);
  }
  if (!fs.existsSync(mod.payloadDir)) throw new Error(`The ${mod.name} files aren't in this build (${mod.payloadDir}). Run "npm run build-mods".`);
  assertNotRunning(mod);

  const previous = readManifest(gameDir, mod);
  // A loader that was here before our first install isn't ours to replace.
  const loaderPreexisting = previous ? previous.loaderPreexisting : loader.installed(gameDir, mod);
  const dest = (rel) => loader.dest(mod, gameDir, rel);
  // Fetched before anything is copied, so a failed download changes nothing.
  const extra = await loader.extraFiles(mod, onProgress);
  const { values, cfg: cfgValues } = options.resolve(mod, chosen);
  const backupDir = path.join(gameDir, MANIFEST_DIR, mod.id, 'backup');

  const manifest = {
    mod: mod.id,
    version: mod.build?.version || null,
    source: mod.source || 'dev',
    maturity: listedMaturity(mod) || null,
    installedAt: new Date().toISOString(),
    loader: mod.loader,
    // What uninstall needs, so it works whichever version is active later,
    // or with this version's package gone from the cache.
    modInfo: modInfo(mod),
    loaderPreexisting,
    files: [],
    backups: previous?.backups || [],
    createdSteamAppId: previous?.createdSteamAppId || false,
    options: values,
    steamShortcut: previous?.steamShortcut || null,
    desktopShortcut: previous?.desktopShortcut || null,
  };
  const ownedBefore = new Set((previous?.files || []).map((f) => f.toLowerCase()));

  const files = [
    ...walk(mod.payloadDir).map((rel) => ({ rel, src: path.join(mod.payloadDir, rel) })),
    ...extra,
  ];
  const total = files.length;
  let done = 0;
  for (const { rel, src } of files) {
    const isLoaderFile = !under(rel, mod.plugin.folder) && loader.roots.some((r) => under(rel, r));
    const dst = dest(rel);
    const exists = fs.existsSync(dst);
    if (isLoaderFile && loaderPreexisting) {
      // Keep the BepInEx that was already here as it is (other mods rely on
      // it); mixing in files from another build would break it.
    } else {
      if (exists && !ownedBefore.has(rel.toLowerCase()) && !manifest.backups.includes(rel)) {
        fs.mkdirSync(path.dirname(path.join(backupDir, rel)), { recursive: true });
        fs.copyFileSync(dst, path.join(backupDir, rel));
        manifest.backups.push(rel);
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      await fs.promises.copyFile(src, dst);
      manifest.files.push(rel);
    }
    done++;
    if (done % 25 === 0 || done === total) onProgress({ step: 'copy', done, total, file: rel });
  }

  onProgress({ step: 'config', done: total, total });
  // Loader settings the mod depends on (e.g. console off), also on a BepInEx
  // that was already here; its original config is backed up first.
  if (mod.loaderConfig) {
    const rel = loader.loaderConfig;
    const file = dest(rel);
    if (fs.existsSync(file) && loaderPreexisting && !manifest.backups.includes(rel)) {
      fs.mkdirSync(path.dirname(path.join(backupDir, rel)), { recursive: true });
      fs.copyFileSync(file, path.join(backupDir, rel));
      manifest.backups.push(rel);
    }
    if (!fs.existsSync(file) && !manifest.files.includes(rel)) manifest.files.push(rel);
    loader.writeConfig(file, mod.loaderConfig);
  }
  if (mod.plugin.config) {
    cfg.writeFile(dest(mod.plugin.config), cfgValues);
    if (!manifest.files.includes(mod.plugin.config)) manifest.files.push(mod.plugin.config);
  }

  // Lets the exe start directly (keeping the VR launch args) instead of
  // relaunching itself through Steam without them.
  if (mod.steamAppIdFile) {
    const file = path.join(gameDir, 'steam_appid.txt');
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, String(mod.appid));
      manifest.createdSteamAppId = true;
    }
  }

  // A reinstall, maybe of another version: what the last install put here and
  // this one doesn't ship goes, and whatever it had replaced comes back.
  if (previous) {
    const prevMod = previous.modInfo ? { ...mod, ...previous.modInfo } : mod;
    const prevDest = (rel) => loader.dest(prevMod, gameDir, rel);
    const now = new Set(manifest.files.map((f) => f.toLowerCase()));
    const stale = (previous.files || []).filter((f) => !now.has(f.toLowerCase()));
    for (const rel of stale) {
      fs.rmSync(prevDest(rel), { force: true });
      const i = manifest.backups.indexOf(rel);
      const saved = path.join(backupDir, rel);
      if (i >= 0 && fs.existsSync(saved)) {
        fs.mkdirSync(path.dirname(prevDest(rel)), { recursive: true });
        fs.copyFileSync(saved, prevDest(rel));
        fs.rmSync(saved, { force: true });
        manifest.backups.splice(i, 1);
      }
    }
    pruneEmptyDirs(prevDest, stale);
  }

  writeManifest(gameDir, mod, manifest);
  onProgress({ step: 'done', done: total, total });
  return manifest;
}

// The parts of mod.json that install and uninstall use, kept in the game's
// .dvr manifest.
function modInfo(mod) {
  const keep = ['id', 'name', 'game', 'appid', 'exe', 'loader', 'plugin', 'uevr', 'launchArgs'];
  return JSON.parse(JSON.stringify(Object.fromEntries(keep.map((k) => [k, mod[k]]))));
}

// The mod as it was installed in gameDir: the active version's mod.json with
// the installed version's modInfo on top. Works with no version available at
// all (its package deleted, no dev build), from the manifest alone.
function installedMod(modId, gameDir) {
  let mod = null;
  try { mod = getMod(modId); } catch { }
  const manifest = readManifest(gameDir, { id: mod?.id || String(modId) });
  if (manifest?.modInfo) mod = { ...(mod || {}), ...manifest.modInfo };
  if (!mod) throw new Error(`No mod "${modId}" here, and it isn't installed in ${gameDir}`);
  return { mod, manifest };
}

function writeManifest(gameDir, mod, manifest) {
  fs.mkdirSync(path.join(gameDir, MANIFEST_DIR), { recursive: true });
  fs.writeFileSync(manifestPath(gameDir, mod), JSON.stringify(manifest, null, 2));
}

function pruneEmptyDirs(dest, rels) {
  const dirs = new Set();
  for (const rel of rels) {
    let d = path.posix.dirname(rel);
    while (d && d !== '.') { dirs.add(d); d = path.posix.dirname(d); }
  }
  [...dirs].sort((a, b) => b.length - a.length).forEach((d) => {
    try { fs.rmdirSync(dest(d)); } catch { /* not empty */ }
  });
}

// Removes the mod. Saves live outside the game folder and are never touched.
// Steam/desktop shortcuts are removed separately (Steam has to be closed).
// Works whichever version is active: the game's manifest says what's there.
function uninstall({ modId, gameDir }) {
  const { mod, manifest } = installedMod(modId, gameDir);
  const loader = loaders.get(mod.loader.type);
  assertNotRunning(mod);
  if (!manifest) throw new Error(`${mod.name} isn't installed in ${gameDir} (no ${MANIFEST_DIR}/${mod.id}.json).`);

  const others = loader.otherPlugins(gameDir, mod.plugin.folder, mod);
  const keepLoader = manifest.loaderPreexisting || others.length > 0;
  const backupDir = path.join(gameDir, MANIFEST_DIR, mod.id, 'backup');
  const dest = (rel) => loader.dest(mod, gameDir, rel);
  const removed = [];

  if (keepLoader) {
    fs.rmSync(dest(mod.plugin.folder), { recursive: true, force: true });
    removed.push(mod.plugin.folder);
    for (const rel of manifest.files) {
      if (loader.roots.some((r) => under(rel, r)) && !under(rel, mod.plugin.folder) && rel !== mod.plugin.config) continue;
      fs.rmSync(dest(rel), { force: true });
    }
    if (mod.plugin.config) fs.rmSync(dest(mod.plugin.config), { force: true });
  } else {
    // Nothing else uses the loader: take it out whole, including what it
    // generated on first launch (BepInEx's interop, cache and logs; UEVR's
    // profile config and logs).
    for (const root of loader.removeRoots(mod)) {
      const p = dest(root);
      if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removed.push(root); }
    }
    for (const rel of manifest.files) fs.rmSync(dest(rel), { force: true });
  }

  // Put back whatever we overwrote, unless it lived in a loader we removed.
  const restored = [];
  for (const rel of manifest.backups) {
    const src = path.join(backupDir, rel);
    const inRemovedLoader = !keepLoader && loader.removeRoots(mod).some((r) => under(rel, r));
    if (!fs.existsSync(src) || inRemovedLoader) continue;
    fs.mkdirSync(path.dirname(dest(rel)), { recursive: true });
    fs.copyFileSync(src, dest(rel));
    restored.push(rel);
  }

  if (manifest.createdSteamAppId) fs.rmSync(path.join(gameDir, 'steam_appid.txt'), { force: true });
  if (manifest.desktopShortcut) fs.rmSync(manifest.desktopShortcut, { force: true });

  pruneEmptyDirs(dest, manifest.files);
  fs.rmSync(path.join(gameDir, MANIFEST_DIR, mod.id), { recursive: true, force: true });
  fs.rmSync(manifestPath(gameDir, mod), { force: true });
  try { fs.rmdirSync(path.join(gameDir, MANIFEST_DIR)); } catch { }

  return { keptLoader: keepLoader, otherPlugins: others, removed, restored, steamShortcut: manifest.steamShortcut };
}

// ---------- downloads ----------
// The listed release to fetch for a game: version (any listed one this app
// can install), else the recommended one. Needs a refresh() first.
function releaseFor(id, version) {
  const g = remoteGame(id);
  if (!g?.index) {
    if (!remoteState || remoteState.offline) throw playerError('offline', `no index for ${id} (offline: ${!!remoteState?.offline})`);
    if (g?.unavailable) throw playerError('unavailable', `${id}'s index: ${g.error}`, { name: g.name });
    throw playerError('not-listed', `the registry has no index for ${id}`, { name: g?.name || id });
  }
  const optInBeta = remote.betaOptIn(id);
  const r = version
    ? remote.usableReleases(g.index, { optInBeta: true }).find((x) => x.version === version)
    : remote.pickRelease(g.index, { optInBeta, buildid: steamBuildid(g.appid) });
  if (!r) throw playerError('not-listed', `no usable release ${version || '(recommended)'} for ${id}`, { name: g.name, version });
  return { g, release: r };
}

const steamBuildid = (appid) => {
  const steamDir = steam.findSteam();
  return (steamDir && steam.findApp(steamDir, appid)?.buildid) || null;
};

// Downloads a listed release (unless it's already here, from a download of
// the same zip), checks it, unpacks it into the cache and makes it the active
// version. Doesn't touch the game: installRelease does that next, and the
// app can call this first to show the mod's own options before installing.
// onProgress: { step: 'download', done, total } then { step: 'verify' }.
// opts.trustedKeys: tests only. Returns { id, version, maturity }.
async function fetchRelease({ modId, version, onProgress = () => {}, trustedKeys } = {}) {
  if (!remoteState) await refresh({ trustedKeys });
  const id = modIdOf(modId);
  const { release } = releaseFor(id, version);
  const have = pkg.origin(id, release.version);
  const here = loadPackages().some((m) => m.id === id && versionOf(m) === release.version);
  if (!(here && have?.source === 'download' && String(have.sha256).toUpperCase() === String(release.sha256).toUpperCase())) {
    let file;
    try {
      file = await download.download(release, { onProgress });
    } catch (e) {
      throw playerError(e.code === 'hash' ? 'hash' : 'download', e.message);
    }
    try {
      onProgress({ step: 'verify' });
      try {
        pkg.unpack(file, { trustedKeys, check: runnableCheck({ id, version: release.version }) });
      } catch (e) {
        throw unpackError(e, file);
      }
      pkg.setOrigin(id, release.version, { source: 'download', sha256: String(release.sha256).toUpperCase() });
    } finally {
      download.cleanup(file); // the zip itself isn't kept, only the unpacked package
    }
  } else {
    onProgress({ step: 'verify' });
  }
  active.set(id, release.version);
  return { id, version: release.version, maturity: release.maturity };
}

// Downloads (if needed), checks and unpacks a listed release, makes it active,
// and installs it into gameDir: the same install as ever (steps copy, config,
// done), over whatever version is there (a reinstall). version: default the
// recommended one. Errors carry the player's words, as sideload's do.
// Afterwards, downloaded versions that are neither active nor installed are
// removed from the cache. Returns install's manifest.
async function installRelease({ modId, version, gameDir, chosen = {}, onProgress = () => {}, trustedKeys } = {}) {
  const got = await fetchRelease({ modId, version, onProgress, trustedKeys });
  const m = await install({ modId: got.id, gameDir, chosen, onProgress });
  pruneDownloads(got.id, gameDir);
  return m;
}

// Downloaded packages of a mod that nothing uses (not active, not installed in
// gameDir) are removed; files the player loaded are kept (there's no
// download to get them back from).
function pruneDownloads(id, gameDir) {
  const keep = new Set([active.get(id), gameDir ? readManifest(gameDir, { id })?.version : null].filter(Boolean));
  for (const m of loadPackages()) {
    if (m.id === id && m.source === 'download' && !keep.has(versionOf(m))) pkg.removeUnpacked(id, versionOf(m));
  }
}

// Back to the public release after a file (closed beta): the recommended
// release becomes the active version. It downloads on the next installRelease
// (or fetchRelease) if it isn't here. Returns { version, maturity }.
function backToPublic(modId) {
  const id = modIdOf(modId);
  const { release } = releaseFor(id);
  active.set(id, release.version);
  return { version: release.version, maturity: release.maturity };
}

// Per game: include open betas in the releases offered (settings.json).
function setBetaOptIn(modId, on) {
  remote.setBetaOptIn(modIdOf(modId), !!on);
}

// An announcement the player closed stays closed.
function dismissAnnouncement(id) {
  remote.dismissAnnouncement(id);
  if (remoteState) remoteState.announcements = remoteState.announcements.filter((a) => a.id !== String(id));
}

const vrName = (mod) => `${mod.game} (VR)`;

// How to start the game in VR: { exe, argv, args (one string), cwd, icon }.
// BepInEx mods start the game exe itself; UEVR mods run their launcher.
function launchCommand(mod, gameDir) {
  if (typeof mod === 'string') mod = getMod(mod);
  return loaders.get(mod.loader.type).launch(mod, gameDir);
}

// Needs Steam closed: the caller checks steam.steamRunning() / closeSteam().
function addSteamEntry({ modId, gameDir, accountId }) {
  const mod = getMod(modId);
  const steamDir = steam.findSteam();
  if (!steamDir) throw new Error('Steam not found');
  if (!process.env.DVR_SKIP_PROCESS_CHECK && steam.steamRunning()) throw new Error('Steam is running; close it first');
  if (!steam.accounts(steamDir).some((a) => a.id === accountId)) throw new Error(`No Steam account folder ${accountId}`);
  const l = launchCommand(mod, gameDir);
  const res = shortcuts.addSteamShortcut({
    steamDir, accountId, name: vrName(mod), exe: l.exe, startDir: l.cwd,
    launchArgs: l.args, icon: l.icon, art: steam.art(steamDir, mod.appid),
  });
  const manifest = readManifest(gameDir, mod);
  if (manifest) {
    manifest.steamShortcut = { accountId, appid: res.appid, name: vrName(mod) };
    writeManifest(gameDir, mod, manifest);
  }
  return res;
}

function removeSteamEntry({ modId, accountId, appid }) {
  const mod = getMod(modId);
  const steamDir = steam.findSteam();
  if (!steamDir) throw new Error('Steam not found');
  if (!process.env.DVR_SKIP_PROCESS_CHECK && steam.steamRunning()) throw new Error('Steam is running; close it first');
  return shortcuts.removeSteamShortcut({ steamDir, accountId, name: vrName(mod), appid });
}

function addDesktopEntry({ modId, gameDir }) {
  const mod = getMod(modId);
  const l = launchCommand(mod, gameDir);
  const lnk = shortcuts.addDesktopShortcut({
    lnkPath: path.join(shortcuts.desktopDir(), `${vrName(mod)}.lnk`),
    exe: l.exe, args: l.args, workDir: l.cwd, icon: l.icon,
    description: `${mod.game} in VR (start SteamVR first)`,
  });
  const manifest = readManifest(gameDir, mod);
  if (manifest) { manifest.desktopShortcut = lnk; writeManifest(gameDir, mod, manifest); }
  return lnk;
}

// ---------- a game's data zip (engine/gamedata.js) ----------
// The page's text and media: line, firstLaunch, needToKnow, tutorial (title and
// text), knownIssues (the zip's, for the version shown; null: use the index's)
// and media (paths inside the zip, served by gameDataFile). Fetched once per
// index hash and cached; null when there's none or it couldn't be had.
async function gameData(modId, opts = {}) {
  const id = modIdOf(modId);
  const g = remoteGame(id);
  if (!g?.index) return null;
  const data = await gamedata.get(id, g.index, opts);
  if (!data) return null;
  const s = status().find((x) => x.id === id);
  const v = s?.issuesVersion || null;
  return {
    ...data,
    knownIssues: data.knownIssues ? issuesFor(data.knownIssues, v).map((k) => ({ id: k.id, title: k.title, text: k.text, severity: k.severity })) : null,
  };
}
// The full path of one of a game's cached data media files (for the app's art: URLs), or null.
const gameDataFile = (modId, name) => gamedata.mediaFile(modIdOf(modId), remoteGame(modIdOf(modId))?.index, name);

module.exports = {
  vr,
  steam, shortcuts, options, cfg, preflight,
  modsDir, loadMods, getMod, status, readManifest,
  sideload, versions, setActive, maturityLabel, issuesFor, PLAYER_MESSAGES,
  refresh, gameData, gameDataFile, gamedata, fetchRelease, installRelease, backToPublic, setBetaOptIn, dismissAnnouncement, remote, SOURCES,
  install, uninstall, addSteamEntry, removeSteamEntry, addDesktopEntry, vrName, launchCommand,
};
