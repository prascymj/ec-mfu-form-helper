// EC-MFU page: upload a proposal, review what was extracted, open the forms to print.
// Everything runs in this browser tab; the proposal is never sent anywhere.

import { loadDocument } from "./loaders.js";
import { extractSubmissions, computeFee, selectForms, recommendReview, EC_BUDGET, budgetSums } from "./extract.js";
import { SECTIONS, COI_ITEMS, MANUAL_DOCS } from "./fields.js";
import { pickFields, buildPrompt, parseResponse, applyResponse } from "./assist.js";
import { valueFromSection } from "./sections.js";
import { TEMPLATES } from "./heading-map.js";
import {
  MEDIA_FIELDS, markIds, nextId, saveMedia, loadMedia, shrinkPicture, fileToDataUrl, rowsFromClipboard, blankRows, itemNode,
} from "./media.js";

const STORE_KEY = "ecmfu.current";
const FORM_FILES = { AP01_1: "ap01_1.html", AP01_2: "ap01_2.html", AP02: "ap02.html", AP03_1: "ap03_1.html", FEE: "fee.html" };
const REVIEW_TH = {
  exempt: "ยกเว้นการพิจารณา (Exempt)",
  expedited: "พิจารณาแบบเร่งรัด (Expedited)",
  full_board: "พิจารณาเต็มคณะ (Full board)",
};

let state = null; // { submission, source, fileName, savedAt, touched: [] }
let mediaReport = null; // pictures and tables found in the last upload (this visit only)
let onlyTodo = false;

const $ = (sel, root = document) => root.querySelector(sel);
const codeTH = (c) => c.replace(/^AP(\d\d)/, "AP $1"); // AP01_1 -> AP 01_1, as printed on the forms
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
};

// ---------------------------------------------------------------- data helpers

const get = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
function set(o, path, v) {
  const ks = path.split(".");
  let x = o;
  ks.slice(0, -1).forEach((k) => { if (x[k] == null || typeof x[k] !== "object") x[k] = {}; x = x[k]; });
  x[ks[ks.length - 1]] = v;
}
const isEmpty = (v) => v == null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);

function cond(s, expr) {
  if (!expr) return true;
  return expr.split("||").some((p) => {
    const m = p.match(/^(.+?)==(.*)$/);
    if (m) return String(get(s, m[1])) === m[2];
    const v = get(s, p.trim());
    return Array.isArray(v) ? v.length > 0 : Boolean(v);
  });
}

const squash = (t) => String(t ?? "").replace(/\s+/g, " ");
function findInSource(value) {
  if (!state?.source) return -1;
  const v = squash(Array.isArray(value) ? value[0] : value).trim();
  if (v.length < 6) return -1;
  return squash(state.source).indexOf(v.slice(0, 40));
}
function sourceSnippet(value) {
  const src = squash(state.source);
  const v = squash(Array.isArray(value) ? value[0] : String(value)).trim().slice(0, 40);
  const i = src.indexOf(v);
  if (i < 0) return null;
  const a = Math.max(0, i - 120);
  const b = Math.min(src.length, i + v.length + 160);
  const q = el("blockquote");
  q.append((a > 0 ? "..." : "") + src.slice(a, i), el("mark", {}, src.slice(i, i + v.length)), src.slice(i + v.length, b) + (b < src.length ? "..." : ""));
  return q;
}

// status of one field -> { kind: ok|guess|todo|info|hide, text }
function status(f) {
  const s = state.submission;
  if (f.when && !cond(s, f.when)) return { kind: "hide" };
  // the researcher pressed "ยืนยัน" on a machine-filled or copied answer
  if ((state.confirmed || []).includes(f.path) && !isEmpty(get(s, f.path))) return { kind: "ok", text: "ยืนยันแล้ว" };
  if (f.type === "budgetmap") {
    const items = get(s, f.path);
    if (!Array.isArray(items) || !items.length) return { kind: "info", text: "ไม่พบตารางงบประมาณในไฟล์ กรอกยอดแต่ละหมวดเอง" };
    return state.touched.includes(f.path) ? { kind: "ok", text: "ตรวจแล้ว" } : { kind: "guess", text: "เครื่องจัดหมวด ตรวจ" };
  }
  if ((state.ai || []).includes(f.path) && !state.touched.includes(f.path)) return { kind: "guess", text: "Claude ร่าง ตรวจ" };
  const v = get(s, f.path);
  const touched = state.touched.includes(f.path);
  if (f.type === "bool") {
    if (v == null) return f.optional ? { kind: "info", text: "ไม่บังคับ" } : { kind: "todo", text: "ยังไม่ตอบ" };
    if (f.guess && !touched) return { kind: "guess", text: "เครื่องเดาจากคำสำคัญ ตรวจ" };
    return { kind: "ok", text: touched ? "ตรวจแล้ว" : "ตอบแล้ว" };
  }
  if (f.type === "checks" || f.type === "coi") {
    if (f.guess && !touched) return { kind: "guess", text: "เครื่องเดา ตรวจ" };
    if (f.type === "coi") return touched ? { kind: "ok", text: "ตรวจแล้ว" } : { kind: "guess", text: "ค่าเริ่มต้น ผู้วิจัยต้องยืนยัน" };
    return { kind: "ok", text: touched ? "ตรวจแล้ว" : "เลือกได้หลายข้อ" };
  }
  if (f.type === "person") {
    if (f.optional && (v == null || !v.title_th)) return { kind: "info", text: "ไม่บังคับ" };
    const missing = (f.cols || []).filter((c) => ["title_th", "affiliation", "phone", "email"].includes(c.key) && isEmpty(v?.[c.key]));
    return missing.length ? { kind: "todo", text: `ขาด ${missing.length} ช่อง` } : { kind: "ok", text: "ครบ" };
  }
  if (isEmpty(v)) return f.optional ? { kind: "info", text: "ไม่บังคับ" } : { kind: "todo", text: "ยังว่าง" };
  if (touched) return { kind: "ok", text: "แก้แล้ว" };
  if (["select", "number", "date"].includes(f.type) && f.guess) return { kind: "guess", text: "เครื่องเดา ตรวจ" };
  if (!["text", "area", "list"].includes(f.type)) return { kind: "ok", text: "กรอกแล้ว" };
  if (f.rewrite && findInSource(v) >= 0) return { kind: "guess", text: "ลอกจากข้อเสนอ ต้องเขียนใหม่ให้อ่านง่าย" };
  if (findInSource(v) >= 0) return { kind: "ok", text: "จากข้อเสนอ" };
  return { kind: "ok", text: "กรอกแล้ว" };
}

function refreshDerived() {
  const s = state.submission;
  s._fee = computeFee(s);
  s._forms = selectForms(s);
  s.recommended_review = recommendReview(s);
}

