// BepInEx .cfg files: INI-style "[Section]" headers and "Key = value" lines.
// Edits keep every other line (comments, other keys) as it was. A key we set
// in a file BepInEx hasn't written yet is kept when it creates the rest.
const fs = require('fs');
const path = require('path');

function formatValue(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

// values: { "Section": { Key: value } }
function setValues(text, values) {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [section, keys] of Object.entries(values)) {
    for (const [key, raw] of Object.entries(keys)) {
      const line = `${key} = ${formatValue(raw)}`;
      let start = lines.findIndex((l) => l.trim() === `[${section}]`);
      if (start < 0) {
        if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
        lines.push(`[${section}]`, '', line);
        continue;
      }
      let end = start + 1;
      while (end < lines.length && !/^\s*\[.*\]\s*$/.test(lines[end])) end++;
      const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
      const at = lines.slice(start + 1, end).findIndex((l) => keyRe.test(l));
      if (at >= 0) lines[start + 1 + at] = line;
      else {
        let insert = end;
        while (insert > start + 1 && lines[insert - 1].trim() === '') insert--;
        lines.splice(insert, 0, line);
      }
    }
  }
  return lines.join('\r\n') + '\r\n';
}

function readValues(text) {
  const out = {};
  let section = null;
  for (const l of text.split(/\r?\n/)) {
    const s = l.match(/^\s*\[(.+)\]\s*$/);
    if (s) { section = s[1]; out[section] = out[section] || {}; continue; }
    const kv = l.match(/^\s*([^#=][^=]*?)\s*=\s*(.*?)\s*$/);
    if (kv && section) out[section][kv[1]] = kv[2];
  }
  return out;
}

function writeFile(file, values) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, setValues(before, values));
}

module.exports = { setValues, readValues, writeFile, formatValue };
