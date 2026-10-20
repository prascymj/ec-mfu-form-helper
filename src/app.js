// EC-MFU page: upload a proposal, review what was extracted, open the forms to print.
// Everything runs in this browser tab; the proposal is never sent anywhere.

import { loadDocument } from "./loaders.js";
import { extractSubmission, computeFee, selectForms, recommendReview } from "./extract.js";
import { SECTIONS, COI_ITEMS, MANUAL_DOCS } from "./fields.js";
import { pickFields, buildPrompt, parseResponse, applyResponse } from "./assist.js";

const STORE_KEY = "ecmfu.current";
const FORM_FILES = { AP01_1: "ap01_1.html", AP01_2: "ap01_2.html", AP02: "ap02.html", AP03_1: "ap03_1.html", FEE: "fee.html" };
const REVIEW_TH = {
  exempt: "ยกเว้นการพิจารณา (Exempt)",
  expedited: "พิจารณาแบบเร่งรัด (Expedited)",
  full_board: "พิจารณาเต็มคณะ (Full board)",
};

let state = null; // { submission, source, fileName, savedAt, touched: [] }
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
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      showSaved(`บันทึกในเบราว์เซอร์นี้แล้ว ${hhmm(state.savedAt)} น.`);
    } catch {
      showSaved("บันทึกในเบราว์เซอร์ไม่ได้ กด \"บันทึกงาน (.json)\" เก็บไว้", true);
    }
  }, 250);
}

function touch(path) {
  if (!state.touched.includes(path)) state.touched.push(path);
}

// ---------------------------------------------------------------- upload

