// A game's "Play in VR" Steam launch option, for standalone headsets such as
// the Steam Frame, which start a PC game from their library with one of its
// launch options (dvr-package SPEC section 3, mod.json vrLaunch, 0.1.6).
//
// The Frame lists its OWN copy of the game's options, with Valve's ids, and
// sends the chosen id; the PC runs its entry with that id (0 if it has none).
// So every existing id keeps its meaning, and VR is 0:
// - the original option 0 moves, otherwise untouched, to a new id (the
//   highest id + 1: 1 for Death's Door, 5 for Timberborn); it gets the
//   description "Play flat" only if it had none;
// - ours is written at 0: type "vr", the original's executable and config
//   (oslist set to windows, osarch kept), arguments = the original's, then the
//   game's launchArgs and vrLaunch.args ("-force-d3d11 -dvr-vr"),
//   "Play in VR (DioramaVR)";
// - common/openvrsupport = 1.
// Uninstall takes exactly that back, from what install recorded (the new id,
// whether "Play flat" was added, openvrsupport's value before): our 0 goes,
// the original returns to 0 in its place, openvrsupport is as it was.
//
// What we want per game is kept in <cache>/vr-launch.json, because Steam's
// file can only change while Steam is closed: install and uninstall only
// record it, and sync() applies it then (at start, or when the player agrees
// to close Steam). Steam replaces an app's entry when Valve updates the app;
// sync() notices our option is gone and adds it again.
'use strict';
const fs = require('fs');
const path = require('path');
const ai = require('./appinfo');
const steam = require('./steam');
const { cacheRoot } = require('./uevr');

const DESC = 'Play in VR (DioramaVR)';
const FLAT = 'Play flat';
const BACKUPS_KEPT = 2;
const { T, find, clone } = ai;

const stateFile = () => path.join(cacheRoot(), 'vr-launch.json');
const appinfoFile = (steamDir) => path.join(steamDir, 'appcache', 'appinfo.vdf');

