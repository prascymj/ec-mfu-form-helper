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

function collectTables(el, out) {
  for (const c of el.children || []) {
    if (c.name === "w:tbl") {
      const grid = tableGrid(c).map((row) => row.cells.map((tc) => ({ text: cellText(tc).trim(), shaded: cellShaded(tc) })));
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

// { text, tables } ; tables only for .docx (grids of { text, shaded })
export async function loadDocument(name, buf) {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "docx") {
    const raw = await unzipEntry(buf, "word/document.xml");
    if (!raw) throw new Error("ไม่พบ word/document.xml ในไฟล์ .docx");
    const xml = new TextDecoder().decode(raw);
    return { text: docxXmlToText(xml), tables: docxXmlToTables(xml) };
  }
  return { text: await loadOther(ext, buf), tables: [] };
}

async function loadOther(ext, buf) {
  if (ext === "txt" || ext === "md" || ext === "markdown") return new TextDecoder().decode(buf);
  if (ext === "pdf") return pdfToText(buf);
  if (ext === "doc") throw new Error("ไฟล์ .doc รุ่นเก่ายังไม่รองรับ กรุณา Save As เป็น .docx");
  throw new Error(`ไม่รองรับไฟล์ .${ext} (ใช้ .docx, .pdf, .md หรือ .txt)`);
}
