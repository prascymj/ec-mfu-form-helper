// Fill an EC form page from an EthicsSubmission JSON (same shape as ec_mfu/schemas.py).
//
// Bindings used in forms/*.html (plain attributes, no framework):
//   data-f="a.b"           text value; empty -> dotted gap the researcher fills by hand
//   data-fmt="date|money|list|status"
//   data-c="a.b"           checkbox, ticked when truthy ("a.b==x" compares, "!a.b" negates)
//   data-yn="a.b" data-v="1|0"   yes/no pair; null or missing -> row flagged "unknown"
//   data-if="a.b"          keep the element only when truthy
//   data-each="list" data-min="3"   on <tbody>; repeats its <template> row, paths inside start with "."
// Every filled value is contenteditable on screen so the last wording fixes happen in place.

const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const STATUS_TH = { bachelor: "นักศึกษา ปริญญาตรี", master: "นักศึกษา ปริญญาโท",
  doctoral: "นักศึกษา ปริญญาเอก", lecturer: "อาจารย์", other: "อื่น ๆ" };

export function get(obj, path) {
  if (!path) return undefined;
  // ".__self" = the list item itself (lists of plain strings, e.g. criteria)
  return path.split(".").reduce((o, k) => (o == null ? undefined : k === "__self" ? o : o[k]), obj);
}

// 1500 -> "หนึ่งพันห้าร้อยบาทถ้วน" (whole baht only; EC fees have no satang)
export function bahtText(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n === 0) return "ศูนย์บาทถ้วน";
  const digit = ["", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
  const place = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];
  const group = (x) => {
    const s = String(x);
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const d = Number(s[i]);
      const p = s.length - i - 1;
      if (d === 0) continue;
      if (p === 1 && d === 1) out += "สิบ";
      else if (p === 1 && d === 2) out += "ยี่สิบ";
      else if (p === 0 && d === 1 && s.length > 1) out += "เอ็ด";
      else out += digit[d] + place[p];
    }
    return out;
  };
  const n0 = Math.floor(n);
  const millions = Math.floor(n0 / 1e6);
  const rest = n0 % 1e6;
  return (millions ? group(millions) + "ล้าน" : "") + group(rest) + "บาทถ้วน";
}

function isEmpty(v) {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0);
}

