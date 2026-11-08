// A game's data zip (data.json + media/), named by its signed index:
//   "data": { "url", "sha256", "size", "date" }
// Fetched once when the game's page opens, checked against the index's size
// and SHA-256, read with dvr-package's dataZip.read (every check of the
// format), and kept unpacked in <cache>/data/<id>/<sha256>/ until the index
// names another hash. Never throws for a network or format problem: the page
// then shows the index alone.
const fs = require('fs');
const path = require('path');
const download = require('./download');
const pkg = require('./package');
const { okUrl } = require('./remote');
const { cacheRoot } = require('./uevr');

const MAX_SIZE = 64 * 1024 * 1024;
const MEDIA_TYPES = ['.jpg', '.jpeg', '.png', '.webp', '.webm', '.mp4'];
const SEVERITIES = ['minor', 'annoying', 'blocking'];

// ---------- the reader (adapter) ----------
// read(zipPath, { sha256, size }) -> { data, files: Map(name -> Buffer) },
// throwing on anything wrong. dvr-package's dataZip.read once it ships; until
// then the feature is off (null). DVR_DATA_READER=<path to a dvr-package
// checkout> uses that one instead, outside the packaged app with DVR_DEV only
// (local testing). Tests set their own with setReader().
let override = null;
function setReader(fn) { override = fn || null; }
function reader() {
  if (override) return override;
  if (process.env.DVR_DATA_READER && pkg.allowUnsigned()) {
    const m = require(path.resolve(process.env.DVR_DATA_READER));
    return m.dataZip?.read || null;
  }
  try { return require('dvr-package').dataZip?.read || null; } catch { return null; }
}

// ---------- the index's "data" field ----------
const okHash = (h) => typeof h === 'string' && /^[0-9a-fA-F]{64}$/.test(h);
function dataRef(index) {
  const d = index?.data;
  if (!d || typeof d !== 'object') return null;
  if (!okUrl(d.url) || !okHash(d.sha256) || !Number.isInteger(d.size) || d.size <= 0 || d.size > MAX_SIZE) return null;
  return { url: d.url, sha256: d.sha256.toLowerCase(), size: d.size, date: typeof d.date === 'string' ? d.date : null };
}

const gameDir = (id) => path.join(cacheRoot(), 'data', id);
const hashDir = (id, sha) => path.join(gameDir(id), sha);
const safeId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id);
const safeMedia = (name) => typeof name === 'string' && /^media\/[^/\\]+$/.test(name) && !name.includes('..')
  && MEDIA_TYPES.includes(path.extname(name).toLowerCase());

// ---------- data.json, made safe for the app: plain strings only ----------
const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const strs = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
function clean(data, id, mediaNames) {
  if (!data || typeof data !== 'object' || data.format !== 1) throw new Error('data.json: not format 1');
  if (data.id !== id) throw new Error(`data.json is for ${data.id}, not ${id}`);
  const line = str(data.line);
  if (!line) throw new Error('data.json: no line');
  const has = (f) => safeMedia(f) && mediaNames.has(f);
  return {
    id,
    line,
    firstLaunch: str(data.firstLaunch),
    needToKnow: strs(data.needToKnow),
    // Title and text only: per-step controls are no longer part of the format.
    tutorial: (Array.isArray(data.tutorial) ? data.tutorial : []).map((t) => ({ title: str(t?.title), text: str(t?.text) })).filter((t) => t.title || t.text),
    knownIssues: Array.isArray(data.knownIssues) ? data.knownIssues.filter((k) => str(k?.id) && str(k?.title)).map((k) => ({
      id: k.id, title: k.title, text: str(k.text) || '', severity: SEVERITIES.includes(k.severity) ? k.severity : 'minor',
      since: str(k.since), fixedIn: str(k.fixedIn),
    })) : null,
    media: (Array.isArray(data.media) ? data.media : []).filter((m) => has(m?.file) && ['image', 'video'].includes(m.kind)).map((m) => ({
      file: m.file, kind: m.kind, role: str(m.role) || 'gallery', alt: str(m.alt) || '',
      poster: has(m.poster) ? m.poster : null,
      sources: strs(m.sources).filter(has),
    })),
  };
}

// ---------- the cache ----------
// A hash folder is complete when its data.json is there (written last).
function readCached(id, sha) {
  const dir = hashDir(id, sha);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')); } catch { return null; }
  let names = [];
  try { names = fs.readdirSync(path.join(dir, 'media')).map((n) => `media/${n}`); } catch { /* no media */ }
  try { return clean(raw, id, new Set(names)); } catch { return null; }
}

function store(id, sha, data, files) {
  const root = gameDir(id);
  fs.mkdirSync(root, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(root, '.tmp-'));
  try {
    fs.mkdirSync(path.join(tmp, 'media'));
    for (const [name, buf] of files) {
      if (name === 'data.json') continue;
      if (!safeMedia(name)) throw new Error(`${name}: not a media file`);
      fs.writeFileSync(path.join(tmp, name), buf);
    }
    fs.writeFileSync(path.join(tmp, 'data.json'), JSON.stringify(data));
    fs.rmSync(hashDir(id, sha), { recursive: true, force: true });
    fs.renameSync(tmp, hashDir(id, sha));
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  // Only the current hash is kept.
  for (const d of fs.readdirSync(root)) if (d !== sha) fs.rmSync(path.join(root, d), { recursive: true, force: true });
}

// ---------- fetching ----------
const inFlight = new Map(); // "id@sha" -> promise
const failed = new Set();   // "id@sha" that failed this run: not tried again until restart

// The game's data for the index's current hash: from the cache, else fetched
// (once). Resolves to the cleaned data, or null (no data field, no reader,
// or a failure, which is logged and remembered for this run).
async function get(id, index, { onError = (e) => console.warn(`data for ${id}:`, e.message) } = {}) {
  if (!safeId(id) || index?.id !== id) return null;
  const ref = dataRef(index);
  if (!ref) return null;
  const cached = readCached(id, ref.sha256);
  if (cached) return cached;
  const key = `${id}@${ref.sha256}`;
  if (failed.has(key)) return null;
  const read = reader();
  if (!read) return null;
  if (!inFlight.has(key)) {
    inFlight.set(key, (async () => {
      let file;
      try {
        file = await download.download({ url: ref.url, size: ref.size, sha256: ref.sha256 });
        const { data, files } = await read(file, { sha256: ref.sha256, size: ref.size });
        const names = new Set([...files.keys()].filter(safeMedia));
        clean(data, id, names); // refuse before anything is stored
        store(id, ref.sha256, data, files);
        return readCached(id, ref.sha256);
      } catch (e) {
        failed.add(key);
        onError(e);
        return null;
      } finally {
        if (file) download.cleanup(file);
        inFlight.delete(key);
      }
    })());
  }
  return inFlight.get(key);
}

// What's already cached for the index's hash (no fetching): for the gallery card.
function cached(id, index) {
  const ref = safeId(id) && index?.id === id ? dataRef(index) : null;
  return ref ? readCached(id, ref.sha256) : null;
}

// The full path of one of a game's cached media files, or null.
function mediaFile(id, index, name) {
  const ref = safeId(id) && index?.id === id ? dataRef(index) : null;
  if (!ref || !safeMedia(name)) return null;
  const file = path.join(hashDir(id, ref.sha256), name);
  return fs.existsSync(file) ? file : null;
}

// Tests: forget this run's failures.
function reset() { failed.clear(); inFlight.clear(); }

module.exports = { get, cached, mediaFile, dataRef, setReader, reset, MAX_SIZE, MEDIA_TYPES };
