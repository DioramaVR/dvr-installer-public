// UEVR (praydog/UEVR) for the Unreal Engine mods. Its licence ("All rights
// reserved") doesn't let us pass it on, so it isn't in the installer: install
// downloads the official release that mod.json names (loader.url), checks it
// against the pinned loader.sha256 and keeps it in a cache. A plain download of
// a public file; nothing about the player or their Steam accounts is sent.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// What the launcher needs from a release (the .pdb files are left out).
const REQUIRED = ['UEVRBackend.dll', 'UEVRInjector.exe', 'openvr_api.dll'];
const OPTIONAL = ['UEVRInjector.dll.config', 'LuaVR.dll', 'UEVRPluginNullifier.dll', 'openxr_loader.dll', 'revision.txt'];

function cacheRoot() {
  return process.env.DVR_CACHE_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'DioramaVR', 'cache');
}

// UEVR keeps one profile per game exe here (scripts, plugins, config.txt).
function profilesDir() {
  return process.env.DVR_UEVR_PROFILES || path.join(process.env.APPDATA || os.homedir(), 'UnrealVRMod');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

async function download(url, file, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Couldn't download UEVR (${res.status} from ${new URL(url).host})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file);
  let done = 0;
  let shown = 0;
  try {
    for await (const chunk of res.body) {
      out.write(chunk);
      done += chunk.length;
      if (done - shown >= 512 * 1024 || done === total) { shown = done; onProgress({ step: 'download', done, total }); }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
  }
  return null;
}

// The release's files, downloaded and checked once. Returns the folder with them.
// DVR_UEVR_ZIP uses a local copy of the zip instead (tests, offline).
async function ensure(loader, onProgress = () => {}) {
  if (!loader.version || !loader.sha256 || (!loader.url && !process.env.DVR_UEVR_ZIP)) {
    throw new Error('mod.json loader needs version, url and sha256 for UEVR');
  }
  const dir = path.join(cacheRoot(), `uevr-${loader.version}`);
  if (fs.existsSync(path.join(dir, '.ok'))) return dir;

  fs.mkdirSync(cacheRoot(), { recursive: true });
  const zip = `${dir}.zip`;
  if (process.env.DVR_UEVR_ZIP) fs.copyFileSync(process.env.DVR_UEVR_ZIP, zip);
  else await download(loader.url, zip, onProgress);
  try {
    const got = sha256(zip);
    if (got !== loader.sha256.toUpperCase()) throw new Error(`The UEVR download doesn't match its checksum (got ${got}); not using it`);
    const tmp = `${dir}.unpack`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    // Windows' own bsdtar unpacks zips (a GNU tar on PATH wouldn't).
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-x', '-f', zip, '-C', tmp], { windowsHide: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const name of [...REQUIRED, ...OPTIONAL]) {
      const f = findFile(tmp, name);
      if (f) fs.copyFileSync(f, path.join(dir, name));
      else if (REQUIRED.includes(name)) throw new Error(`The UEVR download has no ${name}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, '.ok'), loader.version);
  } finally {
    fs.rmSync(zip, { force: true });
  }
  return dir;
}

// key=value lines (UEVR's config.txt): sets these keys, keeps every other line.
function writeConfig(file, values) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const seen = new Set();
  const out = lines.map((l) => {
    const k = l.split('=', 1)[0];
    if (k in values) { seen.add(k); return `${k}=${values[k]}`; }
    return l;
  });
  for (const [k, v] of Object.entries(values)) if (!seen.has(k)) out.push(`${k}=${v}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n') + '\n');
}

module.exports = { ensure, profilesDir, cacheRoot, writeConfig, REQUIRED, OPTIONAL };
