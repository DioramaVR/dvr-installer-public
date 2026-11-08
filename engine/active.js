// Which version of each mod is active: <cacheRoot()>/active.json,
// { "<mod id>": { "version": "0.1.0" } }. An entry names a package version;
// no entry means the default (a dev build if there is one, else the newest
// package here). The cache folder can be shared by several app runs, so
// writes go to a temp file first and are renamed into place.
const fs = require('fs');
const path = require('path');
const { cacheRoot } = require('./uevr');

const file = () => path.join(cacheRoot(), 'active.json');

function read() {
  try {
    const d = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}

function write(data) {
  fs.mkdirSync(cacheRoot(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file());
}

// The package version chosen for a mod, or null (the default).
function get(id) {
  const v = read()[id]?.version;
  return typeof v === 'string' ? v : null;
}

// version null: back to the default.
function set(id, version) {
  const data = read();
  if (version == null) delete data[id];
  else data[id] = { version };
  write(data);
}

module.exports = { file, get, set };