// Every change is kept in this browser (localStorage) a moment after it is made, so closing
// the tab or the browser loses nothing; the header says when the last save happened.
let saveTimer = null;
function showSaved(text, bad = false) {
  const s = $("#saved");
  if (!s) return;
  s.textContent = text;
  s.classList.toggle("bad", bad);
}
const hhmm = (iso) => new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
function persist() {
  clearTimeout(saveTimer);
  showSaved("กำลังบันทึก...");
  saveTimer = setTimeout(() => {
    try {
      state.savedAt = new Date().toISOString();
      // pictures and tables go to IndexedDB, the rest to localStorage (see media.js)
      const { media, ...submission } = state.submission;
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...state, submission }));
      saveMedia(media || {})
        .then(() => showSaved(`บันทึกในเบราว์เซอร์นี้แล้ว ${hhmm(state.savedAt)} น.`))
        .catch(() => showSaved("บันทึกรูปและตารางในเบราว์เซอร์ไม่ได้ กด \"บันทึกงาน (.json)\" เก็บไว้", true));
    } catch {
      showSaved("บันทึกในเบราว์เซอร์ไม่ได้ กด \"บันทึกงาน (.json)\" เก็บไว้", true);
    }
  }, 250);
}

function touch(path) {
  if (!state.touched.includes(path)) state.touched.push(path);
}

// ---------------------------------------------------------------- upload

// A work file saved with "บันทึกงาน (.json)" (or a bare submission object).
async function openSaved(file) {
  const err = $("#err");
  err.classList.add("hidden");
  try {
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error("ไฟล์เสียหรือไม่ใช่ไฟล์ JSON"); }
    const sub = data?.submission || data;
    if (!sub || typeof sub !== "object" || !sub.meta) throw new Error("ไม่ใช่ไฟล์งานที่บันทึกจากหน้านี้");
    state = data.submission ? { touched: [], ...data } : { submission: data, source: "", fileName: file.name, touched: [] };
    assistResult = null;
    persist();
    renderAll();
    $("#summary")?.scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    err.textContent = `เปิดไฟล์งาน ${file.name} ไม่ได้: ${e.message}`;
    err.classList.remove("hidden");
  }
}

// Several files are each read on their own and then joined field by field
// (extractSubmissions): a filled EC form's answer wins, else the first file (the proposal)
// wins where two files answer the same field, and later files fill the gaps.
async function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const err = $("#err");
  err.classList.add("hidden");
  // a saved work file (.json) opens that work, as "เปิดงาน" does
  const saved = files.filter((f) => /\.json$/i.test(f.name));
  if (saved.length) {
    if (files.length > 1) {
      err.textContent = "ไฟล์งาน (.json) เปิดได้ทีละไฟล์ และไม่รวมกับไฟล์ข้อเสนอ กรุณาวางไฟล์ .json ไฟล์เดียว";
      err.classList.remove("hidden");
      return;
    }
    await openSaved(saved[0]);
    return;
  }
  try {
    const docs = [];
    for (const file of files) {
      $("#drop b").textContent = `กำลังอ่าน ${file.name} ...`;
      const doc = await loadDocument(file.name, await file.arrayBuffer());
      if (!doc.text.trim()) throw new Error(`ไม่พบข้อความในไฟล์ ${file.name}`);
      for (const m of doc.media || []) if (m.src) m.src = await shrinkPicture(m.src);
      docs.push(doc);
    }
    const { submission, text, outline } = extractSubmissions(docs);
    // where each value the general pass found came from, shown under its field
    const sources = Object.fromEntries(Object.entries(submission._sources || {})
      .map(([p, src]) => [p, src.form ? `แบบฟอร์ม ${codeTH(src.form.toUpperCase())} ที่กรอกแล้ว` : src.row ? "แถวในตารางของไฟล์" : `หัวข้อ "${outline[src.heading]?.text || ""}"${src.template ? ` (ตามคลังหัวข้อของ${TEMPLATES.find((t) => t.id === src.template)?.name || "แบบฟอร์มทุน"})` : ""}`]));
    mediaReport = submission._mediaReport || { pictures: 0, tables: 0, placedPictures: 0, placedTables: 0, unusable: [] };
    state = { submission, source: text, outline, sources, fileName: files.map((f) => f.name).join(", "), savedAt: null, touched: [] };
    assistResult = null;
    persist();
    renderAll();
    $("#summary").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    err.textContent = e.message || String(e);
    err.classList.remove("hidden");
  } finally {
    $("#drop b").textContent = "ลากไฟล์ข้อเสนอโครงการมาวาง หรือคลิกเพื่อเลือก (เลือกได้หลายไฟล์)";
  }
}

// ---------------------------------------------------------------- summary

function formProgress(code) {
  const needed = [];
  for (const sec of SECTIONS) {
    for (const f of sec.fields) {
      if (!(f.forms || []).includes(code) || f.optional) continue;
      const st = status(f);
      if (st.kind === "hide") continue;
      needed.push(st.kind !== "todo");
    }
  }
  return { done: needed.filter(Boolean).length, total: needed.length };
}

function nextMeeting() {
  const now = new Date();
  const m = now.getDate() <= 25 ? now.getMonth() + 1 : now.getMonth() + 2;
  const d = new Date(now.getFullYear(), m, 1);
  const th = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  return `ถ้าเอกสารครบภายในวันที่ 25 ${th[now.getDate() <= 25 ? now.getMonth() : (now.getMonth() + 1) % 12]} จะเข้าประชุมเดือน${th[d.getMonth()]}`;
}

// What happened to the pictures and tables of the uploaded file, so a missing picture
// has a reason instead of a guess.
function mediaNote() {
  const r = mediaReport;
  if (!r) return null;
  const pdf = /\.pdf\b/i.test(state.fileName) && !/\.docx\b/i.test(state.fileName);
  if (pdf) return el("p", { class: "note" }, "ไฟล์ PDF ดึงรูปและตารางไม่ได้ ใช้ไฟล์ .docx หรือกด \"แทรกรูป\" / \"แทรกตาราง\" ในข้อที่ต้องการ");
  if (!r.pictures && !r.tables) return null;
  const outside = r.pictures - r.unusable.length - r.placedPictures;
  const why = Object.entries(r.unusable.reduce((a, w) => ({ ...a, [w]: (a[w] || 0) + 1 }), {})).map(([w, n]) => `${w} ${n} รูป`);
  return el("div", { class: "note media-note" },
    el("b", {}, `รูปและตารางในไฟล์: ดึงรูปมาได้ ${r.placedPictures} จาก ${r.pictures} รูป, ตาราง ${r.placedTables} จาก ${r.tables} ตาราง`),
    el("ul", {},
      r.placedPictures || r.placedTables ? el("li", {}, "ที่ดึงมาอยู่ใน AP 02 ข้อ 9, 10, 12.1.1, 12.3 หรือ 13 ตามหัวข้อในไฟล์ ดูได้ในส่วนตรวจและแก้ข้อมูล") : null,
      outside > 0 ? el("li", {}, `รูปอีก ${outside} รูปอยู่นอกหัวข้อเหล่านี้ (เช่น ภาคผนวก หรือความสำคัญของปัญหา) จึงไม่ได้ดึง ถ้าต้องการ ให้กด "แทรกรูป" ในข้อนั้น`) : null,
      why.length ? el("li", {}, `ดึงไม่ได้: ${why.join(", ")} ให้คลิกขวาที่รูปใน Word เลือก "บันทึกเป็นรูปภาพ" (Save as Picture) แล้วกด "แทรกรูป"`) : null,
      r.tables > r.placedTables ? el("li", {}, `ตารางอีก ${r.tables - r.placedTables} ตารางอยู่นอกหัวข้อเหล่านี้ (เช่น แผนงาน งบประมาณ ประวัติผู้วิจัย ซึ่งแบบฟอร์มมีช่องของตัวเอง)`) : null,
    ));
}