function fmt(v, kind) {
  if (isEmpty(v)) return "";
  if (kind === "date") {
    const d = new Date(v);
    if (isNaN(d)) return String(v);
    return `${d.getDate()} ${TH_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
  }
  if (kind === "monthyear") {
    const d = new Date(v);
    return isNaN(d) ? String(v) : `${TH_MONTHS[d.getMonth()]} พ.ศ. ${d.getFullYear() + 543}`;
  }
  if (kind === "money") return Number(v).toLocaleString("th-TH");
  if (kind === "bahttext") return bahtText(Number(v));
  if (kind === "list") return Array.isArray(v) ? v.map((x, i) => `${i + 1}. ${x}`).join("\n") : String(v);
  if (kind === "status") return STATUS_TH[v] || String(v);
  return Array.isArray(v) ? v.join(", ") : String(v);
}

// "a.b", "!a.b", "a.b==x|y", "a.b!=x", "p||q" -> boolean | null (null = unknown)
function test(data, expr) {
  // "none:a||b" -> true when every listed flag is false (e.g. "no vulnerable group")
  if (expr.startsWith("none:")) {
    const r = test(data, expr.slice(5));
    return r === null ? null : !r;
  }
  if (expr.includes("||")) {
    const rs = expr.split("||").map((e) => test(data, e.trim()));
    if (rs.some((r) => r === true)) return true;
    return rs.every((r) => r === null) ? null : false;
  }
  let neg = false;
  if (expr.startsWith("!")) { neg = true; expr = expr.slice(1); }
  let r;
  const m = expr.match(/^(.+?)(==|!=)(.*)$/);
  if (m) {
    const v = get(data, m[1]);
    if (v == null) return null;
    const hit = m[3].split("|").includes(String(v));
    r = m[2] === "==" ? hit : !hit;
  } else {
    const v = get(data, expr);
    if (v == null) return null;
    r = Boolean(v) && !(Array.isArray(v) && v.length === 0);
  }
  return neg ? !r : r;
}

// ".x" -> "<scope>.x", also inside "!.x" and "p||q" expressions
function scopePath(path, scope) {
  return path.split("||").map((p) => {
    const t = p.trim();
    if (t.startsWith("!.")) return `!${scope}${t.slice(1)}`;
    return t.startsWith(".") ? `${scope}${t}` : t;
  }).join("||");
}

function fillScope(root, data, scope = "") {
  root.querySelectorAll("[data-if]").forEach((el) => {
    if (!test(data, scopePath(el.dataset.if, scope))) el.remove();
    else el.removeAttribute("data-if"); // decided once, inside its own scope
  });
  const fresh = (el) => (el.dataset.done ? false : (el.dataset.done = "1"));
  root.querySelectorAll("[data-f]").forEach((el) => {
    if (!fresh(el)) return;
    let v = fmt(get(data, scopePath(el.dataset.f, scope)), el.dataset.fmt);
    // data-strip="เพื่อ": the form already prints this word right before the value
    if (el.dataset.strip && v.startsWith(el.dataset.strip)) v = v.slice(el.dataset.strip.length).trim();
    el.classList.add("v");
    if (v === "") {
      el.textContent = "";
      el.classList.add("gap");
    } else {
      el.textContent = v;
      if (el.dataset.fmt === "email" && v.includes("@")) {
        // allow a line break only right after "@", never inside the name or domain
        const at = v.indexOf("@") + 1;
        el.replaceChildren(v.slice(0, at), document.createElement("wbr"), v.slice(at));
      }
      if (v.includes("\n")) el.classList.add("multi");
    }
    el.setAttribute("contenteditable", "true");
  });
  root.querySelectorAll("[data-c]").forEach((el) => {
    if (!fresh(el)) return;
    el.classList.add("cb");
    if (test(data, scopePath(el.dataset.c, scope))) el.classList.add("on");
  });
  root.querySelectorAll("[data-yn]").forEach((el) => {
    if (!fresh(el)) return;
    el.classList.add("cb");
    // sub-question under a parent answered "no": leave both boxes empty, not a gap
    if (el.dataset.under && test(data, scopePath(el.dataset.under, scope)) === false) return;
    const t = test(data, scopePath(el.dataset.yn, scope));
    if (t === null) { (el.closest("tr") || el).classList.add("unknown"); return; }
    if ((el.dataset.v === "1") === t) el.classList.add("on");
  });
}

// Values computed from the submission, under data._derived (never stored back).
const TH_MONTHS_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
function derive(data) {
  const d = { months: [] };
  const start = data?.meta?.start_date ? new Date(data.meta.start_date) : null;
  for (let i = 0; i < 12; i++) {
    if (!start || isNaN(start)) { d.months.push(""); continue; }
    const m = new Date(start.getFullYear(), start.getMonth() + i, 1);
    d.months.push(`${TH_MONTHS_SHORT[m.getMonth()]} ${String(m.getFullYear() + 543).slice(2)}`);
  }
  return { ...data, _derived: d };
}

// <table data-gantt="list" data-cols="8" data-min="7">: activity | month 1..N | owner.
// N is the form's column count, widened to the last planned month (max 12).
function buildGantt(table, data) {
  const list = get(data, table.dataset.gantt) || [];
  const last = Math.max(0, ...list.map((r) => (r.m || []).lastIndexOf(true) + 1));
  const n = Math.min(12, Math.max(Number(table.dataset.cols || 8), last));
  const months = data._derived.months.slice(0, n);
  const td = (cls, text) => { const c = doc.createElement("td"); if (cls) c.className = cls; if (text != null) c.textContent = text; return c; };
  const doc = table.ownerDocument;
  const cg = doc.createElement("colgroup");
  cg.innerHTML = `<col style="width:${n > 8 ? 30 : 30}%">${"<col>".repeat(n)}<col style="width:${n > 8 ? 12 : 15}%">`;
  const head = doc.createElement("tr");
  head.className = "hs";
  head.append(td("c", "แผนการดำเนินงาน"));
  months.forEach((m, i) => head.append(td("m", m || `เดือน ${i + 1}`)));
  head.append(td("c", "ผู้รับผิดชอบ"));
  const body = doc.createElement("tbody");
  const rows = Math.max(list.length, Number(table.dataset.min || 0));
  for (let r = 0; r < rows; r++) {
    const item = list[r];
    const tr = doc.createElement("tr");
    tr.append(td("", item ? `${r + 1}. ${item.task || ""}` : `${r + 1}.`));
    for (let i = 0; i < n; i++) tr.append(td(item?.m?.[i] ? "m on" : "m"));
    tr.append(td("", item?.owner || ""));
    body.append(tr);
  }
  table.replaceChildren(cg, head, body);
  table.classList.toggle("wide", n > 8);
}

export function fillForm(doc, data) {
  data = derive(data);
  doc.querySelectorAll("table[data-gantt]").forEach((t) => buildGantt(t, data));
  // any element holding a <template>: table rows, or whole pages (one AP 01_2 per investigator)
  doc.querySelectorAll("[data-each]").forEach((tb) => {
    const list = get(data, tb.dataset.each) || [];
    const min = Number(tb.dataset.min || 0);
    const tpl = tb.querySelector("template");
    const n = Math.max(list.length, min);
    for (let i = 0; i < n; i++) {
      const row = tpl.content.cloneNode(true);
      row.querySelectorAll("[data-i]").forEach((el) => { el.textContent = String(i + 1); });
      const scope = `${tb.dataset.each}.${i}`;
      if (i < list.length) {
        fillScope(row, data, scope);
      } else {
        // blank padding row, as on the printed form: not a gap the researcher must fill
        row.querySelectorAll("[data-f],[data-c],[data-yn]").forEach((el) => {
          el.dataset.done = "1";
          if (!el.dataset.f) el.classList.add("cb");
          else if (el.dataset.ph) el.textContent = el.dataset.ph;
          el.setAttribute("contenteditable", "true");
        });
      }
      tb.appendChild(row);
    }
  });
  fillScope(doc.body, data);
  // rows with a lot of text may split across pages instead of jumping whole to the next one
  doc.querySelectorAll(".sheet tr").forEach((tr) => {
    if (tr.textContent.replace(/\s+/g, " ").length > 600) tr.classList.add("long");
  });
  // justify a cell only when it is prose: wide enough (>= 60 mm) and several lines long
  doc.querySelectorAll(".sheet table:not(.gantt) td:not(.c):not(.yn):not(.money)").forEach((td) => {
    const chars = td.textContent.replace(/\s+/g, " ").trim().length;
    if (chars > 140 && td.getBoundingClientRect().width > 225) td.classList.add("just");
  });
  return report(doc);
}

export function report(doc) {
  return {
    gaps: doc.querySelectorAll(".sheet .gap").length,
    unknown: doc.querySelectorAll(".sheet .unknown").length,
  };
}

// Page bootstrap: ?data=../fixtures/x.json, else a file picker in the toolbar.
export async function boot() {
  const stat = document.getElementById("stat");
  const show = (r) => {
    stat.textContent = `ช่องที่ยังว่าง ${r.gaps} ช่อง, ข้อที่ยังไม่มีคำตอบ ${r.unknown} ข้อ (แถบเหลือง ไม่พิมพ์ออก)`;
  };
  const fresh = document.getElementById("form-src").content;
  const mount = (data) => {
    const sheet = document.querySelector(".sheet");
    sheet.replaceChildren(fresh.cloneNode(true));
    show(fillForm(document, data));
  };
  const picker = document.getElementById("json-file");
  picker.addEventListener("change", async () => {
    const f = picker.files[0];
    if (f) mount(JSON.parse(await f.text()));
  });
  document.getElementById("print").addEventListener("click", () => window.print());
  const src = new URLSearchParams(location.search).get("data");
  if (src === "local") {
    // the project open in the main page (index.html), kept in this browser only
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem("ecmfu.current") || "null"); } catch { /* blocked */ }
    if (saved?.submission) mount(saved.submission);
    else stat.textContent = "ยังไม่มีโครงการในหน้าหลัก เปิดหน้าหลักแล้วอัปโหลดข้อเสนอก่อน หรือเลือกไฟล์ JSON";
    return;
  }
  if (src) {
    try {
      const res = await fetch(src);
      mount(await res.json());
      return;
    } catch (e) {
      stat.textContent = `โหลด ${src} ไม่ได้ (${e.message}) เลือกไฟล์ JSON แทน`;
    }
  } else {
    stat.textContent = "เลือกไฟล์ JSON ของโครงการ";
  }
}