function readState() {
  try {
    const d = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}
function writeState(s) {
  fs.mkdirSync(cacheRoot(), { recursive: true });
  const tmp = `${stateFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, stateFile());
}

// The game's part of the VR command line: launchArgs, then vrLaunch.args.
const gameArgs = (mod) => [mod.launchArgs, mod.vrLaunch?.args].map((x) => (x || '').trim()).filter(Boolean).join(' ');
// Joins argument strings, leaving out a word already there (the original
// option may already pass -force-d3d11).
function joinArgs(...parts) {
  const out = [];
  for (const w of parts.join(' ').split(/\s+/).filter(Boolean)) if (!out.includes(w)) out.push(w);
  return out.join(' ');
}
// Steam's launch executables are relative to the game folder, with backslashes.
const steamExe = (exe) => exe.replace(/\//g, '\\');

// Install: the game should get the mod's VR option (no vrLaunch: it shouldn't).
function want(mod) {
  const s = readState();
  const key = String(mod.appid);
  if (!mod.vrLaunch) {
    if (s[key]) { s[key].want = false; writeState(s); }
    return null;
  }
  s[key] = { ...(s[key] || {}), modId: mod.id, want: true, exe: steamExe(mod.exe), gameArgs: gameArgs(mod) };
  writeState(s);
  return s[key];
}

// Uninstall: take the game's VR option back out.
function unwant(appid) {
  const s = readState();
  const key = String(appid);
  if (!s[key]) return;
  s[key].want = false;
  writeState(s);
}

const str = (node, k) => { const n = find(node.v, k); return n && n.t === T.STRING ? n.v : undefined; };
const isOurs = (node) => node.t === T.SECTION && str(node, 'description') === DESC && str(node, 'type') === 'vr';

// Our option 0, made from the original option 0 (null: the game had none).
function vrNode(rec, original) {
  const config = original ? clone(find(original.v, 'config')?.v || []) : [];
  const os = find(config, 'oslist');
  if (os) { os.t = T.STRING; os.v = 'windows'; } else config.unshift({ t: T.STRING, k: 'oslist', v: 'windows' });
  const exe = (original && str(original, 'executable')) || rec.exe;
  const args = joinArgs(original ? str(original, 'arguments') || '' : '', rec.gameArgs);
  const v = [{ t: T.STRING, k: 'executable', v: exe }];
  if (args) v.push({ t: T.STRING, k: 'arguments', v: args });
  v.push({ t: T.STRING, k: 'description', v: DESC }, { t: T.STRING, k: 'type', v: 'vr' }, { t: T.SECTION, k: 'config', v: config });
  return { t: T.SECTION, k: '0', v };
}

const moved = (a, rec) => (rec.movedTo ? a.launch.find((n) => n.k === rec.movedTo && !isOurs(n)) || null : null);
const same = (x, y) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? `${v}n` : v)) === JSON.stringify(y, (k, v) => (typeof v === 'bigint' ? `${v}n` : v));

// Our option is at 0 but this installer didn't record putting it there (the
// first Frame tests were edited by hand, the same way): take over that edit,
// with the "Play flat" option as the moved original and openvrsupport as Valve
// leaves it for a flat game (not set).
function adopt(a, rec) {
  if ('movedTo' in rec) return false;
  const l0 = find(a.launch, '0');
  if (!l0 || !isOurs(l0)) return false;
  const flat = a.launch.filter((n) => !isOurs(n) && str(n, 'description') === FLAT).pop();
  rec.movedTo = flat ? flat.k : null;
  rec.addedFlatDescription = !!flat;
  rec.openvrsupportBefore = null;
  return true;
}

// Is the app's entry as rec wants it?
function inEffect(a, rec) {
  const ours = a.launch.filter(isOurs);
  if (!rec.want) return ours.length === 0;
  const l0 = find(a.launch, '0');
  const ov = find(a.common, 'openvrsupport');
  return ours.length === 1 && l0 === ours[0] && same(l0, vrNode(rec, moved(a, rec))) && !!ov && String(ov.v) === '1';
}

// Adds (or corrects) our option 0 in an app's tree, recording in rec what
// uninstall needs to take it back.
function apply(a, rec) {
  const L = a.launch;
  for (let i = L.length - 1; i >= 0; i--) if (isOurs(L[i]) && L[i].k !== '0') L.splice(i, 1);
  const i0 = L.findIndex((n) => n.k === '0');
  if (i0 >= 0 && isOurs(L[i0])) {
    L[i0] = vrNode(rec, moved(a, rec));             // ours already: bring it up to date
  } else {
    // A fresh entry (first install, or Steam replaced it): record everything anew.
    const original = i0 >= 0 ? L[i0] : null;
    const ours = vrNode(rec, original);
    if (original) {
      const ids = L.map((n) => Number(n.k)).filter((x) => Number.isInteger(x) && x >= 0);
      rec.movedTo = String(Math.max(...ids) + 1);
      original.k = rec.movedTo;
      rec.addedFlatDescription = str(original, 'description') === undefined && !find(original.v, 'description');
      if (rec.addedFlatDescription) {
        const ti = original.v.findIndex((n) => n.k === 'type' || n.k === 'config');
        original.v.splice(ti < 0 ? original.v.length : ti, 0, { t: T.STRING, k: 'description', v: FLAT });
      }
      L[i0] = ours;
      L.push(original);
    } else {
      rec.movedTo = null;
      rec.addedFlatDescription = false;
      L.unshift(ours);
    }
    const ov = find(a.common, 'openvrsupport');
    rec.openvrsupportBefore = ov ? { t: ov.t, v: String(ov.v) } : null;
  }
  const ov = find(a.common, 'openvrsupport');
  if (ov) { if (ov.t === T.STRING) ov.v = '1'; else { ov.t = T.INT; ov.v = 1; } } else a.common.push({ t: T.INT, k: 'openvrsupport', v: 1 });
}

// Takes our option back out: the original returns to 0, where ours was.
function remove(a, rec) {
  const L = a.launch;
  const at0 = () => L.findIndex((n) => n.k === '0' && isOurs(n));
  const hadOurs = at0() >= 0;
  for (let i = L.length - 1; i >= 0; i--) if (isOurs(L[i]) && i !== at0()) L.splice(i, 1);
  if (!hadOurs) return;                  // Steam has replaced the entry: it's Valve's again
  const m = moved(a, rec);
  if (m) {
    L.splice(L.indexOf(m), 1);
    m.k = '0';
    if (rec.addedFlatDescription) {
      const di = m.v.findIndex((n) => n.k === 'description' && n.v === FLAT);
      if (di >= 0) m.v.splice(di, 1);
    }
    L[at0()] = m;
  } else L.splice(at0(), 1);
  const ovi = a.common.findIndex((n) => n.k === 'openvrsupport');
  const before = rec.openvrsupportBefore;
  if (before === null) { if (ovi >= 0) a.common.splice(ovi, 1); } else if (before) {
    const n = ovi >= 0 ? a.common[ovi] : (a.common.push({ k: 'openvrsupport' }), a.common[a.common.length - 1]);
    n.t = before.t;
    n.v = before.t === T.STRING ? before.v : before.t === T.UINT64 ? BigInt(before.v) : Number(before.v);
  }
}

let last = {};         // appid -> 'on' | 'pending' | 'not-in-steam', from the last sync()
let lastPending = [];  // appids (adds and removals) waiting for Steam to close

// Brings Steam's file in line with what's wanted. Reads it either way; writes
// only when Steam isn't running (else those apps are pending). Returns
// { applied, removed, adopted, pending, notInSteam, steamRunning, backup }.
function sync({ steamDir = steam.findSteam(), running = steam.steamRunning() } = {}) {
  const s = readState();
  const out = { applied: [], removed: [], adopted: [], pending: [], notInSteam: [], steamRunning: !!running, backup: null };
  const keys = Object.keys(s);
  last = {};
  lastPending = [];
  if (!keys.length) return out;
  const file = steamDir && appinfoFile(steamDir);
  if (!file || !fs.existsSync(file)) {
    out.notInSteam = keys.filter((k) => s[k].want);
    for (const k of out.notInSteam) last[k] = 'not-in-steam';
    return out;
  }
  const buf = fs.readFileSync(file);
  // Deciding needs only a parse; before anything is edited the whole file must
  // round-trip exactly (load), else it's left alone.
  const db = ai.parse(buf);
  const before = ai.parse(buf);
  let verified = false;
  const changed = new Set();
  for (const key of keys) {
    const rec = s[key];
    const a = ai.app(db, key);
    if (!a) {
      if (rec.want) { out.notInSteam.push(key); last[key] = 'not-in-steam'; } else delete s[key];
      continue;
    }
    const adopted = adopt(a, rec);
    if (inEffect(a, rec)) {
      if (rec.want) last[key] = 'on'; else delete s[key];
      if (adopted) out.adopted.push(key);
      continue;
    }
    if (running) { out.pending.push(key); if (rec.want) last[key] = 'pending'; continue; }
    if (!verified) { ai.load(buf); verified = true; }
    if (rec.want) { apply(a, rec); out.applied.push(key); last[key] = 'on'; } else { remove(a, rec); out.removed.push(key); delete s[key]; }
    ai.commit(db, a);
    changed.add(key);
  }
  if (changed.size) {
    if (steam.steamRunning()) throw new Error('Steam started while the launch options were being changed; nothing was written');
    const data = ai.save(db, before, changed);
    out.backup = backup(file);
    const tmp = `${file}.dvr-tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
    if (!fs.readFileSync(file).equals(data)) throw new Error('appinfo.vdf: what was written reads back differently');
  }
  writeState(s);
  lastPending = out.pending;
  return out;
}

// appinfo.vdf.dvr-<time>.bak next to it, before every write; only the newest
// BACKUPS_KEPT of ours are kept (the file is large).
function backup(file) {
  const bak = `${file}.dvr-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  fs.copyFileSync(file, bak);
  const dir = path.dirname(file);
  const base = path.basename(file);
  const ours = fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.dvr-`) && n.endsWith('.bak')).sort();
  for (const n of ours.slice(0, Math.max(0, ours.length - BACKUPS_KEPT))) fs.rmSync(path.join(dir, n), { force: true });
  return bak;
}

// What the last sync() found, per appid: 'on' | 'pending' | 'not-in-steam'.
const state = (appid) => last[String(appid)] || null;
// Apps whose wanted change waits for Steam to close.
const pending = () => lastPending.slice();

module.exports = { DESC, FLAT, want, unwant, sync, state, pending, gameArgs, joinArgs, steamExe, readState, appinfoFile, _apply: apply, _remove: remove, _inEffect: inEffect };