function renderSummary() {
  const s = state.submission;
  const box = $("#summary");
  box.replaceChildren();
  box.classList.remove("hidden");
  box.append(
    el("h2", {}, "สรุปชุดเอกสาร"),
    el("p", { class: "muted" }, `ไฟล์: ${state.fileName}`),
    mediaNote(),
    el("div", { class: "stats" },
      el("div", { class: "stat wide" }, el("div", { class: "k" }, "ชื่อโครงการ"), el("div", { class: "v" }, s.meta.title_th || s.meta.title_en || "(ยังไม่มี)")),
      el("div", { class: "stat" }, el("div", { class: "k" }, "ประเภทการพิจารณาที่คาด (EC เป็นผู้ตัดสิน)"), el("div", { class: "v" }, REVIEW_TH[s.recommended_review] || s.recommended_review)),
      el("div", { class: "stat" }, el("div", { class: "k" }, "ค่าธรรมเนียม"), el("div", { class: "v" }, s._fee.exempt ? "ยกเว้น" : `${s._fee.amount_baht.toLocaleString("th-TH")} บาท`), el("div", { class: "k" }, s._fee.label)),
      el("div", { class: "stat" }, el("div", { class: "k" }, "รอบประชุม"), el("div", { class: "v", style: "font-size:14px;font-weight:400" }, nextMeeting())),
    ),
  );

  const rows = [...s._forms.map((f) => ({ ...f })), { code: "FEE", title: "เอกสารแจ้งชำระค่าธรรมเนียม EC", reason: "ทุกโครงการ (Package 4.0 ข้อ 9)" }];
  const tb = el("tbody");
  for (const f of rows) {
    const file = FORM_FILES[f.code];
    const p = formProgress(f.code);
    const pct = p.total ? Math.round((100 * p.done) / p.total) : 100;
    tb.append(el("tr", {},
      el("td", {}, file
        ? el("button", { type: "button", class: "linkish", title: "ดูและกรอกข้อของแบบฟอร์มนี้", onclick: () => {
          setTab(f.code);
          renderReview();
          $("#ftabs").scrollIntoView({ behavior: "smooth" });
        } }, el("b", {}, codeTH(f.code)), el("br"), f.title)
        : [el("b", {}, codeTH(f.code)), el("br"), f.title]),
      el("td", { class: "muted" }, f.reason),
      el("td", {}, file ? [el("div", { class: "bar", title: `${p.done}/${p.total}` }, el("i", { style: `width:${pct}%` })), el("small", { class: "muted" }, `กรอกแล้ว ${p.done} จาก ${p.total}`)] : ""),
      el("td", {}, file
        ? el("a", { class: "btn", href: `forms/${file}?data=local`, target: "_blank" }, "เปิดเพื่อพิมพ์")
        : el("span", { class: "muted" }, "ยังไม่มีแม่แบบ ใช้ไฟล์ Word จากเว็บ EC")),
    ));
  }
  box.append(
    el("h2", { style: "margin-top:14px" }, "เอกสารที่ต้องส่ง"),
    el("div", { class: "grid" }, el("table", { class: "forms" },
      el("thead", {}, el("tr", {}, el("th", {}, "แบบฟอร์ม"), el("th", {}, "เหตุผลที่ต้องส่ง"), el("th", {}, "ความครบ"), el("th", {}, ""))), tb)),
    el("p", { class: "hint" }, "แบบฟอร์มที่เปิดจะใช้ข้อมูลล่าสุดในหน้านี้ ถ้าแก้ข้อมูลหลังเปิดแล้ว ให้กดรีเฟรชหน้าแบบฟอร์ม จากนั้นพิมพ์และเลือก \"บันทึกเป็น PDF\" (ใช้ Chrome หรือ Edge เพื่อให้มีเลขหน้า)"),
    el("h2", { style: "margin-top:14px" }, "เอกสารที่ต้องเตรียมเอง"),
    el("ul", { class: "manual" }, MANUAL_DOCS.map((d) => el("li", {}, d))),
  );
}

// ---------------------------------------------------------------- review widgets

function chip(st) { return el("span", { class: `chip ${st.kind}` }, st.text); }

function onEdit(f, v, { rerender = false } = {}) {
  set(state.submission, f.path, v);
  touch(f.path);
  state.confirmed = (state.confirmed || []).filter((p) => p !== f.path);
  refreshDerived();
  persist();
  if (rerender) renderReview(true);
  else updateField(f);
  renderSummary();
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function textInput(f, v) {
  if (f.type === "area" || f.type === "list") {
    const ta = el("textarea", { rows: f.type === "list" ? 4 : Math.min(10, Math.max(3, Math.ceil(String(v ?? "").length / 90))) });
    ta.value = f.type === "list" ? (v || []).join("\n") : (v ?? "");
    ta.addEventListener("input", () => onEdit(f, f.type === "list" ? ta.value.split("\n").map((x) => x.trim()).filter(Boolean) : ta.value));
    if (MEDIA_FIELDS.includes(f.path)) return mediaTools(f, ta);
    return ta;
  }
  const inp = el("input", { type: f.type === "number" ? "number" : f.type === "date" ? "date" : "text", placeholder: f.placeholder });
  inp.value = v ?? "";
  inp.addEventListener("input", () => {
    const val = f.type === "number" ? (inp.value === "" ? null : Number(inp.value)) : (inp.value || (f.type === "date" ? null : ""));
    onEdit(f, val, { rerender: Boolean(dependents(f.path)) });
  });
  if (f.today) {
    return el("div", { class: "with-btn" }, inp, el("button", { type: "button", class: "btn quiet", onclick: () => {
      inp.value = todayIso();
      onEdit(f, inp.value);
    } }, "ใช้วันที่วันนี้"));
  }
  return inp;
}

// ---------------------------------------------------------------- pictures and tables (media.js)

function mediaTools(f, ta) {
  const media = () => (state.submission.media ||= {});
  const commit = () => { onEdit(f, ta.value); drawGallery(); };
  const insert = (kind, item) => {
    const id = nextId(media(), kind);
    media()[id] = item;
    const pos = ta.selectionStart ?? ta.value.length;
    let before = ta.value.slice(0, pos);
    let after = ta.value.slice(pos);
    if (before && !before.endsWith("\n")) before += "\n";
    if (after && !after.startsWith("\n")) after = "\n" + after;
    ta.value = `${before}[[${id}]]${after}`;
    ta.selectionStart = ta.selectionEnd = before.length + id.length + 4;
    commit();
  };
  const addPictures = async (files) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      insert("img", { kind: "img", src: await shrinkPicture(await fileToDataUrl(file)), name: file.name });
    }
  };

  const pick = el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp,image/svg+xml", multiple: true, class: "hidden" });
  pick.addEventListener("change", async () => { await addPictures([...pick.files]); pick.value = ""; });

  // table maker: paste from Word or Excel, or an empty grid of the chosen size
  const nr = el("input", { type: "number", min: 1, max: 60, value: 3, style: "width:60px" });
  const nc = el("input", { type: "number", min: 1, max: 12, value: 3, style: "width:60px" });
  const pasteBox = el("textarea", { rows: 3, placeholder: "วางตารางที่คัดลอกจาก Word หรือ Excel ที่นี่ (ระบบแทรกให้ทันที)" });
  pasteBox.addEventListener("paste", (e) => {
    const rows = rowsFromClipboard(e.clipboardData.getData("text/html"), e.clipboardData.getData("text/plain"));
    if (!rows.length) return;
    e.preventDefault();
    insert("table", { kind: "table", rows });
    panel.classList.add("hidden");
  });
  const panel = el("div", { class: "mpanel hidden" },
    pasteBox,
    el("div", { class: "toolbar" }, "หรือสร้างตารางว่าง ", nr, " แถว ", nc, " คอลัมน์ ",
      el("button", { type: "button", class: "btn", onclick: () => {
        insert("table", { kind: "table", rows: blankRows(Math.max(1, +nr.value || 3), Math.max(1, +nc.value || 3)) });
        panel.classList.add("hidden");
      } }, "แทรกตารางว่าง")),
  );

  // pasting a picture, or a table copied from Word/Excel, straight into the text box
  ta.addEventListener("paste", (e) => {
    const pics = [...e.clipboardData.files].filter((x) => x.type.startsWith("image/"));
    if (pics.length) { e.preventDefault(); addPictures(pics); return; }
    const html = e.clipboardData.getData("text/html");
    if (html && /<table/i.test(html)) {
      const rows = rowsFromClipboard(html, "");
      if (rows.length > 1 || rows[0]?.length > 1) { e.preventDefault(); insert("table", { kind: "table", rows }); }
    }
  });

  const gallery = el("div", { class: "gallery" });
  let shown = null;
  function drawGallery() {
    const ids = markIds(ta.value).filter((id) => media()[id]);
    if (ids.join("|") === shown) return;
    shown = ids.join("|");
    gallery.replaceChildren(...ids.map((id) => mediaCard(f, ta, id, commit)));
  }
  ta.addEventListener("input", drawGallery);
  drawGallery();

  return el("div", { class: "media-field" },
    ta,
    el("div", { class: "toolbar" },
      el("button", { type: "button", class: "btn", onclick: () => pick.click() }, "แทรกรูป"),
      el("button", { type: "button", class: "btn", onclick: () => { panel.classList.toggle("hidden"); pasteBox.focus(); } }, "แทรกตาราง"),
      el("span", { class: "hint" }, "รูปหรือตารางจะอยู่ตรงตำแหน่งของ [[รูป 1]] หรือ [[ตาราง 1]] ในข้อความ ย้ายได้ด้วยการตัดแล้ววาง และวางรูปหรือตารางลงในช่องข้อความได้โดยตรง"),
      pick),
    panel, gallery,
  );
}

