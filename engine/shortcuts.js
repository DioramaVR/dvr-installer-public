// "<Game> (VR)" entries: a non-Steam shortcut in one account's shortcuts.vdf,
// flagged OpenVR so it also shows in the SteamVR library, plus an optional
// Windows desktop shortcut. Steam rewrites shortcuts.vdf from memory when it
// exits, so the file must only be changed while Steam is closed.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const vdf = require('./vdf');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(str) {
  let c = 0xffffffff;
  for (const b of Buffer.from(str, 'utf8')) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// The id Steam uses for a non-Steam shortcut (and its grid art file names).
function shortcutAppId(exe, name) {
  return (crc32(exe + name) | 0x80000000) >>> 0;
}

const vdfPath = (steamDir, accountId) => path.join(steamDir, 'userdata', accountId, 'config', 'shortcuts.vdf');

function read(file) {
  if (!fs.existsSync(file)) return { shortcuts: {} };
  const data = vdf.parseBinary(fs.readFileSync(file));
  if (!data.shortcuts) data.shortcuts = {};
  return data;
}

// Steam expects the entries keyed "0", "1", ... with no gaps.
function renumber(map) {
  const out = {};
  Object.values(map).forEach((v, i) => { out[String(i)] = v; });
  return out;
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${file}.dvr-${stamp}.bak`;
  fs.copyFileSync(file, bak);
  return bak;
}

const sameEntry = (e, name, exeQuoted) => {
  const n = e.AppName ?? e.appname;
  const x = e.Exe ?? e.exe;
  return n === name || (x && x.toLowerCase() === exeQuoted.toLowerCase() && String(n).endsWith('(VR)'));
};

// Adds (or replaces) the shortcut. Returns { appid, backup }.
function addSteamShortcut({ steamDir, accountId, name, exe, startDir, launchArgs, icon, art }) {
  const file = vdfPath(steamDir, accountId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = read(file);
  const exeQuoted = `"${exe}"`;
  const appid = shortcutAppId(exeQuoted, name);
  const kept = Object.values(data.shortcuts).filter((e) => !sameEntry(e, name, exeQuoted));
  kept.push({
    appid: { int: appid | 0 },
    AppName: name,
    Exe: exeQuoted,
    StartDir: `"${startDir}"`,
    icon: icon || exe,
    ShortcutPath: '',
    LaunchOptions: launchArgs || '',
    IsHidden: { int: 0 },
    AllowDesktopConfig: { int: 1 },
    AllowOverlay: { int: 1 },
    OpenVR: { int: 1 },
    Devkit: { int: 0 },
    DevkitGameID: '',
    DevkitOverrideAppID: { int: 0 },
    LastPlayTime: { int: 0 },
    FlatpakAppID: '',
    tags: { 0: 'VR' },
  });
  const bak = backup(file);
  data.shortcuts = renumber(kept);
  fs.writeFileSync(file, vdf.serializeBinary(data));
  if (art) copyGridArt(steamDir, accountId, appid, art);
  return { appid, backup: bak };
}

function removeSteamShortcut({ steamDir, accountId, name, appid }) {
  const file = vdfPath(steamDir, accountId);
  if (!fs.existsSync(file)) return { removed: false };
  const data = read(file);
  const before = Object.values(data.shortcuts);
  const kept = before.filter((e) => {
    const id = (e.appid?.int ?? 0) >>> 0;
    return !((appid && id === appid) || (e.AppName ?? e.appname) === name);
  });
  if (kept.length === before.length) return { removed: false };
  const bak = backup(file);
  data.shortcuts = renumber(kept);
  fs.writeFileSync(file, vdf.serializeBinary(data));
  if (appid) removeGridArt(steamDir, accountId, appid);
  return { removed: true, backup: bak };
}

// Gives the shortcut the real game's library art: Steam looks these up by the
// shortcut's appid in userdata/<id>/config/grid/.
const GRID = { capsule: 'p.jpg', hero: '_hero.jpg', logo: '_logo.png', header: '.jpg' };

function copyGridArt(steamDir, accountId, appid, art) {
  const grid = path.join(steamDir, 'userdata', accountId, 'config', 'grid');
  fs.mkdirSync(grid, { recursive: true });
  for (const [k, suffix] of Object.entries(GRID)) {
    if (art[k]) { try { fs.copyFileSync(art[k], path.join(grid, appid + suffix)); } catch { } }
  }
}

function removeGridArt(steamDir, accountId, appid) {
  const grid = path.join(steamDir, 'userdata', accountId, 'config', 'grid');
  for (const suffix of Object.values(GRID)) fs.rmSync(path.join(grid, appid + suffix), { force: true });
}

function listSteamShortcuts(steamDir, accountId) {
  return Object.values(read(vdfPath(steamDir, accountId)).shortcuts).map((e) => ({
    appid: (e.appid?.int ?? 0) >>> 0,
    name: e.AppName ?? e.appname,
    exe: e.Exe ?? e.exe,
    launchArgs: e.LaunchOptions,
    openVR: e.OpenVR?.int === 1,
  }));
}

// Windows .lnk through WScript.Shell; arguments go in as environment variables
// so no path ever gets spliced into the PowerShell source.
function addDesktopShortcut({ lnkPath, exe, args, workDir, icon, description }) {
  fs.mkdirSync(path.dirname(lnkPath), { recursive: true });
  const script = [
    '$l = (New-Object -ComObject WScript.Shell).CreateShortcut($env:S_LNK)',
    '$l.TargetPath = $env:S_EXE', '$l.Arguments = $env:S_ARGS', '$l.WorkingDirectory = $env:S_DIR',
    '$l.IconLocation = $env:S_ICON + ",0"', '$l.Description = $env:S_DESC', '$l.Save()',
  ].join('; ');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: { ...process.env, S_LNK: lnkPath, S_EXE: exe, S_ARGS: args || '', S_DIR: workDir, S_ICON: icon || exe, S_DESC: description || '' },
  });
  return lnkPath;
}

function desktopDir() {
  if (process.env.DVR_DESKTOP_DIR) return process.env.DVR_DESKTOP_DIR;
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("Desktop")'],
      { encoding: 'utf8', windowsHide: true }).trim();
  } catch { return path.join(process.env.USERPROFILE || '', 'Desktop'); }
}

module.exports = {
  crc32, shortcutAppId, vdfPath, addSteamShortcut, removeSteamShortcut, listSteamShortcuts,
  addDesktopShortcut, desktopDir,
};
