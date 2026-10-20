// Option D2: let Claude draft what the rules could not fill.
// The page builds one prompt (instructions + the fields still open + the proposal text);
// the researcher pastes it into Claude, then pastes Claude's JSON answer back. Nothing is
// sent anywhere by this page; the researcher decides whether to share the proposal.
//
// Pure functions only (no DOM) so they can be unit-tested in Node.

const get = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
function set(o, path, v) {
  const ks = path.split(".");
  let x = o;
  ks.slice(0, -1).forEach((k) => { if (x[k] == null || typeof x[k] !== "object") x[k] = {}; x = x[k]; });
  x[ks[ks.length - 1]] = v;
}

// Field types Claude may draft. People, conflict-of-interest answers, fee and receipt
// choices, dates and checkbox groups stay with the researcher.
const DRAFTABLE = new Set(["text", "area", "list", "number", "bool", "select", "table"]);
const NEVER = [/^coi_declarations/, /^fee_receipt\./, /^principal_investigator/, /^co_investigators/, /^advisors/, /^coordinator/, /^meta\.(start|end)_date$/, /^funding\.(amount_baht|grant_code|recipient_name)$/];

// fields: [{ field, status: {kind,text} }] for every visible field on the Review page.
// Picks: empty ones, machine guesses, and text copied from the proposal that must be rewritten.
export function pickFields(fields) {
  return fields.filter(({ field: f, status: s }) => DRAFTABLE.has(f.type)
    && !NEVER.some((re) => re.test(f.path))
    && s.kind !== "hide"
    && (s.kind === "todo" || s.kind === "guess" || (s.kind === "info" && f.type !== "bool")));
}

function typeHint(f) {
  switch (f.type) {
    case "text": return "ข้อความสั้น 1 บรรทัด";
    case "area": return "ข้อความ (ย่อหน้าได้)";
    case "list": return "array ของข้อความ ข้อละ 1 รายการ";
    case "number": return "ตัวเลข";
    case "bool": return "true = ใช่/มี, false = ไม่ใช่/ไม่มี";
    case "select": return `เลือก 1 ค่าจาก: ${f.options.map(([v, l]) => `"${v}" (${l})`).join(", ")}`;
    case "table": return `array ของ object ที่มี key: ${f.cols.map((c) => (c.type === "months" ? `"${c.key}" (array ของ true/false 12 ช่อง = เดือนที่ 1 ถึง 12)` : `"${c.key}" (${c.label})`)).join(", ")}`;
    default: return "";
  }
}

const show = (v) => (v == null || v === "" || (Array.isArray(v) && !v.length) ? "(ว่าง)" : JSON.stringify(v).slice(0, 300));

export function buildPrompt(submission, source, picked) {
  const lines = picked.map(({ field: f, status: s }) => {
    const why = s.kind === "todo" ? "ยังว่าง"
      : s.text.includes("เขียนใหม่") ? "ตอนนี้ลอกข้อความวิชาการจากข้อเสนอ ให้เขียนใหม่เป็นภาษาง่าย"
        : s.kind === "guess" ? `เครื่องเดาไว้ = ${show(get(submission, f.path))} ตรวจและแก้ถ้าไม่ตรงกับข้อเสนอ`
          : "ไม่บังคับ เติมเฉพาะถ้าข้อเสนอมีข้อมูล";
    return `- "${f.path}": ${f.label} [${typeHint(f)}] (${why})${f.hint ? ` หมายเหตุ: ${f.hint}` : ""}`;
  });
  const title = submission.meta?.title_th || submission.meta?.title_en || "";
  return [
    "คุณช่วยนักวิจัยเตรียมเอกสารยื่นคณะกรรมการจริยธรรมการวิจัยในมนุษย์ มหาวิทยาลัยแม่ฟ้าหลวง (แบบฟอร์ม AP 01_1, AP 02, AP 03_1 ตาม Package การยื่นเสนอเอกสาร 4.0 ปี 2026)",
    `โครงการ: ${title}`,
    "",
    "งาน: อ่านข้อเสนอโครงการด้านล่าง แล้วร่างคำตอบเฉพาะช่องในรายการ",
    "",
    "กติกา",
    "1. ใช้เฉพาะข้อเท็จจริงที่อยู่ในข้อเสนอ ห้ามแต่งตัวเลข ชื่อ วันที่ หรือขั้นตอนที่ข้อเสนอไม่ได้กล่าวถึง",
    "2. ถ้าข้อเสนอไม่มีข้อมูลพอ ให้ใส่ null (นักวิจัยจะกรอกเอง) ยกเว้นกรณีที่ข้อเสนอบอกชัดว่าไม่มีหรือไม่เกี่ยวข้อง ให้ตอบว่า \"ไม่มี\" หรือ \"ไม่เกี่ยวข้อง เนื่องจาก...\" สั้น ๆ",
    "3. ช่องที่ขึ้นต้นด้วย layman. และ ap03_1. เป็นเอกสารสำหรับผู้เข้าร่วมการวิจัย: เขียนภาษาไทยที่คนทั่วไปอ่านเข้าใจ ระดับประถมปลายถึงมัธยมต้น เรียกผู้อ่านว่า \"ท่าน\" ประโยคสั้น ไม่ใช้ศัพท์เทคนิคหรือภาษาอังกฤษถ้าเลี่ยงได้ (ถ้าจำเป็นให้อธิบายในวงเล็บ) layman.plain_summary ไม่เกิน 1 หน้า A4 และครอบคลุม (1) เป็นการวิจัยและเข้าร่วมโดยสมัครใจ (2) วัตถุประสงค์ ระยะเวลา และสิ่งที่ผู้เข้าร่วมต้องทำ (3) ความเสี่ยง (4) ประโยชน์ (5) ทางเลือกอื่น; layman.plain_objectives ไม่ต้องขึ้นต้นด้วยคำว่า \"เพื่อ\" เพราะแบบฟอร์มพิมพ์คำนั้นไว้แล้ว",
    "4. ช่องอื่นเขียนแบบเอกสารวิชาการ กระชับ ภาษาไทยเป็นหลัก",
    "5. ช่อง true/false ของแบบคัดกรอง AP 01_1 ตอบตามสิ่งที่โครงการนี้ทำกับผู้เข้าร่วมจริง ไม่ใช่สิ่งที่อ้างถึงในงานวิจัยอื่น",
    "6. ห้ามใช้อีโมจิ สัญลักษณ์รูปภาพ และเครื่องหมายจุดกลาง",
    "",
    "รูปแบบคำตอบ: ตอบเป็น JSON object เดียวเท่านั้น ไม่มีข้อความอื่นนอก JSON โดย key คือชื่อช่องตามรายการ (เช่น \"layman.plain_summary\") และ value ตามชนิดที่ระบุ ช่องที่ไม่ตอบให้ใส่ null หรือละไว้",
    "เพิ่ม key \"_notes\" เป็น array ของข้อความ บอกสิ่งที่นักวิจัยต้องตรวจหรือตัดสินใจเอง (ถ้ามี)",
    "",
    "รายการช่องที่ต้องร่าง",
    ...lines,
    "",
    "ข้อเสนอโครงการ (ข้อความที่ดึงจากไฟล์)",
    "<<<PROPOSAL",
    source || "(ไม่มีข้อความต้นฉบับ)",
    "PROPOSAL>>>",
  ].join("\n");
}