function mediaCard(f, ta, id, commit) {
  const item = state.submission.media[id];
  const save = () => { set(state.submission, f.path, ta.value); touch(f.path); persist(); };
  const remove = () => {
    if (!confirm(`ลบ ${id} ออกจากข้อนี้?`)) return;
    ta.value = ta.value.replace(new RegExp(`\\n?\\[\\[${id}\\]\\]`), "").replace(/^\n/, "");
    delete state.submission.media[id];
    commit();
  };
  const card = el("div", { class: "mcard" }, el("div", { class: "head" }, el("b", {}, id),
    el("button", { type: "button", class: "btn quiet", onclick: remove }, "ลบ")));
  if (item.kind === "img") {
    card.append(el("img", { src: item.src, alt: item.name || id }));
    return card;
  }
  const t = itemNode(document, item, { editable: true });
  t.addEventListener("input", () => {
    item.rows = [...t.rows].map((tr) => [...tr.cells].map((td) => td.innerText.trim()));
    save();
  });
  const reshape = (fn) => { fn(item.rows); save(); card.replaceWith(mediaCard(f, ta, id, commit)); };
  card.append(el("div", { class: "grid" }, t), el("div", { class: "toolbar" },
    el("button", { type: "button", class: "btn quiet", onclick: () => reshape((r) => r.push(Array(Math.max(1, ...r.map((x) => x.length))).fill(""))) }, "เพิ่มแถว"),
    el("button", { type: "button", class: "btn quiet", onclick: () => reshape((r) => r.forEach((x) => x.push(""))) }, "เพิ่มคอลัมน์"),
    el("button", { type: "button", class: "btn quiet", onclick: () => reshape((r) => { if (r.length > 1) r.pop(); }) }, "ลบแถวท้าย"),
    el("button", { type: "button", class: "btn quiet", onclick: () => reshape((r) => r.forEach((x) => { if (x.length > 1) x.pop(); })) }, "ลบคอลัมน์ท้าย"),
    el("span", { class: "hint" }, "คลิกในช่องตารางเพื่อแก้ข้อความ แถวแรกเป็นหัวตาราง"),
  ));
  return card;
}

const dependents = (path) => SECTIONS.some((s) => s.fields.some((f) => f.when && f.when.includes(path)));

function boolInput(f, v) {
  const seg = el("div", { class: "seg", role: "group" });
  for (const [val, label] of [[true, "ใช่"], [false, "ไม่ใช่"], [null, "ไม่ระบุ"]]) {
    seg.append(el("button", {
      type: "button", class: v === val || (val === null && v === undefined) ? "on" : "",
      onclick: () => onEdit(f, val, { rerender: true }),
    }, label));
  }
  return seg;
}

function selectInput(f, v) {
  const sel = el("select", {}, el("option", { value: "" }, "(เลือก)"), f.options.map(([val, label]) => el("option", { value: val, selected: v === val }, label)));
  sel.addEventListener("change", () => onEdit(f, sel.value || null, { rerender: true }));
  return sel;
}

function checksInput(f, v) {
  const box = el("div", { class: "checks" });
  for (const [key, label] of f.options) {
    const cb = el("input", { type: "checkbox", checked: Boolean(v?.[key]) });
    cb.addEventListener("change", () => {
      const obj = { ...(get(state.submission, f.path) || {}) };
      obj[key] = cb.checked;
      onEdit(f, obj, { rerender: true });
    });
    box.append(el("label", {}, cb, label));
  }
  return box;
}

function cellInput(col, value, onChange) {
  if (col.type === "select") {
    const s = el("select", {}, el("option", { value: "" }, ""), col.options.map(([v, l]) => el("option", { value: v, selected: value === v }, l)));
    s.addEventListener("change", () => onChange(s.value || null));
    return s;
  }
  if (col.type === "months") {
    const arr = Array.isArray(value) ? [...value] : Array(12).fill(false);
    while (arr.length < 12) arr.push(false);
    const wrap = el("div", { class: "months" });
    for (let i = 0; i < 12; i++) {
      const cb = el("input", { type: "checkbox", title: `เดือนที่ ${i + 1}`, checked: Boolean(arr[i]) });
      cb.addEventListener("change", () => { arr[i] = cb.checked; onChange([...arr]); });
      wrap.append(cb);
    }
    return wrap;
  }
  const i = el("input", { type: "text" });
  i.value = value ?? "";
  i.addEventListener("input", () => onChange(i.value));
  return i;
}

