// "<Game> (VR)" entries: the Windows desktop shortcut, and removing the
// non-Steam shortcut older installers added to one account's shortcuts.vdf
// (they no longer add one: the mod lives in the game folder, so the normal
// game starts in VR). Steam rewrites shortcuts.vdf from memory when it exits,
// so the file must only be changed while Steam is closed.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const vdf = require('./vdf');

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

// The library art older installers gave the shortcut: Steam looks these up by
// the shortcut's appid in userdata/<id>/config/grid/.
const GRID = { capsule: 'p.jpg', hero: '_hero.jpg', logo: '_logo.png', header: '.jpg' };

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
  vdfPath, removeSteamShortcut, listSteamShortcuts,
  addDesktopShortcut, desktopDir,
};
