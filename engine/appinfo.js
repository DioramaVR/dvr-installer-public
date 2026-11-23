// Steam's app data cache, <Steam>/appcache/appinfo.vdf (format v29, keys in a
// string table at the end of the file), read and edited one app at a time.
// Used for one thing: a game's "Play in VR" launch option (engine/vrlaunch.js),
// which is what a standalone headset such as the Steam Frame starts.
//
// Steam keeps this file in memory and writes it back when it exits, so it's
// only ever changed while steam.exe isn't running (the caller checks). Each
// write is checked three ways first: the unedited file must round-trip byte for
// byte through this parser, the edited file must parse with every entry's
// SHA-1 right, and every other app's entry must be byte-identical. Per entry
// only the binary KV blob, its size and its binary SHA-1 (header bytes 40-60)
// change. The rest of the header (Valve's text SHA-1, changeNumber, infoState,
// lastUpdated, picsToken) stays as it is: Steam accepts it, and replaces the
// whole entry when Valve's changeNumber moves (vrlaunch.js re-applies then).
'use strict';
const crypto = require('crypto');

const MAGIC = 0x07564429;
const HEAD = 60;              // entry header after appid + size: infoState .. binary SHA-1
const SHA1_AT = 40;           // binary SHA-1 of the KV blob, bytes 40-60 of that header
const T = { SECTION: 0x00, STRING: 0x01, INT: 0x02, FLOAT: 0x03, UINT64: 0x07, END: 0x08 };

function parse(buf) {
  if (buf.length < 16 || buf.readUInt32LE(0) !== MAGIC) {
    throw new Error(`Steam's appinfo.vdf is in a format this installer doesn't know (${buf.length < 4 ? 'too short' : 'magic ' + buf.readUInt32LE(0).toString(16)})`);
  }
  const universe = buf.readUInt32LE(4);
  const tableOff = Number(buf.readBigInt64LE(8));
  if (tableOff < 16 || tableOff + 4 > buf.length) throw new Error('appinfo.vdf: string table offset out of range');
  let p = tableOff;
  const n = buf.readUInt32LE(p); p += 4;
  const strings = [];
  for (let i = 0; i < n; i++) {
    const e = buf.indexOf(0, p);
    if (e < 0) throw new Error('appinfo.vdf: string table cut short');
    strings.push(buf.toString('utf8', p, e)); p = e + 1;
  }
  if (p !== buf.length) throw new Error('appinfo.vdf: bytes after the string table');
  const entries = [];
  p = 16;
  for (;;) {
    if (p + 4 > tableOff) throw new Error('appinfo.vdf: entries run into the string table');
    const appid = buf.readUInt32LE(p);
    if (appid === 0) { p += 4; break; }
    const size = buf.readUInt32LE(p + 4);
    const start = p + 8;
    if (size < HEAD || start + size > tableOff) throw new Error(`appinfo.vdf: entry ${appid} has a bad size`);
    entries.push({ appid, head: Buffer.from(buf.subarray(start, start + HEAD)), kv: Buffer.from(buf.subarray(start + HEAD, start + size)) });
    p = start + size;
  }
  if (p !== tableOff) throw new Error(`appinfo.vdf: entries end at ${p}, the string table starts at ${tableOff}`);
  return { universe, strings, entries };
}

function serialize(db) {
  const parts = [];
  const head = Buffer.alloc(16);
  head.writeUInt32LE(MAGIC, 0); head.writeUInt32LE(db.universe, 4);
  parts.push(head);
  let off = 16;
  for (const e of db.entries) {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(e.appid, 0); h.writeUInt32LE(e.head.length + e.kv.length, 4);
    parts.push(h, e.head, e.kv); off += 8 + e.head.length + e.kv.length;
  }
  parts.push(Buffer.alloc(4)); off += 4;            // appid 0: the end of the entries
  head.writeBigInt64LE(BigInt(off), 8);
  const n = Buffer.alloc(4); n.writeUInt32LE(db.strings.length, 0); parts.push(n);
  for (const s of db.strings) parts.push(Buffer.from(s + '\0', 'utf8'));
  return Buffer.concat(parts);
}

// A typed KV tree: nodes { t, k, v }; a section's v is an array of nodes.
function readKv(buf, strings) {
  let p = 0;
  function section() {
    const out = [];
    for (;;) {
      if (p >= buf.length) throw new Error('kv cut short');
      const t = buf[p++];
      if (t === T.END) return out;
      const ki = buf.readUInt32LE(p); p += 4;
      if (ki >= strings.length) throw new Error('kv key index out of range');
      const k = strings[ki];
      if (t === T.SECTION) out.push({ t, k, v: section() });
      else if (t === T.STRING) { const e = buf.indexOf(0, p); if (e < 0) throw new Error('kv string cut short'); out.push({ t, k, v: buf.toString('utf8', p, e) }); p = e + 1; }
      else if (t === T.INT) { out.push({ t, k, v: buf.readInt32LE(p) }); p += 4; }
      else if (t === T.FLOAT) { out.push({ t, k, v: buf.readFloatLE(p) }); p += 4; }
      else if (t === T.UINT64) { out.push({ t, k, v: buf.readBigUInt64LE(p) }); p += 8; }
      else throw new Error('kv type ' + t);
    }
  }
  const tree = section();
  if (p !== buf.length) throw new Error(`kv ends at ${p} of ${buf.length}`);
  return tree;
}

