// Downloadable mods: the registry (every game, its wave and status, where its
// index is) and each game's index.json (its public releases). The formats are
// dvr-package's docs/SPEC.md sections 5 and 6. Plain static files, never the
// GitHub API; nothing about the player or their Steam accounts is sent.
//
// Every file is signed. A registry or index is used, and cached, only after its
// .sig verifies against dvr-package's trusted keys; a bad or missing signature
// counts as a failed fetch, so the last good copy is used instead. Cached copies
// are kept with their signatures and verified again when read.
//
// load() never throws: offline, it falls back to the cache, and with no cache
// it returns no games, so the bundled mods (mods/<id>/) are never blocked.
// Downloading a release is engine/download.js; unpacking is dvr-package's reader.
const fs = require('fs');
const path = require('path');
const { sign, schemas } = require('dvr-package');
const { cacheRoot } = require('./uevr');
const { appVersion, compareVersions } = require('./version');

// Built into the exe: it can never change. DVR_REGISTRY_URL overrides it (tests,
// staging); a verified registry's movedTo replaces it (remembered).
const REGISTRY_URL = 'https://dioramavr.app/registry.json';

const FORMAT = 1; // the newest registry/index format this app understands
const TIMEOUT_MS = 4000;
const MAX_BYTES = 2 * 1024 * 1024; // a registry or index is a few KB
const LISTED = ['open-beta', 'stable'];
// Before maturity, index entries had a channel (MOD-DOWNLOADS.md, switch-over).
const LEGACY_CHANNEL = { stable: 'stable', beta: 'open-beta' };

// https anywhere; plain http only to this PC (tests, staging): SPEC section 2.
function okUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  } catch {
    return false;
  }
}

// ---------- settings: <cacheRoot>/settings.json ----------
// { betas: { <game id>: true }, registryUrl: <remembered movedTo>, dismissed: [<announcement id>] }
const settingsFile = () => path.join(cacheRoot(), 'settings.json');
function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}
function writeSettings(change) {
  const s = { ...readSettings(), ...change };
  writeFileAtomic(settingsFile(), JSON.stringify(s, null, 2) + '\n');
  return s;
}
function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Betas are opt-in, per game.
const betaOptIn = (id) => readSettings().betas?.[id] === true;
function setBetaOptIn(id, on) {
  const betas = { ...readSettings().betas };
  if (on) betas[id] = true;
  else delete betas[id];
  writeSettings({ betas });
}

// Announcements are shown once: dismissed ids are remembered.
function dismissAnnouncement(id) {
  const dismissed = new Set(readSettings().dismissed || []);
  dismissed.add(String(id));
  writeSettings({ dismissed: [...dismissed] });
}

// Where the registry is read from: DVR_REGISTRY_URL, else a remembered
// movedTo, else the built-in address.
function registryUrl() {
  if (process.env.DVR_REGISTRY_URL) return process.env.DVR_REGISTRY_URL;
  const moved = readSettings().registryUrl;
  return typeof moved === 'string' && okUrl(moved) ? moved : REGISTRY_URL;
}

// ---------- checking a document ----------
// Old spellings still accepted on the way in: an index release's channel
// (stable/beta) and the registry's sets/set. Returns a copy.
function normalise(doc, kind) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  const d = JSON.parse(JSON.stringify(doc));
  if (kind === 'index' && Array.isArray(d.releases)) {
    d.releases = d.releases.map((r) => {
      if (!r || typeof r !== 'object' || r.maturity !== undefined || !(r.channel in LEGACY_CHANNEL)) return r;
      const { channel, ...rest } = r;
      return { ...rest, maturity: LEGACY_CHANNEL[channel] };
    });
  }
  if (kind === 'registry') {
    if (d.waves === undefined && Array.isArray(d.sets)) { d.waves = d.sets; delete d.sets; }
    for (const g of Array.isArray(d.games) ? d.games : []) if (g && g.wave === undefined && g.set !== undefined) { g.wave = g.set; delete g.set; }
  }
  return d;
}