function gridInput(f, rows, { single = false } = {}) {
  const list = single ? [rows || {}] : (rows || []);
  const commit = (next, rerender = false) => onEdit(f, single ? next[0] : next, { rerender });
  const table = el("table", {},
    el("thead", {}, el("tr", {}, f.cols.map((c) => el("th", {}, c.label)), single ? null : el("th", {}, ""))));
  const tb = el("tbody");
  list.forEach((row, ri) => {
    tb.append(el("tr", {},
      f.cols.map((c) => el("td", {}, cellInput(c, row?.[c.key], (val) => {
        const next = list.map((r) => ({ ...r }));
        next[ri][c.key] = val;
        commit(next);
      }))),
      single ? null : el("td", {}, el("button", { type: "button", class: "btn quiet", title: "ลบแถว",
        onclick: () => commit(list.filter((_, k) => k !== ri), true) }, "ลบ")),
    ));
  });
  table.append(tb);
  const wrap = el("div", { class: "grid" }, table);
  if (!single) {
    wrap.append(el("button", { type: "button", class: "btn quiet", style: "margin-top:4px",
      onclick: () => commit([...list, Object.fromEntries(f.cols.map((c) => [c.key, c.type === "months" ? Array(12).fill(false) : c.key === "status" ? "lecturer" : ""]))], true) }, "เพิ่มแถว"));
  }
  return wrap;
}

// Budget lines from the proposal, each with the EC heading it counts under (AP 02 ข้อ 17.2).
// Changing a heading recomputes the 8 totals below it.
const baht = (n) => Number(n).toLocaleString("th-TH", { maximumFractionDigits: 2 });
function budgetMapInput(f, items) {
  if (!Array.isArray(items) || !items.length) return el("p", { class: "hint" }, "ไฟล์ข้อเสนอไม่มีตารางงบประมาณที่อ่านได้ (หรือเป็น PDF) กรอกยอดของแต่ละหมวดในช่องด้านล่างเอง");
  const s = state.submission;
  const sumAll = items.reduce((a, x) => a + x.amount, 0);
  const total = s.funding?.amount_baht;
  const tb = el("tbody");
  items.forEach((x, i) => {
    const sel = el("select", {}, EC_BUDGET.map(([k, label]) => el("option", { value: k, selected: x.cat === k }, label)));
    sel.addEventListener("change", () => {
      const next = items.map((y, j) => (j === i ? { ...y, cat: sel.value } : y));
      set(s, f.path, next);
      s.ap02.budget = { ...(s.ap02.budget || {}), ...budgetSums(next) };
      touch(f.path);
      refreshDerived();
      persist();
      renderReview(true);
      renderSummary();
    });
    tb.append(el("tr", {},
      el("td", {}, x.item, x.detail ? el("div", { class: "hint" }, x.detail) : null, x.group ? el("div", { class: "tags" }, x.group) : null),
      el("td", { class: "num" }, baht(x.amount)),
      el("td", {}, sel)));
  });
  const off = total != null && Math.abs(sumAll - total) >= 1;
  return el("div", { class: "grid budgetmap" },
    el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "รายการในข้อเสนอ"), el("th", {}, "บาท"), el("th", {}, "หมวดของ EC"))),
      tb,
      el("tfoot", {}, el("tr", {}, el("td", {}, "รวมทุกรายการ"), el("td", { class: "num" }, baht(sumAll)),
        el("td", { class: off ? "warn" : "muted" }, total == null ? "" : off ? `ไม่เท่ากับยอดเงินทุน ${baht(total)} บาท ตรวจว่ามีรายการหลุดไหม` : "เท่ากับยอดเงินทุน")))));
}

function coiInput(f, decls) {
  const wrap = el("div");
  (decls || []).forEach((d, di) => {
    const card = el("div", { class: "coi-card" }, el("b", {}, d.person_name || `ผู้วิจัยคนที่ ${di + 1}`));
    for (const [key, label] of COI_ITEMS) {
      const item = d[key] || { disclosed: false, detail: "" };
      const seg = el("div", { class: "seg" });
      for (const [val, l] of [[true, "ใช่"], [false, "ไม่ใช่"]]) {
        seg.append(el("button", { type: "button", class: item.disclosed === val ? "on" : "", onclick: () => {
          const next = structuredClone(decls);
          next[di][key] = { ...item, disclosed: val };
          onEdit(f, next, { rerender: true });
        } }, l));
      }
      card.append(el("div", { class: "row" }, el("span", {}, label), seg));
      if (item.disclosed) {
        const inp = el("input", { type: "text", placeholder: "ระบุรายละเอียด" });
        inp.value = item.detail || "";
        inp.addEventListener("input", () => {
          const next = structuredClone(get(state.submission, f.path));
          next[di][key] = { ...next[di][key], detail: inp.value };
          onEdit(f, next);
        });
        card.append(inp);
      }
    }
    if (COI_ITEMS.some(([k]) => d[k]?.disclosed)) {
      const ta = el("textarea", { placeholder: "แนวทางการจัดการผลประโยชน์ทับซ้อน" });
      ta.value = d.management_plan || "";
      ta.addEventListener("input", () => {
        const next = structuredClone(get(state.submission, f.path));
        next[di].management_plan = ta.value;
        onEdit(f, next);
      });
      card.append(ta);
    }
    wrap.append(card);
  });
  return wrap;
}

function fieldEl(f) {
  const st = status(f);
  const v = get(state.submission, f.path);
  let input;
  if (f.type === "bool") input = boolInput(f, v);
  else if (f.type === "select") input = selectInput(f, v);
  else if (f.type === "checks") input = checksInput(f, v);
  else if (f.type === "people" || f.type === "table") input = gridInput(f, v);
  else if (f.type === "person") input = gridInput(f, v, { single: true });
  else if (f.type === "coi") input = coiInput(f, v);
  else if (f.type === "budgetmap") input = budgetMapInput(f, v);
  else input = textInput(f, v);

  const node = el("div", { class: `f ${st.kind === "todo" ? "empty" : ""} ${f.doc ? "doc" : ""}`, "data-path": f.path, "data-kind": st.kind },
    headEl(f, st),
    f.hint ? el("div", { class: "hint" }, f.hint) : null,
    input,
  );
  if (["area", "list"].includes(f.type) && state.outline?.length) node.append(headingPicker(f));
  if (["text", "area", "list"].includes(f.type) && !isEmpty(v)) {
    const q = sourceSnippet(v);
    if (q) node.append(el("details", { class: "src" }, el("summary", {}, "ดูข้อความต้นฉบับที่ดึงมา"), q));
  }
  if (st.kind === "hide" || (onlyTodo && !["todo", "guess"].includes(st.kind))) node.classList.add("hidden");
  return node;
}

// Label, status chip, and for a yellow item the button that accepts it as it is.
function headEl(f, st) {
  const confirmText = st.text?.startsWith("ลอกจากข้อเสนอ") ? "ยืนยันว่าอ่านง่ายแล้ว"
    : st.text?.startsWith("Claude") ? "ยืนยันร่างของ Claude" : "ยืนยันว่าถูกต้อง";
  return el("div", { class: "head" },
    el("span", { class: "lab" }, f.label), chip(st),
    st.kind === "guess" ? el("button", { type: "button", class: "btn confirm", title: "ใช้ข้อมูลนี้ตามที่เป็นอยู่ ป้ายจะเปลี่ยนเป็นสีเขียว", onclick: () => confirmField(f) }, confirmText) : null,
    el("span", { class: "tags" }, (f.forms || []).map(codeTH).join(", ")));
}

function confirmField(f) {
  const v = get(state.submission, f.path);
  if (isEmpty(v) && !["bool", "checks", "coi"].includes(f.type)) return;
  state.confirmed = [...new Set([...(state.confirmed || []), f.path])];
  touch(f.path);
  persist();
  updateField(f);
  renderSummary();
}

