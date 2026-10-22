// Fill EC fields from any proposal by its own structure, not by one known template.
//
// Two general sources:
//   1. the document's headings (outline from loaders.js): the text under a heading whose
//      words mean the field, up to the next heading of the same or a higher level;
//   2. form rows "หัวข้อ | ค่า": a table row whose first cell names the field.
// A field already filled by the rules in extract.js is kept, except a long section that
// the rules cut short (they stop at the first sub-heading).
// Pure functions (no DOM), unit-tested in Node.

import { GENERIC, TEMPLATES } from "./heading-map.js";

// Field -> what its heading or row label says, from the heading library (heading-map.js).
// Anchored at the start of the heading text (after its number), so "ประชากร" does not
// match "การคำนวณขนาดประชากร...".
export const FIELD_HEADS = Object.entries(GENERIC.fields).map(([path, f]) => ({ path, type: f.type, re: f.heads.join("|") }));

const LEAD = /^[\s\-•*#>]*(?:(?:บทที่|chapter)\s*\d{1,2}\.?\s*[:：]?\s*|\d{1,2}(?:\.\d{1,2})*\.?\s*|[ก-ฮ]\.\s*|\(\d{1,2}\)\s*)?/i;
export const headWords = (t) => String(t || "").replace(LEAD, "").trim();
const rx = (src) => new RegExp(`^(?:${src})`, "iu");

// Headings that always start a new part of a proposal, whatever level Word gave them.
const MAJOR = GENERIC.breaks.join("|");
let breakRe = null;
const isBreak = (text) => (breakRe ||= new RegExp(`^(?:${MAJOR}|${FIELD_HEADS.map((f) => f.re).join("|")})`, "iu")).test(headWords(text));
const typedNo = (text) => (String(text).match(/^\s*(\d{1,2}(?:\.\d{1,2})*)\.?\s/) || [])[1] || null;

// Lines under a heading, up to the next heading of the same or a higher level, or the next
// heading that starts another part of a proposal (Word's levels are often inconsistent);
// a typed sub-number of this heading ("11.1" under "11. ...") never ends it.
export function sectionLines(lines, outline, k) {
  const h = outline[k];
  const no = typedNo(h.text);
  let end = lines.length;
  let listNext = 1; // typed "1.", "2.", ... right under the heading are list items
  for (let j = k + 1; j < outline.length; j++) {
    const o = outline[j];
    const sub = typedNo(o.text);
    if (no && sub && sub.startsWith(`${no}.`)) continue;
    if (o.kind === "list" && !isBreak(o.text)) continue; // a plain numbered list item
    if (sub && /^\d+$/.test(sub) && Number(sub) === listNext && !isBreak(o.text)) { listNext++; continue; }
    if (o.level <= h.level || isBreak(o.text)) { end = o.line; break; }
  }
  return lines.slice(h.line + 1, Math.min(end, h.line + 1 + 200))
    .map((l) => l.trim()).filter(Boolean);
}

// Form rows "11.1 ประชากรเป้าหมาย | นักศึกษา 40 คน": the value of a field whose label
// matches. Read from the table grid (a label cell may run over two lines). A row whose
// check box is empty ("[   ]") is an option not chosen; a ticked one keeps its text.
const BOX_EMPTY = /^\[\s*\]$|^☐$|^□$/;
const BOX_TICKED = /^\[\s*[/✓xX]\s*\]$|^[☑☒■✓✔]$/;
const PLACEHOLDER = /^[.\s…_\-–]*$|^\(.*\)$|^ระบุ\s*[.…]*$/;
function tableValue(tables, re) {
  const found = [];
  for (const t of tables || []) {
    for (const row of t) {
      const cells = [];
      for (const c of row) {
        const x = String(c.text || "").replace(/\s+/g, " ").trim();
        if (x && cells[cells.length - 1] !== x) cells.push(x);
      }
      if (cells.length < 2) continue;
      const label = headWords(cells[0]);
      if (label.length > 160 || !re.test(label)) continue;
      const rest = cells.slice(1);
      if (rest.some((c) => BOX_EMPTY.test(c))) continue;
      const kept = rest
        .filter((c) => !/^\[ \]/.test(c)) // an option whose box is empty
        .map((c) => c.replace(/^\[\/\]\s*/, ""))
        .filter((c) => !BOX_TICKED.test(c) && !PLACEHOLDER.test(c) && !GUIDANCE.test(c) && !/(?:…|\.{4,})\s*$/.test(c));
      if (HEADER_CELLS(kept) && kept.some((c) => /\([A-Za-z][A-Za-z ]+\)/.test(c))) continue;
      const value = kept.join(" ");
      if (value && !found.includes(value)) found.push(value);
    }
  }
  return found.join("\n");
}

const listItems = (ls) => ls.map((l) => l.replace(/^[\s\-•*]*(?:\[\d{1,2}\]\s*|\(?\d{1,2}[.)]\s*|[ก-ฮ][.)]\s*)?/, "").trim()).filter(Boolean);
const get = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
function set(o, p, v) {
  const ks = p.split(".");
  let x = o;
  ks.slice(0, -1).forEach((k) => { if (x[k] == null || typeof x[k] !== "object") x[k] = {}; x = x[k]; });
  x[ks[ks.length - 1]] = v;
}
const empty = (v) => v == null || (Array.isArray(v) ? !v.length : !String(v).trim());
const bare = (v) => String(v || "").replace(/\[\[(?:รูป|ตาราง) \d+\]\]/g, "").replace(/\s+/g, " ").trim();

