// Proposal file -> plain text, in the browser (and in Node for tests).
// Port of ec_mfu/extractor.py load_text(): same reading order and the same
// table flattening as python-docx, so the rule extractor sees identical text.
//
//   .docx  own zip + XML reader (no library), body walked like python-docx
//   .pdf   pdf.js, loaded on demand from cdnjs (the file itself never leaves the page)
//   .md / .txt  read as UTF-8

const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

// ---------------------------------------------------------------- zip

async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

// Read one entry from a zip archive via its central directory.
export async function unzipEntry(buf, wanted) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ไม่ใช่ไฟล์ .docx ที่ถูกต้อง (อ่าน zip ไม่ได้)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      const lNameLen = dv.getUint16(local + 26, true);
      const lExtraLen = dv.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      const data = u8.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new Error(`zip method ${method} not supported`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// ---------------------------------------------------------------- xml

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e];
  });
}

// Minimal well-formed XML -> {name, attrs, children[]} ; text nodes are {text}.
export function parseXml(xml) {
  const root = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.children.push({ text: m[1] });
    else if (m[2]) stack.pop();
    else if (m[3]) {
      const attrs = {};
      const ar = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4] || ""))) attrs[a[1]] = decodeEntities(a[3] ?? a[4]);
      const el = { name: m[3], attrs, children: [] };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) top.children.push({ text: decodeEntities(m[6]) });
  }
  return root;
}

const kids = (el, name) => el.children.filter((c) => c.name === name);
const kid = (el, name) => el.children.find((c) => c.name === name);
const innerText = (el) => el.children.map((c) => (c.text !== undefined ? c.text : innerText(c))).join("");

// ---------------------------------------------------------------- docx text (python-docx rules)

function runText(r) {
  let s = "";
  for (const c of r.children) {
    switch (c.name) {
      case "w:t": s += innerText(c); break;
      case "w:tab": case "w:ptab": s += "\t"; break;
      case "w:br": s += (c.attrs["w:type"] || "textWrapping") === "textWrapping" ? "\n" : ""; break;
      case "w:cr": s += "\n"; break;
      case "w:noBreakHyphen": s += "-"; break;
      default: break;
    }
  }
  return s;
}

function paraText(p) {
  let s = "";
  for (const c of p.children) {
    if (c.name === "w:r") s += runText(c);
    else if (c.name === "w:hyperlink") s += kids(c, "w:r").map(runText).join("");
  }
  return s;
}

const cellText = (tc) => kids(tc, "w:p").map(paraText).join("\n");

function gridSpan(tc) {
  const v = kid(kid(tc, "w:tcPr") || { children: [] }, "w:gridSpan");
  return v ? Number(v.attrs["w:val"] || 1) : 1;
}
function vMerge(tc) {
  const v = kid(kid(tc, "w:tcPr") || { children: [] }, "w:vMerge");
  if (!v) return null;
  return v.attrs["w:val"] || "continue";
}

// Rows as arrays of the root <w:tc> per grid column (vMerge "continue" -> cell above).
function tableGrid(tbl) {
  const rows = [];
  for (const tr of kids(tbl, "w:tr")) {
    const before = Number(kid(kid(tr, "w:trPr") || { children: [] }, "w:gridBefore")?.attrs["w:val"] || 0);
    const cells = [];
    let col = before;
    for (const tc of kids(tr, "w:tc")) {
      const span = gridSpan(tc);
      let root = tc;
      if (vMerge(tc) === "continue") {
        const above = rows.length ? rows[rows.length - 1].byCol[col] : null;
        root = above || tc;
      }
      for (let k = 0; k < span; k++) cells.push({ col: col + k, tc: root });
      col += span;
    }
    const byCol = {};
    cells.forEach((c) => { byCol[c.col] = c.tc; });
    rows.push({ cells: cells.map((c) => c.tc), byCol });
  }
  return rows;
}