// New key names are appended to strings (the file's table).
function writeKv(tree, strings) {
  const index = new Map(strings.map((s, i) => [s, i]));   // as the core's tool, proven on a real file
  const key = (k) => {
    if (!index.has(k)) { index.set(k, strings.length); strings.push(k); }
    const b = Buffer.alloc(4); b.writeUInt32LE(index.get(k)); return b;
  };
  const parts = [];
  (function section(nodes) {
    for (const n of nodes) {
      parts.push(Buffer.from([n.t]), key(n.k));
      if (n.t === T.SECTION) section(n.v);
      else if (n.t === T.STRING) parts.push(Buffer.from(n.v + '\0', 'utf8'));
      else if (n.t === T.INT) { const b = Buffer.alloc(4); b.writeInt32LE(n.v); parts.push(b); }
      else if (n.t === T.FLOAT) { const b = Buffer.alloc(4); b.writeFloatLE(n.v); parts.push(b); }
      else if (n.t === T.UINT64) { const b = Buffer.alloc(8); b.writeBigUInt64LE(n.v); parts.push(b); }
      else throw new Error('kv type ' + n.t);
    }
    parts.push(Buffer.from([T.END]));
  })(tree);
  return Buffer.concat(parts);
}

const sha1 = (b) => crypto.createHash('sha1').update(b).digest();

// The file, parsed, after checking it survives a byte-for-byte round trip
// and every entry's binary SHA-1 matches: otherwise it isn't touched.
function load(buf) {
  const db = parse(buf);
  for (const e of db.entries) {
    if (!sha1(e.kv).equals(e.head.subarray(SHA1_AT, SHA1_AT + 20))) throw new Error(`appinfo.vdf: entry ${e.appid}'s SHA-1 doesn't match`);
    if (!writeKv(readKv(e.kv, db.strings), db.strings.slice()).equals(e.kv)) throw new Error(`appinfo.vdf: entry ${e.appid} doesn't round-trip`);
  }
  if (!serialize(db).equals(buf)) throw new Error("appinfo.vdf doesn't round-trip");
  return db;
}

const find = (nodes, k) => nodes.find((n) => n.k === k);
const clone = (nodes) => nodes.map((n) => ({ t: n.t, k: n.k, v: n.t === T.SECTION ? clone(n.v) : n.v }));

// One app's tree and the parts of it we use, or null when the app isn't in the
// file (Steam hasn't fetched it yet) or has no launch section.
function app(db, appid) {
  const e = db.entries.find((x) => x.appid === Number(appid));
  if (!e) return null;
  const tree = readKv(e.kv, db.strings);
  const root = find(tree, 'appinfo')?.v ?? tree;
  const common = find(root, 'common')?.v;
  const launch = find(find(root, 'config')?.v || [], 'launch')?.v;
  if (!common || !launch) return null;
  return { entry: e, tree, common, launch };
}

// Writes an app's edited tree back into its entry: blob, size and binary SHA-1.
function commit(db, a) {
  a.entry.kv = writeKv(a.tree, db.strings);
  sha1(a.entry.kv).copy(a.entry.head, SHA1_AT);
}

// The edited file, after the checks: it parses, every SHA-1 matches, and only
// the apps in changed differ from before.
function save(db, before, changed) {
  const out = serialize(db);
  const after = load(out).entries;
  if (after.length !== before.entries.length) throw new Error('appinfo.vdf: the number of entries changed');
  const ids = new Set([...changed].map(Number));
  after.forEach((e, i) => {
    const b = before.entries[i];
    if (e.appid !== b.appid) throw new Error('appinfo.vdf: the order of entries changed');
    if (!ids.has(e.appid) && !(e.kv.equals(b.kv) && e.head.equals(b.head))) throw new Error(`appinfo.vdf: entry ${e.appid} changed and shouldn't have`);
    if (ids.has(e.appid) && !e.head.subarray(0, SHA1_AT).equals(b.head.subarray(0, SHA1_AT))) throw new Error(`appinfo.vdf: entry ${e.appid}'s header changed beyond its SHA-1`);
  });
  return out;
}

// Plain values for show/tests: { key: value | {..} }.
const plain = (nodes) => Object.fromEntries(nodes.map((n) => [n.k, n.t === T.SECTION ? plain(n.v) : String(n.v)]));

module.exports = { parse, serialize, readKv, writeKv, load, save, app, commit, find, clone, plain, sha1, T, MAGIC, HEAD, SHA1_AT };
