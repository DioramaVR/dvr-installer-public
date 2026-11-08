// Downloads a release's zip (an index entry: url, size, sha256) into a new
// temp folder and checks its size and SHA-256 before anything else sees it.
// Only then does dvr-package's reader get it (signature, every file's hash).
//
//   const file = await download(release, { onProgress });   // .../dvr-dl-XXXX/<name>.zip
//   ...unpack it...
//   cleanup(file);                                           // removes the temp folder
//
// https only (plain http just to this PC, for tests). On any failure the temp
// folder is removed and the error has a .code: 'hash' for a wrong size or
// checksum (the file is damaged or changed), 'download' for anything else.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PackageError } = require('dvr-package');
const { okUrl, fetchSafe } = require('./remote');

const IDLE_MS = 30000; // no bytes for this long: give up
// Windows (or a virus scanner) can hold a just-closed file for a moment: retry the removal.
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

function fail(msg, cause) {
  const e = new Error(msg);
  e.code = 'download';
  if (cause) e.cause = cause;
  return e;
}

// A plain file name from the URL ("tpm-vr-1.0.0.zip"), else "mod.zip".
function fileName(url) {
  let base = '';
  try { base = decodeURIComponent(path.posix.basename(new URL(url).pathname)); } catch { /* keep "" */ }
  base = base.replace(/[^A-Za-z0-9._-]/g, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/i.test(base) ? base : 'mod.zip';
}

async function download(release, { onProgress = () => {}, tmpRoot = os.tmpdir(), idleMs = IDLE_MS } = {}) {
  const { url, size } = release || {};
  const want = String(release?.sha256 || '');
  if (!okUrl(url)) throw fail(`Not an https download: ${url}`);
  if (!Number.isInteger(size) || size <= 0) throw fail('The release has no size to check the download against');
  if (!/^[0-9a-fA-F]{64}$/.test(want)) throw fail('The release has no SHA-256 to check the download against');

  const dir = fs.mkdtempSync(path.join(tmpRoot, 'dvr-dl-'));
  const file = path.join(dir, fileName(url));
  const ctrl = new AbortController();
  let idle;
  const poke = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(new Error('stalled')), idleMs); };
  let out;
  try {
    poke();
    let res;
    let at;
    try { ({ res, url: at } = await fetchSafe(url, { signal: ctrl.signal })); } catch (e) { throw fail(`Couldn't download the mod (${e.cause?.code || e.message})`, e); }
    if (!res.ok) throw fail(`Couldn't download the mod (${res.status} from ${new URL(at).host})`);
    const length = res.headers.get('content-length');
    if (length != null && Number(length) !== size) {
      throw new PackageError('hash', `The download is ${length} bytes, but the release says ${size}`);
    }

    const hash = crypto.createHash('sha256');
    out = fs.createWriteStream(file);
    let done = 0;
    let shown = 0;
    onProgress({ step: 'download', done, total: size });
    try {
      for await (const chunk of res.body) {
        poke();
        done += chunk.length;
        if (done > size) throw new PackageError('hash', `The download is bigger than the release's ${size} bytes`);
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        if (done - shown >= 512 * 1024 || done === size) { shown = done; onProgress({ step: 'download', done, total: size }); }
      }
    } catch (e) {
      if (e instanceof PackageError) throw e;
      throw fail(`The download stopped (${e.message === 'stalled' || ctrl.signal.reason?.message === 'stalled' ? 'no data for a while' : e.message})`, e);
    }
    await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
    out = null;
    if (done !== size) throw new PackageError('hash', `The download is ${done} bytes, but the release says ${size}`);
    const got = hash.digest('hex');
    if (got.toLowerCase() !== want.toLowerCase()) throw new PackageError('hash', `The download's SHA-256 is ${got.toUpperCase()}, not the release's ${want.toUpperCase()}`);
    return file;
  } catch (e) {
    // Windows can't delete a file that's still open: close it first.
    if (out) await new Promise((r) => { out.once('close', r); out.destroy(); });
    fs.rmSync(dir, RM);
    throw e;
  } finally {
    clearTimeout(idle);
  }
}

// Removes the temp folder a download made (only a dvr-dl-* folder).
function cleanup(file) {
  const dir = path.dirname(path.resolve(String(file || '')));
  if (/^dvr-dl-/.test(path.basename(dir))) fs.rmSync(dir, RM);
}

module.exports = { download, cleanup, fileName };