function tableToLines(tbl) {
  const lines = [];
  for (const row of tableGrid(tbl)) {
    const cells = [];
    for (const tc of row.cells) {
      let t = cellText(tc).trim();
      for (const nt of kids(tc, "w:tbl")) t = (t ? t + " " : "") + tableToLines(nt).join(" ; ");
      if (t) cells.push(t);
    }
    const dedup = [];
    for (const c of cells) if (!dedup.length || dedup[dedup.length - 1] !== c) dedup.push(c);
    if (dedup.length) lines.push(dedup.join(" | "));
  }
  return lines;
}

// Tables as grids, for things the flat text loses (Gantt charts: empty cells and repeated
// marks are dropped from the text). Each row is an array over grid columns of
// { text, shaded } (a merged cell repeats in every column it covers).
function cellShaded(tc) {
  const shd = kid(kid(tc, "w:tcPr") || { children: [] }, "w:shd");
  if (!shd) return false;
  const fill = (shd.attrs["w:fill"] || "").toLowerCase();
  return Boolean(fill) && !["auto", "ffffff", "none"].includes(fill);
}

// Check boxes drawn with a Wingdings symbol (w:sym) carry no text, so the table grid writes
// them as "[/]" (ticked) or "[ ]" (empty); the flat text keeps python-docx's reading.
const SYM_TICKED = new Set(["F0FE", "F0FD", "F078", "F0FC", "F052", "F054", "F0D6"]);
const SYM_EMPTY = new Set(["F0A8", "F06F", "F071", "F0A3", "F030", "F0A1"]);
function runTextBoxes(r) {
  let s = "";
  for (const c of r.children) {
    if (c.name === "w:sym") {
      const ch = String(c.attrs["w:char"] || "").toUpperCase();
      s += SYM_TICKED.has(ch) ? "[/] " : SYM_EMPTY.has(ch) ? "[ ] " : "";
    } else s += runText({ children: [c] });
  }
  return s;
}
const cellTextBoxes = (tc) => kids(tc, "w:p").map((p) => p.children.map((c) => (c.name === "w:r" ? runTextBoxes(c)
  : c.name === "w:hyperlink" ? kids(c, "w:r").map(runTextBoxes).join("") : "")).join("")).join("\n");

function collectTables(el, out) {
  for (const c of el.children || []) {
    if (c.name === "w:tbl") {
      const grid = tableGrid(c).map((row) => row.cells.map((tc) => ({ text: cellTextBoxes(tc).trim(), shaded: cellShaded(tc) })));
      out.push(grid);
      for (const tr of kids(c, "w:tr")) for (const tc of kids(tr, "w:tc")) collectTables(tc, out);
    } else if (c.children && c.name !== "w:p") collectTables(c, out);
  }
  return out;
}

export function docxXmlToTables(xml) {
  const doc = parseXml(xml);
  const body = kid(kid(doc, "w:document") || doc, "w:body");
  return body ? collectTables(body, []) : [];
}

