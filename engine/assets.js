// A game's media files (hero, turntable and its other encodings and poster,
// gallery pictures), named by the "assets" list in its signed index:
//   "assets": { "release", "date", "files": { name: { url, sha256, size } }, "media": [...] }
// Each file is downloaded on its own when the game's page opens, checked
// against its size and SHA-256, and kept in <cache>/assets/<id>/<sha256><ext>.
// A file whose hash is unchanged is never downloaded again, whatever mod
// version the index is on. A bad file is deleted and the page shows without
// it. When the index has "assets", the data zip's media are ignored.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const download = require('./download');
const pkg = require('./package');
const { okUrl } = require('./remote');
const { cacheRoot } = require('./uevr');

const MAX_SIZE = 64 * 1024 * 1024;
const MEDIA_TYPES = ['.jpg', '.jpeg', '.png', '.webp', '.webm', '.mp4'];
const ROLES = ['hero', 'turntable', 'gallery'];

const okName = (n) => typeof n === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(n) && !n.includes('..')
  && MEDIA_TYPES.includes(path.extname(n).toLowerCase());
const okHash = (h) => typeof h === 'string' && /^[0-9a-fA-F]{64}$/.test(h);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------- the checks (adapter) ----------
// list(index) -> [{ name, url, sha256, size }], throwing when the list is
// malformed, and verify(name, buf, index), throwing on a size or SHA-256
// mismatch: dvr-package's gameAssets (v0.1.3), which checks the whole list
// strictly (https URLs only, the files/media rules). The small "own" versions
// below check per file only; they're used when the package has no gameAssets,
// by tests (setChecks), and for a local seed served over plain http:
// DVR_ASSETS_CHECKS=own, outside the packaged app with DVR_DEV only.
const own = {
  list(index) {
    const files = index?.assets?.files;
    if (!files || typeof files !== 'object' || Array.isArray(files)) return [];
    return Object.entries(files).map(([name, f]) => ({ name, url: f?.url, sha256: f?.sha256, size: f?.size }));
  },
  verify(name, buf, index) {
    const f = index?.assets?.files?.[name];
    if (!f) throw new Error(`${name}: not in the index's assets`);
    if (buf.length !== f.size) throw new Error(`${name}: ${buf.length} bytes, the index says ${f.size}`);
    if (sha256(buf) !== String(f.sha256).toLowerCase()) throw new Error(`${name}: SHA-256 doesn't match the index`);
  },
};
let override = null;
function setChecks(c) { override = c || null; }
function checks() {
  if (override) return override;
  if (process.env.DVR_ASSETS_CHECKS === 'own' && pkg.allowUnsigned()) return own;
  try {
    const g = require('dvr-package').gameAssets;
    if (g?.list && g?.verify) return g;
  } catch { /* not there */ }
  return own;
}

// ---------- the index's "assets" ----------
// The checks' list, or null when there's none or it's malformed: then the
// index counts as having no assets (the data zip's media are used, if any).
function checked(index) {
  if (!index?.assets || typeof index.assets !== 'object' || Array.isArray(index.assets)) return null;
  try {
    const all = checks().list(index);
    return Array.isArray(all) ? all : null;
  } catch { return null; }
}
const has = (index) => checked(index) !== null;

// The files to fetch, each checked here too, as a second guard (names become
// paths): a flat media name, an https URL, a SHA-256 and a size up to 64 MB.
// Others are left out.
function list(index) {
  const all = checked(index) || [];
  const seen = new Set();
  return all.filter((f) => okName(f?.name) && okUrl(f.url) && okHash(f.sha256) && Number.isInteger(f.size) && f.size > 0 && f.size <= MAX_SIZE
    && !seen.has(f.name) && seen.add(f.name))
    .map((f) => ({ name: f.name, url: f.url, sha256: f.sha256.toLowerCase(), size: f.size }));
}