// The heading of the outline that best names this field: the first whose words start with it.
export function findHeading(outline, field) {
  const re = rx(field.re);
  return outline.findIndex((h) => re.test(headWords(h.text)));
}

// Guidance printed in blank forms ("ระบุสาขา ได้แก่ ... เป็นต้น", "(ทำเครื่องหมาย / ...)"),
// not an answer.
const GUIDANCE = /^\(?(?:ระบุ|ทำเครื่องหมาย|หมายเหตุ|โปรดระบุ|กรุณาระบุ|อธิบายว่า|เขียน|ให้ระบุ|เพิ่มบรรทัด)|(?:เป็นต้น|ถ้ามี)\)?\s*$|ระบุ(?:ห้อง|สาขา|รายละเอียด|ชื่อ)|^\s*\{\{.*\}\}\s*$|^\(?(?:clearly )?(?:specify|provide|describe|indicate|state|list|explain|please|note:|mark)\b/i;
// a row of column titles: every cell a short label, often "ไทย (English)"
const HEADER_CELLS = (cells) => cells.length >= 2 && cells.every((c) => c.length <= 45 && !/\d/.test(c));

// Value of a field from the section under heading k, in the field's own type. Table rows
// under the heading are left to the row reader (they belong to sub-fields of a form).
// "วิธี: [ / ] ลงลายมือชื่อ  [   ] ด้วยวาจา" -> "วิธี: ลงลายมือชื่อ" (only ticked options stay)
export function ticked(line) {
  if (!/\[\s*[/✓xX]?\s*\]|[☐☑☒]/.test(line)) return line;
  const parts = line.split(/(\[\s*[/✓xX]?\s*\]|[☐☑☒])/);
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    if (/[/✓xX☑☒]/.test(parts[i])) out += ` ${parts[i + 1] || ""}`;
  }
  return out.replace(/\s+/g, " ").trim();
}

