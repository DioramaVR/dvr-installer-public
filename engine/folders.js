// Base folders a "folder" mod can name (mod.json folder.target, dvr-package
// SPEC section 3): "documents" is the player's Documents folder as Windows
// knows it (User Shell Folders\Personal, so a Documents folder that OneDrive
// or the player moved is found, the same one games ask the shell for);
// "game" is the game's install folder. DVR_DOCUMENTS_DIR overrides Documents
// (tests, and a development run).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let documentsCache = null;
const expand = (p) => p.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);

function documentsDir() {
  if (process.env.DVR_DOCUMENTS_DIR) return process.env.DVR_DOCUMENTS_DIR;
  if (documentsCache) return documentsCache;
  let dir = null;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const m = /Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/.exec(out);
      if (m) dir = expand(m[1].trim());
    } catch { /* fall back below */ }
  }
  if (!dir || !path.isAbsolute(dir) || /%/.test(dir)) dir = path.join(os.homedir(), 'Documents');
  documentsCache = dir;
  return dir;
}

// Why mod.folder isn't usable, or null (dvr-package's rules; a dvr-package
// without them can't vouch for a folder mod, so it's refused).
function folderProblem(folder) {
  let check;
  try { check = require('dvr-package').folder?.folderProblem; } catch { check = null; }
  if (!check) return 'this installer\'s dvr-package has no folder rules (0.1.5 or newer needed)';
  return check(folder);
}

// The mod's own folder: <target>/<path>. Throws on anything unsafe.
function modFolder(mod, gameDir) {
  const p = folderProblem(mod.folder);
  if (p) throw new Error(`${mod.id}: ${p}`);
  const base = mod.folder.target === 'documents' ? documentsDir() : gameDir;
  if (!base) throw new Error(`${mod.id}: no ${mod.folder.target} folder to install into`);
  const dir = path.join(base, ...mod.folder.path.split('/'));
  const rel = path.relative(base, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${mod.id}: ${mod.folder.path} isn't inside ${mod.folder.target}`);
  return dir;
}

module.exports = { documentsDir, modFolder, folderProblem };