// null if fine; 'newer-format'; or what's wrong. The format is checked first,
// so a newer format is reported as such rather than as a bad shape.
function problem(doc, kind, expect = {}) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'not an object';
  if (!Number.isInteger(doc.format) || doc.format < 1) return 'no format number';
  if (doc.format > FORMAT) return 'newer-format';
  // An index's media list (assets) that's malformed doesn't cost the game its
  // releases: engine/assets.js checks it again (dvr-package's strict check)
  // and then ignores it, so the page falls back as if there were none.
  const bad = schemas.validate(doc, kind).filter((p) => !(kind === 'index' && /^\/assets(\/|$)/.test(p.path || '')));
  if (bad.length) return `${bad[0].path}: ${bad[0].message}${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''}`;
  if (kind === 'registry') {
    const ids = new Set();
    for (const g of doc.games) {
      if (ids.has(g.id)) return `game ${g.id} is listed twice`;
      ids.add(g.id);
    }
  }
  if (kind === 'index') {
    if (expect.id && doc.id !== expect.id) return `index is for "${doc.id}", not "${expect.id}"`;
    if (expect.appid && doc.appid !== expect.appid) return `index appid ${doc.appid} isn't the registry's ${expect.appid}`;
    const seen = new Set();
    for (const r of doc.releases) {
      if (seen.has(r.version)) return `release ${r.version} is listed twice`;
      seen.add(r.version);
    }
  }
  return null;
}

// Signature check: { ok } or { ok: false, error }. A missing .sig is only
// accepted with allowUnsigned (a dev build talking to a local test server).
function checkSig(bytes, sigText, { trustedKeys, allowUnsigned }) {
  if (sigText == null) return allowUnsigned ? { ok: true, unsigned: true } : { ok: false, error: 'unsigned: no .sig file' };
  const r = sign.check(bytes, sigText, trustedKeys);
  return r.ok ? { ok: true, key: r.key } : { ok: false, error: `${r.code}: ${r.message}` };
}

// ---------- fetching ----------
// fetch that follows redirects itself, checking every address before it's
// fetched: a redirect may not leave https (or this PC) behind. Returns the
// final response (its .url may be empty: use the returned url).
async function fetchSafe(url, init = {}, maxHops = 5) {
  for (let hop = 0; ; hop++) {
    if (!okUrl(url)) throw new Error(hop ? `redirected to an insecure URL (${safeHost(url)})` : `not an https URL: ${url}`);
    const res = await fetch(url, { ...init, redirect: 'manual' });
    const to = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!to) return { res, url };
    await res.body?.cancel().catch(() => {});
    if (hop >= maxHops) throw new Error('too many redirects');
    url = new URL(to, url).href;
  }
}
const safeHost = (u) => { try { return new URL(u).host; } catch { return 'a bad address'; } };