// Where a long field came from in the uploaded file, and a list of all the file's headings
// to take it from another one: so a proposal in any layout can be completed by hand-picking
// the right section, without a rule for that layout.
function headingPicker(f) {
  const from = state.sources?.[f.path];
  const sel = el("select", {}, el("option", { value: "" }, "เลือกหัวข้อในไฟล์..."),
    state.outline.map((h, k) => el("option", { value: String(k) }, `${"  ".repeat(Math.max(0, Math.min(h.level, 6) - 1))}${h.text.slice(0, 90)}`)));
  const note = el("span", { class: "hint" });
  sel.addEventListener("change", () => {
    if (sel.value === "") return;
    const k = Number(sel.value);
    const lines = String(state.source || "").split("\n");
    const v = valueFromSection(lines, state.outline, k, f.type === "list" ? "list" : "area");
    if (v == null || (Array.isArray(v) && !v.length)) {
      note.textContent = "หัวข้อนี้ไม่มีเนื้อหาให้ดึง ลองหัวข้ออื่น";
      sel.value = "";
      return;
    }
    state.sources = { ...(state.sources || {}), [f.path]: `หัวข้อ "${state.outline[k].text}"` };
    onEdit(f, v, { rerender: true });
  });
  return el("details", { class: "pick" },
    el("summary", {}, from ? `ดึงจาก ${from} (เปลี่ยนหัวข้อได้)` : "ดึงจากหัวข้อในไฟล์"),
    el("div", { class: "toolbar" }, sel, note));
}

// Update chip + border of one field without rebuilding its input (keeps focus while typing).
function updateField(f) {
  const node = document.querySelector(`.f[data-path="${CSS.escape(f.path)}"]`);
  if (!node) return;
  const st = status(f);
  node.classList.toggle("empty", st.kind === "todo");
  node.dataset.kind = st.kind;
  node.querySelector(".head").replaceWith(headEl(f, st));
  updateNav();
}

// ---------------------------------------------------------------- what is still missing

// Every visible field with its status, in page order.
const fieldList = () => SECTIONS.flatMap((sec) => sec.fields.map((f) => ({ sec, f, st: status(f) })))
  .filter((x) => x.st.kind !== "hide");

// ---------------------------------------------------------------- one tab per form

// The review shows one form at a time; a field several forms print (the title, the team)
// sits in each of their tabs and is the same value everywhere.
const TAB_NAME = { AP01_1: "แบบรายงานการส่งโครงการ", AP01_2: "เปิดเผยผลประโยชน์ทับซ้อน", AP02: "แบบเสนอโครงการ",
  AP03_1: "เอกสารชี้แจงผู้เข้าร่วม", FEE: "แจ้งชำระค่าธรรมเนียม", ALL: "ทุกข้อรวมกัน" };
const TAB_KEY = "ecmfu.tab";
let activeTab = null;
const tabCodes = () => [...new Set([...(state.submission._forms || []).map((f) => f.code).filter((c) => FORM_FILES[c]), "FEE"]), "ALL"];
const inTab = (f, tab = activeTab) => tab === "ALL" || (f.forms || []).includes(tab);
function currentTab() {
  const codes = tabCodes();
  if (!codes.includes(activeTab)) {
    let saved = null;
    try { saved = localStorage.getItem(TAB_KEY); } catch { /* blocked */ }
    activeTab = codes.includes(saved) ? saved : codes[0];
  }
  return activeTab;
}
function setTab(code) {
  activeTab = code;
  try { localStorage.setItem(TAB_KEY, code); } catch { /* blocked */ }
}
function tabProgress(code) {
  if (code !== "ALL") return formProgress(code);
  const need = fieldList().filter((x) => !x.f.optional);
  return { done: need.filter((x) => x.st.kind !== "todo").length, total: need.length };
}