async function handleFile(file) {
  const err = $("#err");
  err.classList.add("hidden");
  $("#drop b").textContent = `กำลังอ่าน ${file.name} ...`;
  try {
    const { text, tables } = await loadDocument(file.name, await file.arrayBuffer());
    if (!text.trim()) throw new Error("ไม่พบข้อความในไฟล์");
    const submission = extractSubmission(text, tables);
    state = { submission, source: text, fileName: file.name, savedAt: null, touched: [] };
    assistResult = null;
    persist();
    renderAll();
    $("#summary").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    err.textContent = e.message || String(e);
    err.classList.remove("hidden");
  } finally {
    $("#drop b").textContent = "ลากไฟล์ข้อเสนอโครงการมาวาง หรือคลิกเพื่อเลือก";
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

function renderSummary() {
  const s = state.submission;
  const box = $("#summary");
  box.replaceChildren();
  box.classList.remove("hidden");
  box.append(
    el("h2", {}, "สรุปชุดเอกสาร"),
    el("p", { class: "muted" }, `ไฟล์: ${state.fileName}`),
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
      el("td", {}, el("b", {}, codeTH(f.code)), el("br"), f.title),
      el("td", { class: "muted" }, f.reason),
      el("td", {}, file ? [el("div", { class: "bar", title: `${p.done}/${p.total}` }, el("i", { style: `width:${pct}%` })), el("small", { class: "muted" }, `กรอกแล้ว ${p.done} จาก ${p.total}`)] : ""),
      el("td", {}, file
        ? el("a", { class: "btn", href: `forms/${file}?data=local`, target: "_blank", rel: "noopener" }, "เปิดเพื่อพิมพ์")
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
  refreshDerived();
  persist();
  if (rerender) renderReview(true);
  else updateField(f);
  renderSummary();
}

function textInput(f, v) {
  if (f.type === "area" || f.type === "list") {
    const ta = el("textarea", { rows: f.type === "list" ? 4 : Math.min(10, Math.max(3, Math.ceil(String(v ?? "").length / 90))) });
    ta.value = f.type === "list" ? (v || []).join("\n") : (v ?? "");
    ta.addEventListener("input", () => onEdit(f, f.type === "list" ? ta.value.split("\n").map((x) => x.trim()).filter(Boolean) : ta.value));
    return ta;
  }
  const inp = el("input", { type: f.type === "number" ? "number" : f.type === "date" ? "date" : "text" });
  inp.value = v ?? "";
  inp.addEventListener("input", () => {
    const val = f.type === "number" ? (inp.value === "" ? null : Number(inp.value)) : (inp.value || (f.type === "date" ? null : ""));
    onEdit(f, val, { rerender: Boolean(dependents(f.path)) });
  });
  return inp;
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
  else input = textInput(f, v);

  const node = el("div", { class: `f ${st.kind === "todo" ? "empty" : ""}`, "data-path": f.path, "data-kind": st.kind },
    el("div", { class: "head" }, el("span", { class: "lab" }, f.label), chip(st), el("span", { class: "tags" }, (f.forms || []).map(codeTH).join(", "))),
    f.hint ? el("div", { class: "hint" }, f.hint) : null,
    input,
  );
  if (["text", "area", "list"].includes(f.type) && !isEmpty(v)) {
    const q = sourceSnippet(v);
    if (q) node.append(el("details", { class: "src" }, el("summary", {}, "ดูข้อความต้นฉบับที่ดึงมา"), q));
  }
  if (st.kind === "hide" || (onlyTodo && !["todo", "guess"].includes(st.kind))) node.classList.add("hidden");
  return node;
}

// Update chip + border of one field without rebuilding its input (keeps focus while typing).
function updateField(f) {
  const node = document.querySelector(`.f[data-path="${CSS.escape(f.path)}"]`);
  if (!node) return;
  const st = status(f);
  node.classList.toggle("empty", st.kind === "todo");
  node.dataset.kind = st.kind;
  node.querySelector(".chip").replaceWith(chip(st));
  updateNav();
}

function sectionCounts(sec) {
  let todo = 0;
  for (const f of sec.fields) {
    const k = status(f).kind;
    if (k === "todo" || k === "guess") todo++;
  }
  return todo;
}

function updateNav() {
  const nav = $("#secnav");
  nav.replaceChildren(...SECTIONS.map((sec) => {
    const n = sectionCounts(sec);
    return el("a", { href: `#sec-${sec.id}` }, sec.title, n ? [" ", el("span", {}, String(n))] : "");
  }));
}

// ---------------------------------------------------------------- Claude assist (option D2)

const allFields = () => SECTIONS.flatMap((sec) => sec.fields.map((field) => ({ field, status: status(field) })));
let assistResult = null; // result of the last import, shown in the panel

function assistPanel() {
  const picked = pickFields(allFields());
  const box = el("details", { class: "assist", open: assistResult ? true : null },
    el("summary", {}, `ให้ Claude ช่วยร่างช่องที่ยังว่างและเขียน AP 03_1 เป็นภาษาง่าย (${picked.length} ช่อง)`));
  box.append(
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
  const box = $("#review");
  box.classList.remove("hidden");
  box.replaceChildren(
    el("div", { class: "card" },
      el("h2", {}, "ตรวจและแก้ข้อมูล"),
      el("p", { class: "muted" }, "สีแดง = ยังว่าง ต้องกรอก, สีเหลือง = เครื่องเดาหรือลอกจากข้อเสนอ ควรตรวจ, สีเขียว = มีข้อมูลแล้ว ตัวเลขบนแถบหัวข้อคือจำนวนข้อที่ต้องดู"),
      el("nav", { class: "secs", id: "secnav" }),
      el("div", { class: "toolbar" }, el("label", {}, el("input", { type: "checkbox", checked: onlyTodo, onchange: (e) => { onlyTodo = e.target.checked; renderReview(true); } }), " แสดงเฉพาะข้อที่ต้องดู")),
      assistPanel(),
    ),
    ...SECTIONS.map((sec) => el("section", { class: "card sec", id: `sec-${sec.id}` },
      el("h2", {}, sec.title),
      sec.note ? el("p", { class: "note" }, sec.note) : null,
      sec.fields.map(fieldEl),
    )),
  );
  updateNav();
  if (keepScroll) window.scrollTo(0, y);
}

function renderAll() {
  $("#intro").classList.toggle("hidden", Boolean(state));
  if (!state) {
    $("#summary").classList.add("hidden");
    $("#review").classList.add("hidden");
    return;
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

function boot() {
  const drop = $("#drop");
  const pick = $("#file");
  drop.addEventListener("click", () => pick.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick.click(); } });
  pick.addEventListener("change", () => pick.files[0] && handleFile(pick.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

  $("#save").addEventListener("click", () => {
    if (!state) return;
    const base = (state.fileName || "ec-mfu").replace(/\.[^.]+$/, "");
    download(`${base}.ec-mfu.json`, JSON.stringify(state, null, 1));
  });
  $("#open").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      state = data.submission ? { touched: [], ...data } : { submission: data, source: "", fileName: f.name, touched: [] };
      persist();
      renderAll();
    } catch (err) {
      alert(`เปิดไฟล์งานไม่ได้: ${err.message}`);
    }
  });
  $("#clear").addEventListener("click", () => {
    if (!confirm("ล้างข้อมูลโครงการที่เก็บไว้ในเบราว์เซอร์นี้? (ไฟล์ที่บันทึกไว้เองไม่ถูกลบ)")) return;
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
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
  renderAll();
}

boot();