async function fetchBytes(url, timeoutMs, { optional = false } = {}) {
  const { res } = await fetchSafe(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (optional && res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  const len = Number(res.headers.get('content-length'));
  if (len > MAX_BYTES) throw new Error(`too large (${len} bytes)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`too large (${buf.length} bytes)`);
  return buf;
}

// Last good copies, with their signatures: cache/registry.json(.sig) and
// cache/index/<id>.json(.sig), byte for byte as served.
const cacheFile = (id) => (id ? path.join(cacheRoot(), 'index', `${id}.json`) : path.join(cacheRoot(), 'registry.json'));
function readCache(id) {
  try {
    const bytes = fs.readFileSync(cacheFile(id));
    const sigFile = `${cacheFile(id)}.sig`;
    return { bytes, sig: fs.existsSync(sigFile) ? fs.readFileSync(sigFile, 'utf8') : null };
  } catch {
    return null;
  }
}
function writeCache(id, bytes, sig) {
  try {
    if (sig == null) return; // unsigned (dev) copies are never cached
    writeFileAtomic(cacheFile(id), bytes);
    writeFileAtomic(`${cacheFile(id)}.sig`, sig);
  } catch {
    // A cache we can't write only costs the offline fallback.
  }
}

// bytes + signature -> { doc } or { error, newerFormat }.
function accept(bytes, sigText, kind, expect, opts) {
  const s = checkSig(bytes, sigText, opts);
  if (!s.ok) return { error: s.error };
  let doc;
  try { doc = normalise(JSON.parse(bytes.toString('utf8')), kind); } catch { return { error: 'not JSON' }; }
  const bad = problem(doc, kind, expect);
  if (bad === 'newer-format') return { error: `format ${doc.format} is newer than this app knows`, newerFormat: true };
  if (bad) return { error: bad };
  return { doc };
}

// One signed document: from the network, else the last good copy. Returns
// { doc, from: 'network'|'cache'|null, error, newerFormat }.
async function getDoc(url, id, kind, expect, opts) {
  let error = null;
  let newerFormat = false;
  try {
    const bytes = await fetchBytes(url, opts.timeoutMs);
    const sig = (await fetchBytes(`${url}.sig`, opts.timeoutMs, { optional: true }))?.toString('utf8') ?? null;
    const r = accept(bytes, sig, kind, expect, opts);
    if (r.doc) {
      writeCache(id, bytes, sig);
      return { doc: r.doc, from: 'network', error: null, newerFormat: false };
    }
    error = r.error;
    newerFormat = !!r.newerFormat;
  } catch (e) {
    error = e.name === 'TimeoutError' ? 'timed out' : e.message;
  }
  const cached = readCache(id);
  if (cached) {
    const r = accept(cached.bytes, cached.sig, kind, expect, { ...opts, allowUnsigned: false });
    if (r.doc) return { doc: r.doc, from: 'cache', error, newerFormat };
  }
  return { doc: null, from: null, error, newerFormat };
}

// ---------- announcements ----------
// "<0.3.0", "<=1", ">2.0", ">=0.2.0", "=0.2.0" against the app's version.
function versionMatches(spec, version) {
  if (spec == null) return true;
  const m = /^(<=|>=|<|>|=)(\d+(?:\.\d+)*)$/.exec(String(spec).trim());
  if (!m) return false; // a form this app doesn't know: don't show it
  const c = compareVersions(version, m[2]);
  return { '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0, '=': c === 0 }[m[1]];
}

// The announcements to show now: inside their date window (UTC, both ends
// inclusive), for this app's version, not dismissed. Plain text; a link only if https.
function activeAnnouncements(list, { today = new Date().toISOString().slice(0, 10), version = appVersion(), dismissed = readSettings().dismissed || [] } = {}) {
  const gone = new Set(dismissed);
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && typeof a.title === 'string' && typeof a.text === 'string' && !gone.has(a.id))
    .filter((a) => a.from <= today && today <= a.until && versionMatches(a.appVersions, version))
    .map((a) => ({ id: a.id, title: a.title, text: a.text, link: a.link && okUrl(a.link) && a.link.startsWith('https:') ? a.link : null }));
}

// ---------- load ----------
// The registry (following a verified movedTo, one hop) and every listed game's
// index. Never throws. Returns {
//   games: [{ id, name, game, appid, status, wave, closedBeta, index, from, unavailable? }]
//     coming games have index null; a listed (stable/open-beta) game whose index
//     didn't load or verify, with no good cached copy, stays with index null,
//     unavailable: true and error (its reason), so it still shows
//   waves, app, announcements (active ones), newerInstaller: null | { reason: 'app'|'format', latest, url, release },
//   registryUrl, offline (the registry didn't come from the network), errors: [{ what, error }]
// }
async function load({ timeoutMs = TIMEOUT_MS, version = appVersion(), trustedKeys, allowUnsigned = false, today } = {}) {
  const opts = { timeoutMs, trustedKeys, allowUnsigned };
  const errors = [];
  let newerFormat = false;
  let url = registryUrl();
  let reg = await getDoc(url, null, 'registry', {}, opts);
  if (reg.error) errors.push({ what: 'registry', error: reg.error });
  newerFormat ||= reg.newerFormat;

  // movedTo: only from a registry that verified just now, one hop per start;
  // remembered once the new address gives a registry that verifies too.
  const moved = reg.from === 'network' && reg.doc?.movedTo;
  if (moved && moved !== url && !process.env.DVR_REGISTRY_URL) {
    const next = await getDoc(moved, null, 'registry', {}, opts);
    if (next.from === 'network') {
      writeSettings({ registryUrl: moved });
      url = moved;
      reg = next;
    } else {
      errors.push({ what: 'movedTo', error: next.error || 'no registry there' });
    }
  }

  const games = [];
  if (reg.doc) {
    const listed = reg.doc.games;
    const got = await Promise.all(listed.map((g) => (g.status === 'coming' || !g.index
      ? Promise.resolve(null)
      : getDoc(g.index, g.id, 'index', { id: g.id, appid: g.appid }, opts))));
    listed.forEach((g, i) => {
      const r = got[i];
      const base = { id: g.id, name: g.name, game: g.game, appid: g.appid, status: g.status, wave: g.wave ?? null, closedBeta: g.closedBeta === true };
      if (!r) { games.push({ ...base, index: null, from: null }); return; }
      if (r.error) errors.push({ what: g.id, error: r.error });
      newerFormat ||= r.newerFormat;
      if (r.doc) games.push({ ...base, index: r.doc, from: r.from });
      else games.push({ ...base, index: null, from: null, unavailable: true, error: r.error || 'no index' });
    });
  }

  const app = reg.doc?.app || null;
  let newerInstaller = null;
  if (app?.latest && compareVersions(app.latest, version) > 0) {
    // The matching release entry gives the link a checksum.
    newerInstaller = { reason: 'app', latest: app.latest, url: app.url || null, release: (app.releases || []).find((r) => r.version === app.latest) || null };
  }
  if (newerFormat) newerInstaller = { reason: 'format', latest: app?.latest || null, url: app?.url || null, release: null };

  return {
    games,
    waves: reg.doc?.waves || [],
    app,
    announcements: activeAnnouncements(reg.doc?.announcements, { today, version }),
    newerInstaller,
    registryUrl: url,
    offline: reg.from !== 'network',
    errors,
  };
}

// ---------- picking a release ----------
// The releases this app may install, newest first: stable, plus open-beta when
// the player opted into betas for the game, or when there's no stable one yet
// (an open beta is public: a game whose only releases are open betas would
// otherwise have nothing to install); never one needing a newer app.
function usableReleases(index, { optInBeta = false, appVersion: version = appVersion() } = {}) {
  const all = (normalise(index, 'index')?.releases || [])
    .filter((r) => LISTED.includes(r.maturity))
    .filter((r) => !r.minAppVersion || compareVersions(r.minAppVersion, version) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  const stable = all.filter((r) => r.maturity === 'stable');
  return optInBeta || !stable.length ? all : stable;
}

// The open beta a player could choose instead of stable: the newest usable
// open beta newer than the newest usable stable. null when there's no stable
// (the betas are offered anyway) or no newer beta (nothing to choose).
function betaOffer(index, { appVersion: version = appVersion() } = {}) {
  const all = usableReleases(index, { optInBeta: true, appVersion: version });
  const stable = all.find((r) => r.maturity === 'stable');
  const beta = all.find((r) => r.maturity === 'open-beta');
  return stable && beta && compareVersions(beta.version, stable.version) > 0
    ? { version: beta.version, maturity: beta.maturity, stableVersion: stable.version } : null;
}

function isTested(release, buildid) {
  return buildid != null && (release.testedBuildIds || []).map(String).includes(String(buildid));
}

// The release to install: the newest one tested on the player's Steam build
// (appmanifest buildid), else the newest usable one. null if none fits.
function pickRelease(index, { optInBeta = false, appVersion: version = appVersion(), buildid = null } = {}) {
  const list = usableReleases(index, { optInBeta, appVersion: version });
  return list.find((r) => isTested(r, buildid)) || list[0] || null;
}

module.exports = {
  REGISTRY_URL, FORMAT, registryUrl, okUrl, fetchSafe, load, usableReleases, betaOffer, pickRelease, isTested,
  activeAnnouncements, versionMatches, dismissAnnouncement, betaOptIn, setBetaOptIn, readSettings,
  appVersion, compareVersions,
};
