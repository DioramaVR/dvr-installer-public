// Valve's KeyValues formats: the text one (libraryfolders.vdf, appmanifest_*.acf,
// loginusers.vdf) and the binary one (userdata/<id>/config/shortcuts.vdf).

// Text VDF -> nested plain objects. Keys keep their case; values are strings.
function parseText(text) {
  let i = 0;
  const n = text.length;

  function skip() {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') i++;
      else if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; }
      else break;
    }
  }

  function token() {
    skip();
    if (i >= n) return null;
    const c = text[i];
    if (c === '{' || c === '}') { i++; return { brace: c }; }
    let s = '';
    if (c === '"') {
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const e = text[++i];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
        } else s += text[i];
        i++;
      }
      i++;
    } else {
      while (i < n && !/[\s{}"]/.test(text[i])) s += text[i++];
    }
    return { str: s };
  }

  function block() {
    const obj = {};
    for (;;) {
      const k = token();
      if (!k || k.brace === '}') return obj;
      const v = token();
      if (!v) return obj;
      obj[k.str] = v.brace === '{' ? block() : v.str;
    }
  }

  return block();
}

// Binary VDF type bytes.
const MAP = 0x00, STRING = 0x01, INT32 = 0x02, END = 0x08;

// Binary VDF -> nested objects. Int32 values come back as { int: n } so a
// round trip writes them with the same type they had.
function parseBinary(buf) {
  let i = 0;
  function cstr() {
    const end = buf.indexOf(0, i);
    if (end < 0) throw new Error('Truncated binary VDF');
    const s = buf.toString('utf8', i, end);
    i = end + 1;
    return s;
  }
  function map() {
    const obj = {};
    while (i < buf.length) {
      const type = buf[i++];
      if (type === END) return obj;
      const key = cstr();
      if (type === MAP) obj[key] = map();
      else if (type === STRING) obj[key] = cstr();
      else if (type === INT32) { obj[key] = { int: buf.readInt32LE(i) }; i += 4; }
      else throw new Error(`Unsupported binary VDF type 0x${type.toString(16)} at byte ${i - 1}`);
    }
    return obj;
  }
  return map();
}

function serializeBinary(obj) {
  const parts = [];
  const str = (s) => parts.push(Buffer.from(s, 'utf8'), Buffer.from([0]));
  function map(o) {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string') { parts.push(Buffer.from([STRING])); str(k); str(v); }
      else if (typeof v === 'number' || (v && typeof v.int === 'number')) {
        const b = Buffer.alloc(4);
        b.writeInt32LE((typeof v === 'number' ? v : v.int) | 0);
        parts.push(Buffer.from([INT32])); str(k); parts.push(b);
      } else if (v && typeof v === 'object') { parts.push(Buffer.from([MAP])); str(k); map(v); }
      else throw new Error(`Can't write ${k}=${v} to binary VDF`);
    }
    parts.push(Buffer.from([END]));
  }
  map(obj);
  return Buffer.concat(parts);
}

module.exports = { parseText, parseBinary, serializeBinary };