// The index's media list, with only names that are in the files list.
function mediaList(index, names) {
  const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
  const ok = (n) => typeof n === 'string' && names.has(n);
  return (Array.isArray(index?.assets?.media) ? index.assets.media : [])
    .filter((m) => ok(m?.file) && ['image', 'video'].includes(m.kind) && ROLES.includes(m.role))
    .map((m) => ({
      file: m.file, kind: m.kind, role: m.role, alt: str(m.alt) || '',
      poster: ok(m.poster) ? m.poster : null,
      sources: (Array.isArray(m.sources) ? m.sources : []).filter(ok),
    }));
}

// ---------- the cache ----------
const safeId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id);
const gameDir = (id) => path.join(cacheRoot(), 'assets', id);
const cacheFile = (id, f) => path.join(gameDir(id), f.sha256 + path.extname(f.name).toLowerCase());
const verified = new Set(); // cache files whose hash was checked this run

// A cached file of the right size (its hash is checked when the page opens).
function present(id, f) {
  try { return fs.statSync(cacheFile(id, f)).size === f.size; } catch { return false; }
}

// Checks a cached file's bytes once per run; a bad one is deleted.
function checkCached(id, f, index) {
  const file = cacheFile(id, f);
  if (verified.has(file)) return fs.existsSync(file);
  let buf;
  try { buf = fs.readFileSync(file); } catch { return false; }
  try { checks().verify(f.name, buf, index); } catch {
    fs.rmSync(file, { force: true });
    return false;
  }
  verified.add(file);
  return true;
}

function store(id, f, buf) {
  const dir = gameDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${f.sha256}`);
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, cacheFile(id, f));
  verified.add(cacheFile(id, f));
}

// Files the index no longer names (and stray temp files) are removed.
function prune(id, files) {
  const keep = new Set(files.map((f) => path.basename(cacheFile(id, f))));
  let names = [];
  try { names = fs.readdirSync(gameDir(id)); } catch { return; }
  for (const n of names) if (!keep.has(n)) fs.rmSync(path.join(gameDir(id), n), { recursive: true, force: true });
}

// ---------- fetching ----------
const inFlight = new Map(); // game id -> promise
const failed = new Set();   // "id@sha256" that failed this run: not tried again until restart

// Fetches what isn't cached yet, one file at a time; resolves to the media
// whose files are here (poster and sources likewise), or null when the index
// has no assets. Never throws: a failed file is logged and left out.
async function get(id, index, { onError = (e) => console.warn(`assets for ${id}:`, e.message) } = {}) {
  if (!safeId(id) || index?.id !== id || !has(index)) return null;
  if (!inFlight.has(id)) {
    inFlight.set(id, (async () => {
      const files = list(index);
      const here = new Set();
      for (const f of files) {
        if (checkCached(id, f, index)) { here.add(f.name); continue; }
        const key = `${id}@${f.sha256}`;
        if (failed.has(key)) continue;
        let tmp;
        try {
          tmp = await download.download({ url: f.url, size: f.size, sha256: f.sha256 });
          const buf = fs.readFileSync(tmp);
          checks().verify(f.name, buf, index);
          store(id, f, buf);
          here.add(f.name);
        } catch (e) {
          failed.add(key);
          onError(new Error(`${f.name}: ${e.message}`));
        } finally {
          if (tmp) download.cleanup(tmp);
        }
      }
      try { prune(id, files); } catch { /* next time */ }
      return mediaList(index, here);
    })().finally(() => inFlight.delete(id)));
  }
  return inFlight.get(id);
}

// The media already cached (no fetching, no hashing): for the gallery card.
function cached(id, index) {
  if (!safeId(id) || index?.id !== id || !has(index)) return null;
  return mediaList(index, new Set(list(index).filter((f) => present(id, f)).map((f) => f.name)));
}

// The full path of one of a game's cached files, or null.
function mediaFile(id, index, name) {
  if (!safeId(id) || index?.id !== id || !okName(name)) return null;
  const f = list(index).find((x) => x.name === name);
  return f && present(id, f) ? cacheFile(id, f) : null;
}

// Tests: forget this run's failures and checks.
function reset() { failed.clear(); inFlight.clear(); verified.clear(); }

module.exports = { has, list, get, cached, mediaFile, setChecks, reset, own, MAX_SIZE, MEDIA_TYPES };
