// Options every mod is expected to offer. A mod's mod.json maps each of these
// it supports to its own config key under "sharedOptions"; mod-only options
// are listed in full under "options".
const SHARED = [
  { id: 'leftHanded', label: 'Left-handed', help: 'Point and click with the left controller.', type: 'bool', default: false },
  { id: 'eyeResolution', label: 'Eye resolution', help: 'Lower it if the headset view stutters.', type: 'number', default: 1.0, min: 0.5, max: 1.5, step: 0.05, unit: '%', scale: 100 },
];

// Full option list for one mod: shared ones it maps, then its own.
function forMod(mod) {
  const out = [];
  for (const s of SHARED) {
    const map = mod.sharedOptions?.[s.id];
    if (!map) continue;
    out.push({ ...s, shared: true, default: map.default ?? s.default, cfg: { section: map.section, key: map.key } });
  }
  for (const o of mod.options || []) out.push({ ...o, shared: false });
  return out;
}

function coerce(opt, v) {
  if (v === undefined || v === null || v === '') return opt.default;
  if (opt.type === 'bool') return v === true || v === 'true' || v === '1' || v === 1;
  if (opt.type === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${opt.id} must be a number`);
    return Math.min(opt.max ?? n, Math.max(opt.min ?? n, n));
  }
  if (opt.type === 'choice') {
    if (!opt.choices.some((c) => c.value === v)) throw new Error(`${opt.id} must be one of ${opt.choices.map((c) => c.value).join(', ')}`);
    return v;
  }
  return v;
}

// chosen: { optionId: value } -> { values: {id: v}, cfg: { Section: { Key: v } } }
function resolve(mod, chosen = {}) {
  const values = {};
  const cfg = {};
  for (const opt of forMod(mod)) {
    const v = coerce(opt, chosen[opt.id]);
    values[opt.id] = v;
    (cfg[opt.cfg.section] ||= {})[opt.cfg.key] = v;
  }
  return { values, cfg };
}

module.exports = { SHARED, forMod, resolve };
