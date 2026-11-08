// Mod packages in the installer's cache. The format and every check belong to
// dvr-package (its docs/SPEC.md); the installer only reads packages: it never
// packs, signs or writes indexes. What's here is the installer's side: where
// unpacked packages live, unpacking into there through dvr-package's reader,
// and listing them.
//
// Unpacked, a package is a mod folder,
// <cacheRoot()>/mods/<id>-<version>/, with .ok written last; loadMods picks
// these up (engine/index.js).
const fs = require('fs');
const path = require('path');
const dvr = require('dvr-package');
const { cacheRoot } = require('./uevr');
const { appVersion } = require('./version');

const packagesDir = () => path.join(cacheRoot(), 'mods');

// Running as the packaged app (electron-builder), not `electron .` or Node.
const isPackaged = () => !!process.versions.electron && !process.defaultApp;

// Unsigned zips: never in the packaged app; only in a development run with
// DVR_DEV set (a dev pack made with dvr-package's dvr-pack, unsigned).
const allowUnsigned = () => !isPackaged() && !!process.env.DVR_DEV;

// Checks and unpacks a package zip into the cache with dvr-package's reader
// (format, minAppVersion against this app's version, signature against
// dvr-package's trusted-keys.json, every file and hash, mod.json). Throws its
// PackageError (.code, SPEC section 9) on a refusal; nothing is left behind.
// opts.check(dir, manifest): the installer's own checks before the move.
// opts.trustedKeys and opts.appVersion are for tests only (there's no way to
// set them from the app or the environment).
// Returns { id, version, maturity, knownIssues, dir, manifest, key }.
function unpack(zipPath, opts = {}) {
  return dvr.reader.unpack(zipPath, packagesDir(), {
    appVersion: opts.appVersion || appVersion(),
    trustedKeys: opts.trustedKeys,
    allowUnsigned: allowUnsigned(),
    check: opts.check,
  });
}

// Every complete unpacked package in the cache:
// [{ id, version, maturity, knownIssues, dir, manifest }].
const list = () => dvr.reader.list(packagesDir());

// How each unpacked package arrived: <cacheRoot()>/packages.json,
// { "<id>-<version>": { source: 'download' | 'file', sha256 } }. sha256 is
// the zip's, so a loaded file that is a listed release can be told apart from
// one that isn't (SPEC section 3: the index's maturity wins for a listed zip).
const originsFile = () => path.join(cacheRoot(), 'packages.json');
function readOrigins() {
  try {
    const d = JSON.parse(fs.readFileSync(originsFile(), 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}
function writeOrigins(d) {
  fs.mkdirSync(cacheRoot(), { recursive: true });
  const tmp = `${originsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n');
  fs.renameSync(tmp, originsFile());
}
const origin = (id, version) => readOrigins()[`${id}-${version}`] || null;
function setOrigin(id, version, info) {
  const d = readOrigins();
  d[`${id}-${version}`] = info;
  writeOrigins(d);
}

// The SHA-256 of a file (upper-case hex), as indexes write it.
const sha256File = (file) => dvr.reader.sha256File(file);

function removeUnpacked(id, version) {
  fs.rmSync(path.join(packagesDir(), `${id}-${version}`), { recursive: true, force: true });
  const d = readOrigins();
  if (d[`${id}-${version}`]) { delete d[`${id}-${version}`]; writeOrigins(d); }
}

module.exports = {
  packagesDir, isPackaged, allowUnsigned, unpack, list, removeUnpacked, origin, setOrigin, sha256File,
  PackageError: dvr.PackageError,
};