export function docxXmlToText(xml) {
  const doc = parseXml(xml);
  const body = kid(kid(doc, "w:document") || doc, "w:body");
  if (!body) return "";
  const parts = [];
  for (const c of body.children) {
    if (c.name === "w:p") {
      const t = paraText(c);
      if (t.trim()) parts.push(t);
    } else if (c.name === "w:tbl") parts.push(...tableToLines(c));
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------- docx outline (headings)

// Headings of the document, so any proposal can be cut into sections by its own structure
// instead of by phrases known in advance: [{ line, text, level }], `line` being the index in
// docxXmlToText's output. A paragraph is a heading when Word says so (a Heading / หัวเรื่อง
// style, an outline level), or when it is short and numbered (list numbering or typed
// "8." / "8.1" / "บทที่ 2") or set entirely in bold. Level: 1 = top; deeper = larger.
function styleTable(stylesXml) {
  const map = {};
  if (!stylesXml) return map;
  for (const st of parseXml(stylesXml).children.flatMap((x) => x.children || []).filter((x) => x.name === "w:style")) {
    const id = st.attrs["w:styleId"];
    const name = kid(st, "w:name")?.attrs["w:val"] || "";
    const ol = kid(kid(st, "w:pPr") || { children: [] }, "w:outlineLvl")?.attrs["w:val"];
    const hm = name.match(/^(?:heading|หัวเรื่อง)\s*(\d)/i);
    let level = ol != null ? Number(ol) + 1 : hm ? Number(hm[1]) : /^title$|^ชื่อเรื่อง$/i.test(name) ? 1 : null;
    if (level != null && level > 9) level = null; // outline level 9 = body text
    map[id] = { level, basedOn: kid(st, "w:basedOn")?.attrs["w:val"] };
  }
  return map;
}

const TYPED_NUMBER = /^\s*(?:(บทที่|chapter)\s*\d{1,2}|(\d{1,2}(?:\.\d{1,2})*)\.?|[ก-ฮ]\.)\s+\S/i;

function headingLevel(p, text, styles) {
  const t = text.trim();
  if (!t || t.length > 110) return null;
  const pPr = kid(p, "w:pPr") || { children: [] };
  const styleId = kid(pPr, "w:pStyle")?.attrs["w:val"];
  let st = styles[styleId];
  for (let n = 0; st && st.level == null && st.basedOn && n < 5; n++) st = styles[st.basedOn];
  const ol = kid(pPr, "w:outlineLvl")?.attrs["w:val"];
  if (ol != null && Number(ol) < 9) return Number(ol) + 1;
  if (st?.level != null) return st.level;
  const typed = t.match(TYPED_NUMBER);
  if (typed && t.length <= 90 && !/[.!?]$|ๆ$/.test(t)) return typed[1] ? 1 : typed[2] ? typed[2].split(".").length : 3;
  const num = kid(pPr, "w:numPr");
  const runs = kids(p, "w:r").filter((r) => runText(r).trim());
  const bold = runs.length > 0 && runs.every((r) => {
    const b = kid(kid(r, "w:rPr") || { children: [] }, "w:b");
    return b && b.attrs["w:val"] !== "0" && b.attrs["w:val"] !== "false";
  });
  const ilvl = num ? Number(kid(num, "w:ilvl")?.attrs["w:val"] || 0) + 1 : 1;
  if (num && bold && t.length <= 90) return ilvl;
  // a plain numbered paragraph is usually a list item ("1. อายุ 18 ปีขึ้นไป"); kept as a
  // possible heading that sections.js only lets end a section when it names a main part
  if (num && t.length <= 60) return { level: ilvl, kind: "list" };
  if (bold && t.length <= 90) return 4; // a bold line with no number: a minor heading
  return null;
}

export function docxXmlToOutline(xml, stylesXml) {
  const styles = styleTable(stylesXml);
  const doc = parseXml(xml);
  const body = kid(kid(doc, "w:document") || doc, "w:body");
  if (!body) return [];
  const out = [];
  let line = 0;
  for (const c of body.children) {
    if (c.name === "w:p") {
      const t = paraText(c);
      if (!t.trim()) continue;
      const lv = headingLevel(c, t, styles);
      if (lv != null) {
        const h = { line, text: t.trim().replace(/\s+/g, " "), level: typeof lv === "object" ? lv.level : lv };
        if (typeof lv === "object") h.kind = lv.kind;
        out.push(h);
      }
      line += t.split("\n").length;
    } else if (c.name === "w:tbl") {
      line += tableToLines(c).reduce((n, l) => n + l.split("\n").length, 0);
    }
  }
  return out;
}

// Plain text (.md, .txt, text from a PDF): headings are short numbered or "#" lines.
export function textOutline(text) {
  const out = [];
  String(text || "").split("\n").forEach((l, i) => {
    const t = l.trim();
    if (!t || t.length > 90 || t.includes(" | ")) return;
    const md = t.match(/^(#{1,6})\s+\S/);
    if (md) { out.push({ line: i, text: t.replace(/^#+\s*/, ""), level: md[1].length }); return; }
    const typed = t.match(TYPED_NUMBER);
    if (typed && !/[.!?]$/.test(t)) out.push({ line: i, text: t, level: typed[1] ? 1 : typed[2] ? typed[2].split(".").length : 3 });
  });
  return out;
}

// ---------------------------------------------------------------- docx figures and tables

// Pictures and tables in reading order, each with `line` = index (in the text above,
// split on "\n") of the first text line after it, so the extractor can tell which
// section it sits in. A table that only frames a picture (a figure with its caption)
// counts as the picture. Table rows keep one entry per real cell; a cell merged down
// from the row above is "".
const PICTURE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml" };

// Picture ids in reading order. A drawing Word stores twice (mc:AlternateContent: a modern
// version plus a VML fallback) counts once. Charts and SmartArt are not pictures.
function blips(el, out = []) {
  for (const c of el.children || []) {
    if (c.name === "mc:Fallback") continue;
    if (c.name === "a:blip" && c.attrs["r:embed"]) out.push(c.attrs["r:embed"]);
    else if (c.name === "v:imagedata" && c.attrs["r:id"]) out.push(c.attrs["r:id"]);
    else if (c.name === "c:chart") out.push("#chart");
    else if (c.name === "dgm:relIds") out.push("#smartart");
    else if (c.children) blips(c, out);
  }
  return out;
}

function tableRows(tbl) {
  return kids(tbl, "w:tr").map((tr) => kids(tr, "w:tc").map((tc) => (vMerge(tc) === "continue" ? "" : cellText(tc).trim())));
}

export function docxXmlToMedia(xml) {
  const doc = parseXml(xml);
  const body = kid(kid(doc, "w:document") || doc, "w:body");
  if (!body) return [];
  const out = [];
  let line = 0;
  for (const c of body.children) {
    if (c.name === "w:p") {
      for (const rid of blips(c)) out.push({ kind: "img", rid, line });
      const t = paraText(c);
      if (t.trim()) line += t.split("\n").length;
    } else if (c.name === "w:tbl") {
      const lines = tableToLines(c);
      const pics = blips(c);
      if (pics.length && lines.join(" ").length < 300) pics.forEach((rid) => out.push({ kind: "img", rid, line }));
      else if (!pics.length) out.push({ kind: "table", rows: tableRows(c), line, lines: lines.reduce((n, l) => n + l.split("\n").length, 0) });
      line += lines.reduce((n, l) => n + l.split("\n").length, 0);
    }
  }
  return out;
}

export function bytesToDataUrl(bytes, mime) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(s)}`;
}

async function docxMedia(buf, xml) {
  const items = docxXmlToMedia(xml);
  if (!items.some((m) => m.kind === "img")) return items;
  const relsRaw = await unzipEntry(buf, "word/_rels/document.xml.rels");
  const rels = {};
  if (relsRaw) {
    for (const r of parseXml(new TextDecoder().decode(relsRaw)).children.flatMap((x) => x.children || [])) {
      if (r.name === "Relationship") rels[r.attrs.Id] = r.attrs.Target;
    }
  }
  // what cannot be shown comes back as { kind: "skip", why } so the page can say so
  const out = [];
  for (const m of items) {
    if (m.kind !== "img") { out.push(m); continue; }
    if (m.rid === "#chart") { out.push({ kind: "skip", line: m.line, why: "กราฟที่สร้างใน Word (Chart)" }); continue; }
    if (m.rid === "#smartart") { out.push({ kind: "skip", line: m.line, why: "SmartArt" }); continue; }
    const target = rels[m.rid];
    const ext = target ? target.split(".").pop().toLowerCase() : "";
    const mime = PICTURE_TYPES[ext];
    if (!target) { out.push({ kind: "skip", line: m.line, why: "รูปที่ลิงก์ไปไฟล์ภายนอก" }); continue; }
    if (!mime) { out.push({ kind: "skip", line: m.line, why: `รูปชนิด .${ext} ที่เบราว์เซอร์แสดงไม่ได้` }); continue; }
    const bytes = await unzipEntry(buf, target.startsWith("/") ? target.slice(1) : `word/${target}`);
    if (bytes) out.push({ kind: "img", line: m.line, src: bytesToDataUrl(bytes, mime), name: target.split("/").pop() });
    else out.push({ kind: "skip", line: m.line, why: "รูปที่ลิงก์ไปไฟล์ภายนอก" });
  }
  return out;
}

// ---------------------------------------------------------------- pdf

// pdf.js returns Thai with the sara am split (U+0E4D + U+0E32), stray spaces before
// combining marks, and NFD forms; tidy that before the rules run.
// Thai fonts (TH Sarabun New, Tahoma, ...) draw raised/shifted marks with Private-Use
// glyphs U+F700 to U+F71A; pdf.js hands those back, so map them to the real characters.
const THAI_PUA = {
  0xf700: "ฐ", 0xf701: "ิ", 0xf702: "ี", 0xf703: "ึ", 0xf704: "ื",
  0xf705: "่", 0xf706: "้", 0xf707: "๊", 0xf708: "๋", 0xf709: "์",
  0xf70a: "่", 0xf70b: "้", 0xf70c: "๊", 0xf70d: "๋", 0xf70e: "์",
  0xf70f: "ญ", 0xf710: "ั", 0xf711: "ํ", 0xf712: "็",
  0xf713: "่", 0xf714: "้", 0xf715: "๊", 0xf716: "๋", 0xf717: "์",
  0xf718: "ุ", 0xf719: "ู", 0xf71a: "ฺ",
};
const LIGATURES = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };

export function tidyPdfThai(s) {
  return s
    .replace(/[-]/g, (c) => THAI_PUA[c.codePointAt(0)])
    .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c])
    .normalize("NFC")
    .replace(/ํา/g, "ำ")
    .replace(/ (?=[ัิ-ฺ็-๎])/g, "")
    .replace(/[ \t]+\n/g, "\n");
}

// A PDF whose Thai font has a broken ToUnicode map yields control characters where
// the shifted vowel and tone-mark glyphs were (pypdf shows the same damage).
export function garbledThai(text) {
  const thai = (text.match(/[฀-๿]/g) || []).length;
  if (thai < 200) return false;
  const junk = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F�]/g) || []).length;
  return junk / thai > 0.002;
}

async function pdfToText(buf) {
  const pdfjs = await import(/* @vite-ignore */ PDFJS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    // without disableNormalization pdf.js silently drops the Thai Private-Use glyphs (tone marks)
    const tc = await page.getTextContent({ disableNormalization: true });
    let s = "";
    for (const it of tc.items) {
      s += it.str;
      if (it.hasEOL) s += "\n";
    }
    pages.push(s);
  }
  const text = tidyPdfThai(pages.join("\n"));
  if (text.replace(/\s/g, "").length < 50) {
    throw new Error("PDF นี้ไม่มีข้อความให้อ่าน (น่าจะเป็นภาพสแกน) กรุณาอัปโหลดไฟล์ .docx แทน");
  }
  if (garbledThai(text)) {
    throw new Error("อ่านภาษาไทยใน PDF นี้ได้ไม่ถูกต้อง (ฟอนต์ที่ฝังในไฟล์ เช่น TH SarabunPSK บางรุ่น แปลงสระและวรรณยุกต์กลับเป็นข้อความไม่ได้) จึงไม่ดึงข้อมูลเพื่อกันข้อความผิด กรุณาอัปโหลดไฟล์ .docx ต้นฉบับแทน");
  }
  return text;
}

// ---------------------------------------------------------------- entry

export async function loadText(name, buf) {
  return (await loadDocument(name, buf)).text;
}

// { text, tables, media } ; tables (grids of { text, shaded }) and media (pictures and
// tables placed by line, see docxXmlToMedia) only for .docx
export async function loadDocument(name, buf) {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "docx") {
    const raw = await unzipEntry(buf, "word/document.xml");
    if (!raw) throw new Error("ไม่พบ word/document.xml ในไฟล์ .docx");
    const xml = new TextDecoder().decode(raw);
    const styles = await unzipEntry(buf, "word/styles.xml");
    const outline = docxXmlToOutline(xml, styles ? new TextDecoder().decode(styles) : "");
    return { text: docxXmlToText(xml), tables: docxXmlToTables(xml), media: await docxMedia(buf, xml), outline };
  }
  if (["html", "htm", "doc", "mht", "mhtml"].includes(ext)) {
    const s = new TextDecoder().decode(buf);
    if (isMime(s)) {
      const page = mimeHtml(s);
      if (page) return htmlToDocument(page);
    } else if (ext !== "doc" || isHtml(s)) return htmlToDocument(s);
  }
  const text = await loadOther(ext, buf);
  return { text, tables: [], media: [], outline: textOutline(text) };
}

// A web page (.html), or a ".doc" that is really HTML: the Word file the forms' "บันทึก Word
// (.doc)" button saves is one, and so is a page saved as "Web Page" from Word.
// The same with pictures is a web archive (MIME multipart/related, like Word's "Single File
// Web Page" .mht): the page is its text/html part, base64 or quoted-printable.
const isMime = (s) => /^\s*MIME-Version:/i.test(s.slice(0, 200)) && /multipart\/related/i.test(s.slice(0, 2000));
function mimeHtml(s) {
  const bound = (s.match(/boundary="?([^";\r\n]+)"?/i) || [])[1];
  if (!bound) return null;
  for (const part of s.split(`--${bound}`)) {
    const cut = part.search(/\r?\n\r?\n/);
    if (cut < 0) continue;
    const head = part.slice(0, cut);
    if (!/Content-Type:\s*text\/html/i.test(head)) continue;
    const body = part.slice(cut).trim();
    const charset = ((head.match(/charset="?([\w-]+)"?/i) || [])[1] || "utf-8").toLowerCase();
    const enc = ((head.match(/Content-Transfer-Encoding:\s*([\w-]+)/i) || [])[1] || "").toLowerCase();
    let bytes;
    if (enc === "base64") bytes = Uint8Array.from(atob(body.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
    else if (enc === "quoted-printable") {
      const t = body.replace(/=\r?\n/g, "");
      const out = [];
      for (let i = 0; i < t.length; i++) {
        if (t[i] === "=" && /^[0-9A-F]{2}$/i.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
        else out.push(...new TextEncoder().encode(t[i]));
      }
      bytes = Uint8Array.from(out);
    } else return body;
    try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
  }
  return null;
}

const isHtml = (s) => /^\s*(?:<!doctype html|<html|<\?xml[^>]*>\s*<html)/i.test(s.slice(0, 2000)) || /<html[\s>]/i.test(s.slice(0, 2000));

const BLOCK = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER",
  "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "UL", "CAPTION"]);
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "BUTTON", "SELECT", "OPTION", "SVG"]);

// { text, tables, outline } like a .docx: paragraphs as lines, tables as "a | b" rows plus
// their grids, <h1>-<h6> and numbered lines as headings. Check boxes of the EC forms
// (".cb", "on" = ticked) and form inputs are written as "[ / ]" / "[ ]" and their values.
// Needs the browser's DOMParser.
export function htmlToDocument(html) {
  if (typeof DOMParser === "undefined") throw new Error("อ่านไฟล์ HTML ได้เฉพาะในเบราว์เซอร์");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const lines = [];
  const tables = [];
  const heads = [];
  let buf = "";
  const flush = () => { const t = buf.replace(/[ \t ]+/g, " ").trim(); if (t) lines.push(t); buf = ""; };
  const hidden = (el) => el.hasAttribute("hidden") || /display\s*:\s*none/i.test(el.getAttribute("style") || "");
  const box = (on) => (on ? "[ / ] " : "[ ] ");
  // text of a cell or inline run, one string (line breaks kept)
  const inline = (n) => {
    if (n.nodeType === 3) return n.nodeValue;
    if (n.nodeType !== 1 || SKIP.has(n.tagName) || hidden(n)) return "";
    if (n.tagName === "BR") return "\n";
    if (n.classList.contains("cb") && !n.textContent.trim()) return box(n.classList.contains("on"));
    if (n.tagName === "INPUT") return n.type === "checkbox" || n.type === "radio" ? box(n.checked) : `${n.value || ""} `;
    if (n.tagName === "TEXTAREA") return n.value || n.textContent;
    if (n.tagName === "TABLE") return rowsOf(n).map((r) => r.join(" | ")).join(" ; ");
    const s = [...n.childNodes].map(inline).join("");
    return BLOCK.has(n.tagName) ? `\n${s}\n` : s;
  };
  const clean = (s) => s.split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");
  const rowsOf = (t) => [...t.rows].filter((tr) => tr.closest("table") === t)
    .map((tr) => [...tr.cells].flatMap((c) => Array(Math.max(1, Number(c.colSpan) || 1)).fill(c)));
  const walk = (n) => {
    if (n.nodeType === 3) { buf += n.nodeValue; return; }
    if (n.nodeType !== 1 || SKIP.has(n.tagName) || hidden(n)) return;
    if (n.tagName === "TABLE") {
      flush();
      const grid = rowsOf(n).map((r) => r.map((c) => ({ text: clean(inline(c)), shaded: /background(?:-color)?\s*:\s*(?!#?f{3,6}\b|white|transparent|none|rgba?\(\s*255,\s*255,\s*255)/i.test(c.getAttribute("style") || "") })));
      tables.push(grid);
      for (const r of grid) {
        const cells = [];
        for (const c of r) { const t = c.text.replace(/\n+/g, " "); if (t && cells[cells.length - 1] !== t) cells.push(t); }
        if (cells.length) lines.push(cells.join(" | "));
      }
      return;
    }
    if (n.tagName === "BR") { flush(); return; }
    if (n.tagName !== "TD" && n.tagName !== "TH" && (n.classList.contains("cb") || n.tagName === "INPUT" || n.tagName === "TEXTAREA")) { buf += inline(n); return; }
    const block = BLOCK.has(n.tagName);
    if (block) flush();
    const h = /^H([1-6])$/.exec(n.tagName);
    if (h) { const t = clean(n.textContent).replace(/\n/g, " "); if (t) heads.push({ line: lines.length, text: t, level: Number(h[1]) }); }
    for (const c of n.childNodes) walk(c);
    if (block) flush();
  };
  walk(doc.body || doc.documentElement);
  flush();
  const text = lines.join("\n");
  // <h1>-<h6>, and numbered lines ("8. ประโยชน์...") the way plain text is read
  const seen = new Set(heads.map((x) => x.line));
  const outline = [...heads, ...textOutline(text).filter((x) => !seen.has(x.line))].sort((a, b) => a.line - b.line);
  return { text, tables, media: [], outline };
}

async function loadOther(ext, buf) {
  if (ext === "txt" || ext === "md" || ext === "markdown") return new TextDecoder().decode(buf);
  if (ext === "pdf") return pdfToText(buf);
  if (ext === "doc") throw new Error("ไฟล์ .doc รุ่นเก่ายังไม่รองรับ กรุณา Save As เป็น .docx");
  throw new Error(`ไม่รองรับไฟล์ .${ext} (ใช้ .docx, .pdf, .html, .md, .txt หรือไฟล์งาน .json)`);
}
