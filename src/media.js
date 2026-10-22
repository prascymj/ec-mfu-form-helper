// Pictures and tables inside long text fields (AP 02 ข้อ 9, 10, 12.1.1, 12.3, 13 and
// AP 03_1 ข้อ 7). The field text holds a marker line "[[รูป 1]]" / "[[ตาราง 1]]" where the
// item goes; the items themselves live in submission.media:
//   { "รูป 1": { kind: "img", src: "data:image/...", name }, "ตาราง 1": { kind: "table", rows: [[...]] } }
//
// Pictures are too big for localStorage (about 5 MB per site), so the page keeps
// submission.media in IndexedDB and the rest of the project in localStorage; the forms
// read both. A saved .json carries everything in one file.

export const MEDIA_FIELDS = [
  "methodology.literature_review", "methodology.study_design", "methodology.procedures",
  "methodology.operational_definitions", "methodology.statistical_analysis", "layman.participant_tasks",
];
export const MARK = /\[\[(รูป|ตาราง) (\d+)\]\]/g;

export const markIds = (text) => [...String(text || "").matchAll(MARK)].map((m) => `${m[1]} ${m[2]}`);

export function nextId(media, kind) {
  const word = kind === "img" ? "รูป" : "ตาราง";
  let n = 1;
  while (media?.[`${word} ${n}`]) n++;
  return `${word} ${n}`;
}

// ---------------------------------------------------------------- IndexedDB

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("ecmfu", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveMedia(media) {
  const db = await idb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(media || {}, "media");
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadMedia() {
  try {
    const db = await idb();
    const v = await new Promise((resolve, reject) => {
      const req = db.transaction("kv").objectStore("kv").get("media");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return v || {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- pictures

// Shrink a picture to at most 1600 px wide; photos become JPEG, drawings stay PNG.
// Small files are kept as they are, and so is one the browser takes too long over
// (a background tab is throttled), so an upload never hangs on a picture.
export function shrinkPicture(src, maxW = 1600) {
  return Promise.race([shrinkNow(src, maxW).catch(() => src), new Promise((r) => setTimeout(() => r(src), 6000))]);
}

async function shrinkNow(src, maxW) {
  if (typeof document === "undefined" || src.length < 400_000 || src.startsWith("data:image/svg")) return src;
  const img = new Image();
  img.src = src;
  try { await img.decode(); } catch { return src; }
  const scale = Math.min(1, maxW / img.naturalWidth);
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  const png = c.toDataURL("image/png");
  const jpg = c.toDataURL("image/jpeg", 0.85);
  const best = png.length < jpg.length * 1.5 ? png : jpg;
  return best.length < src.length ? best : src;
}

export const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

// ---------------------------------------------------------------- tables

// Rows from what Word or Excel put on the clipboard: an HTML <table>, else tab-separated text.
export function rowsFromClipboard(html, text) {
  if (html && /<table/i.test(html)) {
    const d = new DOMParser().parseFromString(html, "text/html");
    const t = d.querySelector("table");
    const rows = [...t.rows].map((tr) => [...tr.cells].map((td) => td.innerText.replace(/\s*\n\s*/g, "\n").trim()));
    if (rows.length) return rows;
  }
  const lines = String(text || "").replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = lines.some((l) => l.includes("\t")) ? "\t" : lines.every((l) => l.includes("|")) ? "|" : null;
  return lines.map((l) => (sep ? l.split(sep).map((c) => c.trim()) : [l.trim()]))
    .map((r) => (sep === "|" ? r.filter((c, i) => c || (i > 0 && i < r.length - 1)) : r))
    .filter((r) => !(sep === "|" && r.every((c) => /^:?-+:?$/.test(c))));
}

export const blankRows = (r, c) => Array.from({ length: r }, () => Array(c).fill(""));

// ---------------------------------------------------------------- drawing

export function itemNode(doc, item, { editable = false } = {}) {
  if (item.kind === "img") {
    const box = doc.createElement("span");
    box.className = "fig";
    box.setAttribute("contenteditable", "false");
    const img = doc.createElement("img");
    img.src = item.src;
    img.alt = item.name || "";
    box.append(img);
    return box;
  }
  const t = doc.createElement("table");
  t.className = "mt";
  const cols = Math.max(1, ...item.rows.map((r) => r.length));
  item.rows.forEach((r, ri) => {
    const tr = t.insertRow();
    for (let i = 0; i < cols; i++) {
      const td = tr.insertCell();
      td.textContent = r[i] ?? "";
      if (ri === 0) td.className = "hs";
      if (editable) td.setAttribute("contenteditable", "true");
    }
  });
  return t;
}

// Fill `el` with the text, drawing each marker's picture or table in place.
// A marker whose item is missing stays as plain text so it can be noticed.
export function renderRich(el, text, media) {
  const doc = el.ownerDocument;
  const parts = [];
  let last = 0;
  for (const m of String(text).matchAll(MARK)) {
    const item = media?.[`${m[1]} ${m[2]}`];
    if (!item) continue;
    parts.push(text.slice(last, m.index).replace(/\n$/, ""));
    parts.push(itemNode(doc, item));
    last = m.index + m[0].length;
    if (text[last] === "\n") last++;
  }
  parts.push(text.slice(last));
  el.replaceChildren(...parts.filter((p) => p !== ""));
}