function updateNav() {
  const tab = currentTab();
  const all = fieldList();
  const todo = all.filter((x) => x.st.kind === "todo");
  const guess = all.filter((x) => x.st.kind === "guess");
  const done = all.filter((x) => x.st.kind === "ok").length;
  // the tab strip, the section links and the jump buttons follow the open tab
  const here = all.filter((x) => inTab(x.f, tab));
  const todoHere = here.filter((x) => x.st.kind === "todo");
  const guessHere = here.filter((x) => x.st.kind === "guess");

  document.querySelectorAll(".ftab[data-tab]").forEach((b) => {
    const p = tabProgress(b.dataset.tab);
    const pct = p.total ? Math.round((100 * p.done) / p.total) : 100;
    b.querySelector(".pct").textContent = `${pct}%`;
    b.querySelector(".mini i").style.width = `${pct}%`;
    b.classList.toggle("complete", pct === 100);
  });

  $("#secnav")?.replaceChildren(...SECTIONS.filter((sec) => sec.fields.some((f) => inTab(f, tab))).map((sec) => {
    const t = todoHere.filter((x) => x.sec === sec).length;
    const g = guessHere.filter((x) => x.sec === sec).length;
    return el("a", { href: `#sec-${sec.id}`, class: t ? "has-todo" : g ? "has-guess" : "all-ok" }, sec.title,
      t ? el("span", { class: "n todo", title: "ต้องกรอก" }, String(t)) : null,
      g ? el("span", { class: "n guess", title: "ควรตรวจ" }, String(g)) : null);
  }));

  const box = $("#todo");
  if (box) {
    const group = (items, kind) => {
      const bySec = new Map();
      items.forEach((x) => bySec.set(x.sec, [...(bySec.get(x.sec) || []), x]));
      return [...bySec].map(([sec, xs]) => el("div", { class: "tgroup" },
        el("div", { class: "tsec" }, sec.title),
        el("div", { class: "tchips" }, xs.map((x) => el("button", { type: "button", class: `tchip ${kind}`, title: x.st.text,
          onclick: () => gotoField(x.f.path) }, x.f.label.replace(/\s*\(.*$/, ""))))));
    };
    const total = todo.length + guess.length + done;
    box.replaceChildren(
      el("div", { class: "tsum" },
        el("div", { class: "tbar" },
          el("i", { class: "ok", style: `width:${total ? (100 * done) / total : 0}%` }),
          el("i", { class: "guess", style: `width:${total ? (100 * guess.length) / total : 0}%` }),
          el("i", { class: "todo", style: `width:${total ? (100 * todo.length) / total : 0}%` })),
        el("div", { class: "tleg" },
          el("span", { class: "k todo" }, `ต้องกรอก ${todo.length}`),
          el("span", { class: "k guess" }, `ควรตรวจ ${guess.length}`),
          el("span", { class: "k ok" }, `ครบแล้ว ${done}`))),
      todo.length
        ? el("details", { class: "tlist", open: true }, el("summary", {}, `ข้อที่ยังว่าง ต้องกรอกก่อนพิมพ์ (${todo.length}) คลิกเพื่อไปที่ช่องนั้น`), group(todo, "todo"))
        : el("p", { class: "tdone" }, "กรอกข้อที่จำเป็นครบแล้ว"),
      guess.length
        ? el("details", { class: "tlist", open: !todo.length }, el("summary", {}, `ข้อที่ควรตรวจ: เครื่องเดา ลอกจากข้อเสนอ หรือ Claude ร่าง (${guess.length}) ถ้าถูกต้องแล้วกดปุ่มยืนยันที่ข้อนั้น`), group(guess, "guess"))
        : null,
    );
  }

  const bar = $("#nextbar");
  if (bar) {
    bar.classList.toggle("hidden", !todoHere.length && !guessHere.length);
    const where = tab === "ALL" ? "" : ` ใน ${codeTH(tab)}`;
    bar.replaceChildren(
      todoHere.length ? el("button", { type: "button", class: "btn todo", onclick: () => gotoNext("todo") }, `ไปข้อที่ต้องกรอกถัดไป${where} (${todoHere.length})`) : null,
      guessHere.length ? el("button", { type: "button", class: "btn guess", onclick: () => gotoNext("guess") }, `ไปข้อที่ควรตรวจถัดไป${where} (${guessHere.length})`) : null,
    );
  }
}

// The next field of this kind below the current view (wraps to the top).
function gotoNext(kind) {
  const nodes = [...document.querySelectorAll(`#review .f[data-kind="${kind}"]`)];
  if (!nodes.length) return;
  const next = nodes.find((n) => n.getBoundingClientRect().top > 130) || nodes[0];
  gotoField(next.dataset.path);
}

// Scroll to a field, open it if a filter hides it, focus its input and flash it.
// `path` may be deeper than the field (a form gap such as "co_investigators.0.email").
function gotoField(path) {
  if (!state) return;
  const all = SECTIONS.flatMap((s) => s.fields);
  const f = all.find((x) => x.path === path)
    || all.filter((x) => path.startsWith(`${x.path}.`)).sort((a, b) => b.path.length - a.path.length)[0]
    || all.find((x) => x.path.startsWith(`${path}.`));
  if (!f) return;
  // a field of another form: open the first tab that holds it
  if (!inTab(f, currentTab())) {
    setTab(tabCodes().find((c) => inTab(f, c)) || "ALL");
    renderReview(true);
  }
  let node = document.querySelector(`.f[data-path="${CSS.escape(f.path)}"]`);
  if (node?.classList.contains("hidden") && onlyTodo) {
    onlyTodo = false;
    renderReview(true);
    node = document.querySelector(`.f[data-path="${CSS.escape(f.path)}"]`);
  }
  if (!node || node.classList.contains("hidden")) return;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  node.classList.remove("flash");
  void node.offsetWidth;
  node.classList.add("flash");
  const inp = node.querySelector("textarea, input:not([type=file]), select, .seg button");
  setTimeout(() => inp?.focus({ preventScroll: true }), 350);
}

function gotoFromHash() {
  const m = location.hash.match(/^#goto=(.+)$/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  setTimeout(() => gotoField(decodeURIComponent(m[1])), 50);
}

// ---------------------------------------------------------------- Claude assist (option D2)

const allFields = () => SECTIONS.flatMap((sec) => sec.fields.map((field) => ({ field, status: status(field) })));
let assistResult = null; // result of the last import, shown in the panel

function assistPanel() {
  const picked = pickFields(allFields());
  const perForm = ["AP01_1", "AP02", "AP03_1"].map((c) => [c, picked.filter((p) => (p.field.forms || []).includes(c)).length]);
  const box = el("details", { class: "assist", open: assistResult ? true : null },
    el("summary", {}, `ให้ Claude ช่วยร่างช่องที่ยังว่างและเขียน AP 03_1 เป็นภาษาง่าย (${picked.length} ช่อง)`,
      el("span", { class: "per-form" }, perForm.map(([c, n]) => el("span", {}, `${codeTH(c)} ${n}`)))));
  box.append(
    el("p", { class: "hint" }, "ร่างได้ทั้ง AP 01_1, AP 02 และ AP 03_1 ส่วน AP 01_2 (การเปิดเผยผลประโยชน์ทับซ้อน) และเอกสารแจ้งชำระค่าธรรมเนียม ผู้วิจัยต้องกรอกเอง เพราะเป็นคำยืนยันส่วนบุคคลและข้อมูลการเงิน"),
    el("p", { class: "note" }, "หน้านี้ไม่ส่งข้อมูลออกไปเอง: กด \"คัดลอก prompt\" แล้ววางใน Claude (claude.ai หรือแอป Claude) ด้วยตัวเอง prompt มีข้อความข้อเสนอทั้งฉบับ การวางลงใน Claude คือการส่งข้อมูลนั้นให้บริการ AI ภายนอก ตรวจให้แน่ใจว่าเป็นไปตามนโยบายข้อมูลของโครงการ"),
    el("p", { class: "hint" }, "ไม่รวม: ชื่อและข้อมูลติดต่อคณะผู้วิจัย, การเปิดเผยผลประโยชน์ทับซ้อน, วันที่, จำนวนเงินทุน และการเลือกใบเสร็จ เพราะผู้วิจัยต้องยืนยันเอง"),
  );
  const out = el("textarea", { class: "prompt", readonly: true, rows: 6 });
  const copyBtn = el("button", { type: "button", class: "btn", disabled: true }, "คัดลอก prompt");
  const makeBtn = el("button", { type: "button", class: "btn primary" }, "1. สร้าง prompt");
  const info = el("span", { class: "hint" });
  makeBtn.addEventListener("click", () => {
    const now = pickFields(allFields());
    state.aiAsked = now.map((p) => p.field.path);
    persist();
    out.value = buildPrompt(state.submission, state.source, now);
    copyBtn.disabled = false;
    info.textContent = `${now.length} ช่อง, ยาว ${out.value.length.toLocaleString("th-TH")} ตัวอักษร`;
  });
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(out.value);
      copyBtn.textContent = "คัดลอกแล้ว";
    } catch {
      out.select();
      copyBtn.textContent = "เลือกข้อความแล้ว กด Cmd+C";
    }
    setTimeout(() => { copyBtn.textContent = "คัดลอก prompt"; }, 2500);
  });
  const answer = el("textarea", { class: "answer", rows: 6, placeholder: "2. วางคำตอบ JSON จาก Claude ที่นี่" });
  const applyBtn = el("button", { type: "button", class: "btn primary" }, "3. นำเข้าคำตอบ");
  const result = el("div", { class: "assist-result" });
  applyBtn.addEventListener("click", () => {
    try {
      const asked = new Set(state.aiAsked || []);
      if (!asked.size) throw new Error("ยังไม่ได้สร้าง prompt กดปุ่มที่ 1 ก่อน");
      const picks = allFields().filter((x) => asked.has(x.field.path));
      const r = applyResponse(state.submission, picks, parseResponse(answer.value));
      state.ai = [...new Set([...(state.ai || []), ...r.applied])];
      state.touched = state.touched.filter((p) => !r.applied.includes(p));
      assistResult = r;
      refreshDerived();
      persist();
      renderSummary();
      renderReview(true);
    } catch (e) {
      result.replaceChildren(el("div", { class: "err" }, e.message));
    }
  });
  if (assistResult) {
    const r = assistResult;
    result.append(
      el("p", {}, `นำเข้าแล้ว ${r.applied.length} ช่อง (ขึ้นป้าย "Claude ร่าง ตรวจ" จนกว่าจะแก้)` + (r.skipped.length ? `, ข้าม ${r.skipped.length} ช่อง` : "")),
      ...(r.skipped.length ? [el("ul", { class: "hint" }, r.skipped.map((x) => el("li", {}, `${x.path}: ${x.why}`)))] : []),
      ...(r.notes.length ? [el("p", { class: "lab" }, "ข้อสังเกตจาก Claude"), el("ul", {}, r.notes.map((n) => el("li", {}, n)))] : []),
    );
  }
  box.append(
    el("div", { class: "toolbar" }, makeBtn, copyBtn, info), out,
    answer, el("div", { class: "toolbar" }, applyBtn), result,
  );
  return box;
}