// `opts` (from a template of heading-map.js): keepRows takes the table rows under the
// heading as the content ("ด้านเศรษฐกิจ | 1. ..." -> "ด้านเศรษฐกิจ: 1. ..."); skip drops lines.
export function valueFromSection(lines, outline, k, type, inTable = new Set(), opts = {}) {
  const skip = (opts.skip || []).map((r) => new RegExp(r, "iu"));
  const body = sectionLines(lines, outline, k)
    .filter((l) => !/^\[\[/.test(l) && !GUIDANCE.test(l) && !skip.some((r) => r.test(l))
      && (opts.keepRows || (!l.includes(" | ") && !inTable.has(l.replace(/\s+/g, " ")))))
    .map((l) => (opts.keepRows ? [...new Set(l.split(" | ").map((c) => c.trim()).filter(Boolean))].join(": ") : l))
    .map(ticked).filter(Boolean);
  if (!body.length) return null;
  if (type === "list") return listItems(body);
  if (type === "count") return countFrom(body.join(" "));
  if (type === "text") return body[0].length <= 200 ? body[0] : null;
  const v = body.join("\n");
  return v.length >= 25 ? v : null;
}

// "110 คน", "n = 500 รายการ" -> 110 / 500
function countFrom(t) {
  const m = String(t).match(/(?:n\s*=\s*)?(\d{1,3}(?:,\d{3})*|\d+)\s*(?:คน|ราย(?!การ)|ท่าน|people|participants|subjects|รายการ|ตัวอย่าง|ชุด)?/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return n > 0 && n < 1e7 ? n : null;
}

// Fills the empty fields (and long sections the rules cut short); returns { path: source }
// with source = { heading: k } or { row: true } for the page to show where a value came from.
export function fillFromOutline(s, text, outline = [], tables = []) {
  const lines = String(text || "").split("\n");
  const sources = {};
  // lines that are the inside of a table cell (a cell over several lines leaves its later
  // lines without " | " in the text)
  const inTable = new Set();
  for (const t of tables || []) for (const row of t) for (const c of row) {
    for (const l of String(c.text || "").split("\n")) if (l.trim()) inTable.add(l.trim().replace(/\s+/g, " "));
  }
  for (const field of FIELD_HEADS) {
    const cur = get(s, field.path);
    const k = outline.length ? findHeading(outline, field) : -1;
    // a form row names its field exactly, so it goes first; then the heading's section
    let value = null;
    let source = null;
    const v = tableValue(tables, rx(field.re));
    if (v) {
      value = field.type === "list" ? listItems(v.split(/\s*[;•]\s*|\s+(?=\d{1,2}[.)]\s)/))
        : field.type === "count" ? countFrom(v)
          : field.type === "area" && v.length < 25 && !/\d/.test(v) ? null : v;
      source = { row: true };
    }
    if (empty(value) && k >= 0) {
      value = valueFromSection(lines, outline, k, field.type, inTable);
      source = { heading: k };
    }
    if (empty(value)) continue;
    if (empty(cur)) {
      set(s, field.path, value);
      sources[field.path] = source;
    } else if (field.type === "area" && typeof cur === "string" && !cur.includes("[[")) {
      // the rules stopped at the first sub-heading: take the whole section when it is the
      // same text and clearly longer
      const a = bare(cur), b = bare(value);
      if (b.length > a.length * 1.5 && b.includes(a.slice(0, 40))) {
        set(s, field.path, value);
        sources[field.path] = source;
      }
    }
  }
  // a risk described in the file means that kind of risk is there (its detail box is shown
  // only when the yes/no answer is yes)
  for (const k of ["physical", "psychological", "social", "economic"]) {
    const d = sources[`risks.${k}_detail`] && get(s, `risks.${k}_detail`);
    if (d && !/^(?:ไม่มี|none|no\b|n\/a)/i.test(String(d).trim())) set(s, `risks.${k}`, true);
  }
  // a known grant form: its own headings replace the guesses (heading-map.js TEMPLATES)
  const tpl = detectTemplate(outline, lines);
  if (tpl) {
    Object.defineProperty(s, "_template", { value: { id: tpl.id, name: tpl.name }, enumerable: false, configurable: true });
    for (const [path, f] of Object.entries(tpl.fields || {})) {
      const re = rx(f.heads.join("|"));
      const k = outline.findIndex((h) => re.test(headWords(h.text)));
      const value = k >= 0 ? valueFromSection(lines, outline, k, f.type, inTable, f) : null;
      if (empty(value)) continue;
      set(s, path, value);
      sources[path] = { heading: k, template: tpl.id };
    }
    for (const path of tpl.none || []) {
      const cur = get(s, path);
      set(s, path, Array.isArray(cur) ? [] : typeof cur === "number" ? null : "");
      delete sources[path];
    }
  }
  return sources;
}

// The grant form a file is written on: the template of heading-map.js with the most of its
// own headings in the file (at least its `min`), or null. Short lines of the text count too:
// a PDF's outline only has its numbered headings.
export function detectTemplate(outline = [], lines = []) {
  const heads = [...outline.map((h) => h.text), ...lines.filter((l) => l.trim().length <= 120)];
  let best = null;
  for (const t of TEMPLATES) {
    const n = t.detect.filter((d) => { const re = new RegExp(d, "iu"); return heads.some((h) => re.test(h)); }).length;
    if (n >= t.min && (!best || n > best.n)) best = { t, n };
  }
  return best ? best.t : null;
}
