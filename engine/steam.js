// Everything here reads Steam's local files. Nothing goes online: no Steam Web
// API, no store lookups, so no account is ever looked up anywhere.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const vdf = require('./vdf');

// SteamID64 of account 0; userdata/<accountId> folders use the difference.
const STEAMID64_BASE = 76561197960265728n;

function readRegistrySteamPath() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
    return m ? path.normalize(m[1].trim()) : null;
  } catch { return null; }
}

// DVR_STEAM_DIR points the whole engine at a fake Steam folder for tests.
function findSteam() {
  const dir = process.env.DVR_STEAM_DIR || readRegistrySteamPath()
    || 'C:\\Program Files (x86)\\Steam';
  return fs.existsSync(path.join(dir, 'steamapps')) ? dir : null;
}

function readText(file) {
  try { return vdf.parseText(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function libraries(steamDir) {
  const libs = [steamDir];
  const data = readText(path.join(steamDir, 'steamapps', 'libraryfolders.vdf'));
  for (const entry of Object.values(data?.libraryfolders || {})) {
    if (entry && entry.path) libs.push(path.normalize(entry.path));
  }
  const seen = new Set();
  return libs.filter((l) => {
    const k = l.toLowerCase();
    if (seen.has(k) || !fs.existsSync(path.join(l, 'steamapps'))) return false;
    seen.add(k);
    return true;
  });
}

// Installed copy of one app, from its appmanifest, or null.
function findApp(steamDir, appid) {
  for (const lib of libraries(steamDir)) {
    const acf = readText(path.join(lib, 'steamapps', `appmanifest_${appid}.acf`))?.AppState;
    if (!acf) continue;
    const dir = path.join(lib, 'steamapps', 'common', acf.installdir);
    if (!fs.existsSync(dir)) continue;
    return {
      appid: String(appid),
      name: acf.name,
      dir,
      library: lib,
      buildid: acf.buildid || null,
      // StateFlags 4 = fully installed; anything else is updating/downloading.
      updating: acf.StateFlags !== '4',
    };
  }
  return null;
}

// Local art from Steam's library cache. Newer Steam builds keep some images in
// hashed subfolders, so look one level down too.
function art(steamDir, appid) {
  const base = path.join(steamDir, 'appcache', 'librarycache', String(appid));
  const found = {};
  const want = {
    capsule: /^library_(600x900(_2x)?|capsule)\.jpg$/,
    hero: /^library_hero\.jpg$/,
    logo: /^logo\.png$/,
    header: /^(library_)?header\.jpg$/,
  };
  const scan = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 1) scan(p, depth + 1);
      else if (e.isFile()) {
        for (const [k, re] of Object.entries(want)) if (!found[k] && re.test(e.name)) found[k] = p;
      }
    }
  };
  scan(base, 0);
  // Flat legacy layout: librarycache/<appid>_library_600x900.jpg
  const flat = path.join(steamDir, 'appcache', 'librarycache');
  const legacy = { capsule: '_library_600x900.jpg', hero: '_library_hero.jpg', logo: '_logo.png', header: '_header.jpg' };
  for (const [k, suffix] of Object.entries(legacy)) {
    const p = path.join(flat, appid + suffix);
    if (!found[k] && fs.existsSync(p)) found[k] = p;
  }
  return found;
}

// Accounts that have logged in on this machine, from userdata/ folders, named
// from config/loginusers.vdf (also local).
function accounts(steamDir) {
  const login = readText(path.join(steamDir, 'config', 'loginusers.vdf'))?.users || {};
  const names = {};
  for (const [id64, u] of Object.entries(login)) {
    try {
      const id = String(BigInt(id64) - STEAMID64_BASE);
      names[id] = { id64, persona: u.PersonaName, account: u.AccountName, mostRecent: u.MostRecent === '1', timestamp: +u.Timestamp || +u.timestamp || 0 };
    } catch { /* malformed id */ }
  }
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(steamDir, 'userdata')).filter((d) => /^\d+$/.test(d) && d !== '0'); } catch { }
  const list = dirs.map((id) => ({
    id,
    persona: names[id]?.persona || null,
    account: names[id]?.account || null,
    timestamp: names[id]?.timestamp || 0,
    mostRecent: !!names[id]?.mostRecent,
    // Steam's local copy of the profile picture, if it has one.
    avatar: names[id] && fs.existsSync(path.join(steamDir, 'config', 'avatarcache', `${names[id].id64}.png`))
      ? path.join(steamDir, 'config', 'avatarcache', `${names[id].id64}.png`) : null,
  }));
  list.sort((a, b) => (b.mostRecent - a.mostRecent) || (b.timestamp - a.timestamp));
  // Newer Steam builds drop the MostRecent flag; the latest sign-in time says the same.
  if (list.length && !list.some((a) => a.mostRecent) && list[0].timestamp) list[0].mostRecent = true;
  return list;
}

function processRunning(exeName) {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH', '/FO', 'CSV'],
      { encoding: 'utf8', windowsHide: true });
    return out.toLowerCase().includes(`"${exeName.toLowerCase()}"`);
  } catch { return false; }
}

// DVR_SKIP_PROCESS_CHECK (tests against a fake Steam folder) treats the real
// Steam as closed so it's never shut down by a test.
const steamRunning = () => !process.env.DVR_SKIP_PROCESS_CHECK && processRunning('steam.exe');

async function closeSteam(steamDir, timeoutMs = 60000) {
  if (!steamRunning()) return true;
  spawn(path.join(steamDir, 'steam.exe'), ['-shutdown'], { detached: true, stdio: 'ignore' }).unref();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!steamRunning()) return true;
  }
  return false;
}

function startSteam(steamDir) {
  spawn(path.join(steamDir, 'steam.exe'), [], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { findSteam, libraries, findApp, art, accounts, processRunning, steamRunning, closeSteam, startSteam };
