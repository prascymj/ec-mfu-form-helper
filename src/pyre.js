// Python `re` / `str` behaviour in JavaScript, for a line-by-line port of
// ec_mfu/local_extractor.py. Python's \w \d \b are Unicode-aware (Thai letters
// are word characters, Thai digits are digits); JavaScript's are ASCII-only even
// with the u flag, so patterns are translated before compiling.

const W = "\\p{L}\\p{N}_";
const WB = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;

// Translate a Python pattern source to a JS (u-mode) source.
export function pySource(src) {
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1];
      i++;
      if (n === "w") out += inClass ? W : `[${W}]`;
      else if (n === "W") out += inClass ? "\\P{L}\\P{N}" : `[^${W}]`;
      else if (n === "d") out += "\\p{Nd}";
      else if (n === "b" && !inClass) out += WB;
      else if (n === "-" && !inClass) out += "-";
      else if (/[A-Za-z0-9]/.test(n) || "\\^$.|?*+()[]{}/-".includes(n)) out += "\\" + n;
      else out += n; // Python allows escaping any punctuation; u-mode does not
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      out += c;
      continue;
    }
    if (c === "[") {
      inClass = true;
      out += c;
      if (src[i + 1] === "^") { out += "^"; i++; }
      if (src[i + 1] === "]") { out += "\\]"; i++; }
      continue;
    }
    out += c;
  }
  return out;
}

const cache = new Map();
// flags: "i" (IGNORECASE), "m" (MULTILINE)
export function rx(src, flags = "", extra = "") {
  const key = `${src}\u0000${flags}${extra}`;
  let r = cache.get(key);
  if (!r) {
    r = new RegExp(pySource(src), `u${flags}${extra}`);
    cache.set(key, r);
  }
  return r;
}

// re.search -> {index, end, 0..n groups} | null
export function search(src, text, flags = "") {
  const m = rx(src, flags).exec(text);
  if (!m) return null;
  m.end = m.index + m[0].length;
  return m;
}

// re.match (anchored at position 0)
export function match(src, text, flags = "") {
  const r = rx(src, flags, "y");
  r.lastIndex = 0;
  const m = r.exec(text);
  if (m) m.end = m.index + m[0].length;
  return m;
}

export function sub(src, repl, text, flags = "") {
  return text.replace(rx(src, flags, "g"), repl);
}

export function split(src, text, flags = "", maxsplit = 0) {
  if (!maxsplit) return text.split(rx(src, flags, "g"));
  const r = rx(src, flags, "g");
  r.lastIndex = 0;
  const out = [];
  let last = 0;
  let m;
  while (out.length < maxsplit && (m = r.exec(text))) {
    if (m[0] === "" ) { r.lastIndex++; continue; }
    out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

// str.strip / lstrip / rstrip with an optional character set (Python semantics)
const WS = " \t\n\r\v\f\u001c\u001d\u001e\u001f\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
export function lstrip(s, chars = WS) {
  let i = 0;
  while (i < s.length && chars.includes(s[i])) i++;
  return s.slice(i);
}
export function rstrip(s, chars = WS) {
  let j = s.length;
  while (j > 0 && chars.includes(s[j - 1])) j--;
  return s.slice(0, j);
}
export const strip = (s, chars = WS) => rstrip(lstrip(s, chars), chars);

// str.splitlines()
export const splitlines = (s) => {
  if (!s) return [];
  const parts = s.split(/\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/);
  if (parts.length && parts[parts.length - 1] === "" && /(\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029])$/.test(s)) parts.pop();
  return parts;
};

// int() / float() over Unicode digits (Thai ๐-๙ included)
const toAscii = (s) => s.replace(/\p{Nd}/gu, (d) => {
  const cp = d.codePointAt(0);
  if (cp >= 0x0e50 && cp <= 0x0e59) return String(cp - 0x0e50);
  return /\d/.test(d) ? d : String(Number.parseInt(d, 10));
});
export function pyInt(s) {
  if (s == null) return null;
  const t = toAscii(String(s)).trim();
  return /^[+-]?\d+$/.test(t) ? Number.parseInt(t, 10) : null;
}
export function pyFloat(s) {
  if (s == null) return null;
  const t = toAscii(String(s)).trim();
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : null;
}

export const reEscapeDot = (s) => s.replace(/\./g, "\\.");