function renderReview(keepScroll = false) {
  const y = window.scrollY;
  const tab = currentTab();
  const box = $("#review");
  box.classList.remove("hidden");
  box.replaceChildren(
    el("div", { class: "card" },
      el("h2", {}, "ตรวจและแก้ข้อมูล"),
      el("p", { class: "muted" }, "กรอกทุกอย่างในหน้านี้ แบบฟอร์มที่เปิดพิมพ์จะดึงข้อมูลจากที่นี่และอัปเดตเอง สีแดง = ยังว่าง ต้องกรอก, สีเหลือง = เครื่องเดา ลอกจากข้อเสนอ หรือ Claude ร่าง ควรตรวจแล้วกดยืนยัน, สีเขียว = ครบแล้ว"),
      el("div", { class: "todo-box", id: "todo" }),
      el("div", { class: "toolbar" }, el("label", {}, el("input", { type: "checkbox", checked: onlyTodo, onchange: (e) => { onlyTodo = e.target.checked; renderReview(true); } }), " แสดงเฉพาะข้อที่ต้องดู")),
      assistPanel(),
    ),
    tabStrip(tab),
    tabHead(tab),
    ...SECTIONS.filter((sec) => sec.fields.some((f) => inTab(f, tab))).map((sec) => el("section", { class: "card sec", id: `sec-${sec.id}` },
      el("h2", {}, sec.title),
      sec.note ? el("p", { class: "note" }, sec.note) : null,
      sec.fields.filter((f) => inTab(f, tab)).map(fieldEl),
    )),
    el("div", { class: "nextbar hidden", id: "nextbar" }),
  );
  // on a phone the strip scrolls sideways: bring the open tab into it
  const strip = $("#ftabs");
  const on = strip?.querySelector(".ftab.on");
  if (on && (on.offsetLeft < strip.scrollLeft || on.offsetLeft + on.offsetWidth > strip.scrollLeft + strip.clientWidth)) {
    strip.scrollLeft = on.offsetLeft - 8;
  }
  updateNav();
  if (keepScroll) window.scrollTo(0, y);
}

function tabStrip(tab) {
  return el("div", { class: "ftabs", id: "ftabs", role: "tablist", "aria-label": "เลือกแบบฟอร์ม" },
    tabCodes().map((code) => el("button", {
      type: "button", role: "tab", class: `ftab ${code === tab ? "on" : ""} ${code === "ALL" ? "all" : ""}`, "data-tab": code,
      "aria-selected": code === tab ? "true" : "false",
      onclick: () => {
        if (code === activeTab) return;
        const top = $("#ftabs").getBoundingClientRect().top;
        setTab(code);
        renderReview();
        // keep the strip where it was on screen, so the new form starts right under it
        window.scrollTo(0, Math.max(0, $("#ftabs").getBoundingClientRect().top + window.scrollY - Math.max(top, 0)));
      },
    },
    el("span", { class: "code" }, code === "ALL" ? "ทั้งหมด" : codeTH(code)),
    el("span", { class: "name" }, TAB_NAME[code] || code),
    el("span", { class: "prog" }, el("span", { class: "mini" }, el("i")), el("span", { class: "pct" }, "")))));
}

// Title of the open form, why it is needed, and its print link.
function tabHead(tab) {
  if (tab === "ALL") return el("div", { class: "card tabhead" }, el("p", { class: "muted" }, "ทุกข้อของทุกแบบฟอร์มในหน้าเดียว"), el("nav", { class: "secs", id: "secnav" }));
  const form = (state.submission._forms || []).find((f) => f.code === tab);
  const title = tab === "FEE" ? "เอกสารแจ้งชำระค่าธรรมเนียม EC" : form?.title || TAB_NAME[tab];
  return el("div", { class: "card tabhead" },
    el("div", { class: "row" },
      el("div", {}, el("h2", {}, `${codeTH(tab)} ${title}`), el("p", { class: "muted" }, tab === "FEE" ? "ทุกโครงการ (Package 4.0 ข้อ 9)" : form?.reason || "")),
      FORM_FILES[tab] ? el("a", { class: "btn", href: `forms/${FORM_FILES[tab]}?data=local`, target: "_blank" }, "เปิดเพื่อพิมพ์") : null),
    el("nav", { class: "secs", id: "secnav" }));
}

function renderAll() {
  $("#intro").classList.toggle("hidden", Boolean(state));
  if (!state) {
    $("#summary").classList.add("hidden");
    $("#review").classList.add("hidden");
    return;
  }
  // the document date on every form header starts as today; the researcher may change it
  // Version starts at 1.0 (first submission); the researcher raises it for each revision
  const meta = state.submission.meta;
  if (!meta.doc_date || !String(meta.doc_version ?? "").trim()) {
    if (!meta.doc_date) meta.doc_date = todayIso();
    if (!String(meta.doc_version ?? "").trim()) meta.doc_version = "1.0";
    persist(); // so the forms print it too
  }
  refreshDerived();
  renderSummary();
  renderReview();
}

// ---------------------------------------------------------------- save / open / clear

function download(name, text) {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "application/json" })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function boot() {
  // forms open their gaps here by this tab name (fill.js), via #goto=<path>
  window.name = "ecmfu-main";
  // the tab strip sticks right under the page header, whose height changes with the width
  const header = $("header.top");
  const setHdr = () => document.documentElement.style.setProperty("--hdr", `${header?.offsetHeight || 0}px`);
  if (header && "ResizeObserver" in window) new ResizeObserver(setHdr).observe(header);
  setHdr();
  window.addEventListener("hashchange", gotoFromHash);
  const drop = $("#drop");
  const pick = $("#file");
  drop.addEventListener("click", () => pick.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick.click(); } });
  pick.addEventListener("change", () => { handleFiles(pick.files); pick.value = ""; });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); handleFiles(e.dataTransfer.files); });

  $("#save").addEventListener("click", () => {
    if (!state) return;
    const base = (state.fileName || "ec-mfu").split(", ")[0].replace(/\.[^.]+$/, "");
    download(`${base}.ec-mfu.json`, JSON.stringify(state, null, 1));
  });
  $("#open").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) await openSaved(f);
    e.target.value = "";
  });
  $("#clear").addEventListener("click", () => {
    if (!confirm("ล้างข้อมูลโครงการที่เก็บไว้ในเบราว์เซอร์นี้? (ไฟล์ที่บันทึกไว้เองไม่ถูกลบ)")) return;
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    saveMedia({}).catch(() => {});
    state = null;
    showSaved("");
    renderAll();
  });

  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved?.submission) {
      state = { touched: [], ...saved };
      if (state.savedAt) showSaved(`เปิดงานที่บันทึกไว้ ${new Date(state.savedAt).toLocaleDateString("th-TH", { day: "numeric", month: "short" })} ${hhmm(state.savedAt)} น.`);
    }
  } catch { /* nothing saved or storage blocked */ }
  if (state && !state.submission.media) state.submission.media = await loadMedia();
  renderAll();
  gotoFromHash();
}

boot();