// Accepts Claude's reply as pasted: a bare JSON object, or one inside ```json fences or prose.
export function parseResponse(text) {
  const t = String(text || "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let body = fenced ? fenced[1] : t;
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("ไม่พบ JSON ในข้อความที่วาง (ต้องมีวงเล็บปีกกา { ... })");
  body = body.slice(a, b + 1);
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`อ่าน JSON ไม่ได้: ${e.message}`);
  }
}

const YES = new Set(["true", "ใช่", "มี", "yes", "เป็น"]);
const NO = new Set(["false", "ไม่ใช่", "ไม่มี", "no", "ไม่เป็น"]);

function coerce(f, v) {
  if (v == null) return { skip: "null" };
  switch (f.type) {
    case "text":
    case "area": {
      if (typeof v !== "string") return { skip: "ไม่ใช่ข้อความ" };
      const s = v.trim();
      return s ? { value: f.type === "text" ? s.replace(/\s*\n\s*/g, " ") : s } : { skip: "ว่าง" };
    }
    case "list": {
      const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : null;
      if (!arr) return { skip: "ไม่ใช่รายการ" };
      const items = arr.filter((x) => typeof x === "string").map((x) => x.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim()).filter(Boolean);
      return items.length ? { value: items } : { skip: "ว่าง" };
    }
    case "number": {
      const n = typeof v === "number" ? v : Number(String(v).replace(/[, ]/g, ""));
      return Number.isFinite(n) ? { value: n } : { skip: "ไม่ใช่ตัวเลข" };
    }
    case "bool": {
      if (typeof v === "boolean") return { value: v };
      const s = String(v).trim().toLowerCase();
      if (YES.has(s)) return { value: true };
      if (NO.has(s)) return { value: false };
      return { skip: "ไม่ใช่ true/false" };
    }
    case "select": {
      const ok = f.options.find(([val, label]) => val === v || label === v);
      return ok ? { value: ok[0] } : { skip: `ค่าไม่อยู่ในตัวเลือก (${String(v).slice(0, 30)})` };
    }
    case "table": {
      if (!Array.isArray(v)) return { skip: "ไม่ใช่ตาราง" };
      const rows = v.filter((r) => r && typeof r === "object").map((r) => Object.fromEntries(f.cols.map((c) => {
        if (c.type === "months") {
          const m = Array.isArray(r[c.key]) ? r[c.key].map(Boolean).slice(0, 12) : [];
          while (m.length < 12) m.push(false);
          return [c.key, m];
        }
        return [c.key, typeof r[c.key] === "string" ? r[c.key].trim() : r[c.key] == null ? "" : String(r[c.key])];
      })));
      return rows.length ? { value: rows } : { skip: "ว่าง" };
    }
    default:
      return { skip: "ชนิดนี้ไม่รับจาก Claude" };
  }
}

// Apply only to the fields that were asked for. Returns what happened, for the page to show.
export function applyResponse(submission, picked, answer) {
  const byPath = new Map(picked.map(({ field }) => [field.path, field]));
  const applied = [];
  const skipped = [];
  for (const [key, v] of Object.entries(answer || {})) {
    if (key === "_notes") continue;
    const f = byPath.get(key);
    if (!f) { skipped.push({ path: key, why: "ไม่ได้ขอช่องนี้" }); continue; }
    const r = coerce(f, v);
    if ("value" in r) {
      set(submission, f.path, r.value);
      applied.push(f.path);
    } else if (r.skip !== "null") skipped.push({ path: key, why: r.skip });
  }
  const notes = Array.isArray(answer?._notes) ? answer._notes.filter((x) => typeof x === "string") : [];
  return { applied, skipped, notes };
}
