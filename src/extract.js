// Rule-based extraction of a proposal into an EthicsSubmission object.
// Line-by-line port of ec_mfu/local_extractor.py (build_local_submission) plus
// extractor.apply_heuristics, fees.compute_fee and forms.select_forms, so the
// browser gives the same answers as the Python tool. Golden-tested in tests/.
//
// One deliberate difference: Python ran thai_join() (deletes spaces between Thai
// words) to help Word justify text. The HTML forms are not justified, and those
// spaces are the reader's phrase breaks, so they are kept here.

import { DEFAULTS } from "./schema-defaults.js";
import { fillFromOutline } from "./sections.js";
import { readEcForm, stripFormText, PAGE_MARK } from "./ec-form-reader.js";
import { FORM_LABELS } from "./form-labels.js";
import { textOutline } from "./loaders.js";
import {
  search, match, sub, split, rx, strip, lstrip, splitlines, pyInt, pyFloat, reEscapeDot,
} from "./pyre.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const newPerson = (over = {}) => ({ ...clone(DEFAULTS.person), ...over });
const isStudent = (status) => ["bachelor", "master", "doctoral"].includes(status);

const EMAIL = String.raw`[\w.+-]+@[\w-]+\.[\w.-]+`;
const PHONE = String.raw`(?<!\d)(?:0\d[\d\-\s]{6,12}\d)`;
const AMOUNT = String.raw`([\d][\d,\.]*)\s*(?:THB|baht|บาท)`;

const EN_MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4,
  jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const TH_MONTHS = {
  "มกราคม": 1, "กุมภาพันธ์": 2, "มีนาคม": 3, "เมษายน": 4, "พฤษภาคม": 5, "มิถุนายน": 6,
  "กรกฎาคม": 7, "สิงหาคม": 8, "กันยายน": 9, "ตุลาคม": 10, "พฤศจิกายน": 11, "ธันวาคม": 12,
  "ม.ค.": 1, "ก.พ.": 2, "มี.ค.": 3, "เม.ย.": 4, "พ.ค.": 5, "มิ.ย.": 6,
  "ก.ค.": 7, "ส.ค.": 8, "ก.ย.": 9, "ต.ค.": 10, "พ.ย.": 11, "ธ.ค.": 12,
};
// Python: "|".join(sorted(keys, key=len, reverse=True)).replace(".", r"\.") (stable sort)
const TH_MONTH_RE = reEscapeDot(
  Object.keys(TH_MONTHS).map((k, i) => [k, i]).sort((a, b) => b[0].length - a[0].length || a[1] - b[1]).map((x) => x[0]).join("|"),
);

const normYear = (y) => (y > 2400 ? y - 543 : y);

function safeDate(y, m, d) {
  if (!(m >= 1 && m <= 12) || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1 || y > 9999) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseDate(s) {
  if (!s) return null;
  s = strip(s);
  let m = search(String.raw`(\d{4})-(\d{1,2})-(\d{1,2})`, s);
  if (m) return safeDate(pyInt(m[1]), pyInt(m[2]), pyInt(m[3]));
  m = search(String.raw`\b(\d{1,2})[/\.](\d{1,2})[/\.](\d{4})\b`, s);
  if (m) return safeDate(normYear(pyInt(m[3])), pyInt(m[2]), pyInt(m[1]));
  m = search(String.raw`(?:(\d{1,2})\s+)?([A-Za-z]{3,9})\.?\s+(\d{4})`, s);
  if (m && m[2].toLowerCase() in EN_MONTHS) {
    const day = m[1] ? pyInt(m[1]) : 1;
    return safeDate(pyInt(m[3]), EN_MONTHS[m[2].toLowerCase()], day);
  }
  m = search(String.raw`(?:(\d{1,2})\s+)?(` + TH_MONTH_RE + String.raw`)\s*(?:พ\.ศ\.\s*)?(\d{4})`, s);
  if (m) {
    const day = m[1] ? pyInt(m[1]) : 1;
    return safeDate(normYear(pyInt(m[3])), TH_MONTHS[m[2]], day);
  }
  return null;
}

function monthDiff(start, end) {
  if (!start || !end) return null;
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  let months = (ey - sy) * 12 + (em - sm);
  if (ed >= sd) months += 1;
  return months > 0 ? months : null;
}

// ---------------------------------------------------------------- line helpers

function inline(text, labels) {
  for (const label of labels) {
    const m = search(`${label}[ \\t]*[:：\\-][ \\t]*(.+)`, text, "im");
    if (m) return strip(m[1], " .");
  }
  return "";
}

function block(text, startLabels, stopLabels) {
  const lines = splitlines(text);
  const startSrc = startLabels.join("|");
  const stopSrc = stopLabels.length ? stopLabels.join("|") : null;
  const collected = [];
  let capturing = false;
  for (const line of lines) {
    if (!capturing) {
      const m = search(startSrc, line, "i");
      if (m) {
        capturing = true;
        const tail = lstrip(line.slice(m.end), " :：-");
        if (strip(tail)) collected.push(strip(tail));
      }
      continue;
    }
    if (!strip(line)) {
      if (collected.length) break;
      continue;
    }
    if (stopSrc && search(stopSrc, line, "i") && match(String.raw`^\s*[\wก-๙]`, line)) break;
    collected.push(strip(line));
  }
  return strip(collected.join(" "));
}

const NUM_HEADING = String.raw`^\s*(?:\d{1,2}(?:\.\d{1,2})*\.?|[ก-ฮ]\.)\s+\S`;

function isHeading(line, extraStop) {
  const s = strip(line);
  if (!s) return false;
  if (match(NUM_HEADING, s)) return true;
  if (extraStop && search(extraStop, s, "i")) return true;
  return false;
}

function sectionBody(text, startLabels, extraStops = null, maxLines = 40) {
  const startSrc = startLabels.join("|");
  const stopSrc = extraStops ? extraStops.join("|") : null;
  const lead = String.raw`^[\s\-•\d.)ก-ฮ]*`;
  const lines = splitlines(text);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let m = search(startSrc, lines[i], "i");
    if (m) {
      const atHead = m.index <= match(lead, lines[i])[0].length;
      const inlineSep = match(String.raw`[ \t]*[:：\-]\s*\S`, lines[i].slice(m.end));
      if (!atHead && !inlineSep) m = null;
    }
    if (!m) { i += 1; continue; }
    const rest = lines[i].slice(m.end);
    if (match(String.raw`[ \t]*[:：\-]\s*\S`, rest)) return [strip(lstrip(rest, " :：-\t"), " .")];
    let j = i + 1;
    while (j < lines.length && out.length < maxLines) {
      const line = lines[j];
      if (!strip(line)) {
        if (out.length) break;
        j += 1;
        continue;
      }
      if (isHeading(line, stopSrc)) break;
      // Beyond Python: a table row ("a | b | c") is never part of a prose section
      if (line.includes(" | ") && out.length) break;
      out.push(strip(strip(line, " -•\t.")));
      j += 1;
    }
    if (out.length) return out.filter((x) => x);
    i = j > i ? j : i + 1;
  }
  return [];
}

const has = (text, ...keywords) => keywords.some((k) => search(k, text, "i"));

const NEGATION = String.raw`\bnot\b|\bno\b|\bnon-|without|ไม่|ปราศจาก|ยกเว้น`;
function hasPositive(text, keyword) {
  for (const sentence of split(String.raw`[.\n;]`, text)) {
    if (search(keyword, sentence, "i")) {
      if (search(NEGATION, sentence, "i")) continue;
      return true;
    }
  }
  return false;
}

// Differs from Python on purpose. Python took the first "<number> คน/ราย" anywhere,
// which read "8,327 รายการ" (items) as 327 people and "คณะผู้วิจัย 2 คน" as the sample.
// Here every "<n> or <a>-<b> คน/ท่าน/ราย/participants" is scored by its line: sample
// words (+3), a participant noun as the unit (+1), "รวม" just before it (+2), budget table
// rows, money or the research team (-5).
// A range gives its upper bound; no candidate with a positive score gives null.
const SAMPLE_WORDS = String.raw`กลุ่มตัวอย่าง|ขนาดตัวอย่าง|ประชากร|กลุ่มเป้าหมาย|population|ผู้เข้าร่วม|อาสาสมัคร|ผู้ให้ข้อมูล|ผู้ประเมิน|ผู้ตอบ|Q ?Graders?|sample|participants?|respondents?|subjects?|volunteers?`;
const PEOPLE_UNIT = String.raw`(?<![\d,.])(\d{1,5})(?:\s*[–\-]\s*(\d{1,5}))?\s*(?:[A-Za-zก-๙]+\s+){0,2}?(?:students?|participants?|subjects?|volunteers?|patients?|respondents?|ราย(?!การ|ละเอียด|งาน|ได้|วัน|ปี|เดือน|ชื่อ)|คน|ท่าน|อาสาสมัคร)`;

function findSampleSize(text) {
  let best = null;
  for (const line of splitlines(text)) {
    const r = rx(PEOPLE_UNIT, "i", "g");
    r.lastIndex = 0;
    let m;
    while ((m = r.exec(line))) {
      let score = 0;
      if (search(SAMPLE_WORDS, line, "i")) score += 3;
      if (search(String.raw`students?|participants?|subjects?|volunteers?|patients?|respondents?|อาสาสมัคร`, m[0], "i")) score += 1;
      if (search(String.raw`รวม(?:ทั้งสิ้น|ทั้งหมด)?(?:ประมาณ)?\s*$|total\s*(?:of)?\s*$`, line.slice(Math.max(0, m.index - 16), m.index), "i")) score += 2;
      if (line.includes(" | ") || search(String.raw`บาท|baht|คณะผู้วิจัย|ผู้ช่วยวิจัย|research team`, line, "i")) score -= 5;
      const n = pyInt(m[2] || m[1]);
      if (score > 0 && n && (!best || score > best.score)) best = { score, n };
    }
  }
  return best ? best.n : null;
}

function splitItems(value) {
  if (!value) return [];
  return split(String.raw`;|•|(?<!\d),(?!\d)|\n`, value).filter((p) => strip(p, " .-")).map((p) => strip(p, " .-"));
}

const LIT_REVIEW_HEADING = String.raw`การทบทวนวรรณกรรม|literature review|ผลงานวิจัยต่างๆ ที่เกี่ยวข้อง`;
const NEXT_MAJOR_HEADING = String.raw`^\s*(?:\d+[.\d]*\s*)?(?:กระบวนการและวิธีการ|ขอบเขตของโครงการ|แผนการดำเนินงาน|Procedures?|Methods?|Population|ประชากร)\b`;

function classificationScanText(scopeText) {
  const lines = splitlines(scopeText).filter((ln) => !ln.includes(" | "));
  let scoped = lines.join("\n");
  const m = search(LIT_REVIEW_HEADING, scoped, "i");
  if (m) {
    const rest = scoped.slice(m.end);
    const stop = search(NEXT_MAJOR_HEADING, rest, "im");
    const cutEnd = m.end + (stop ? stop.index : rest.length);
    scoped = scoped.slice(0, m.index) + scoped.slice(cutEnd);
  }
  return scoped;
}

// ---------------------------------------------------------------- people

// A filled EC form prints every option with a box ("[ / ] อาจารย์", "[ ] นักศึกษา ปริญญาเอก"):
// only the ticked options (and the line after each, where an option wraps) count.
const BOXED = /\[\s*\/?\s*\]/;
const tickedOnly = (t) => (BOXED.test(t) ? (t.match(/\[\s*\/\s*\][^[\n]*(?:\n(?!\s*\[)[^[\n]*)?/g) || []).join("\n") : t);

function personStatus(blob) {
  blob = tickedOnly(blob);
  if (has(blob, "ปริญญาเอก", String.raw`ป\.\s*เอก`, "doctoral", String.raw`ph\.?\s*d`)) return "doctoral";
  if (has(blob, "ปริญญาโท", String.raw`ป\.\s*โท`, "master")) return "master";
  if (has(blob, "ปริญญาตรี", String.raw`ป\.\s*ตรี`, "undergrad", "bachelor")) return "bachelor";
  return "lecturer";
}

const FORM_LABEL_PREFIX = String.raw`^(?:วิจัย|ตำแหน่ง(?:วิชาการ)?(?:-ยศ)?(?:-ชื่อ-สกุล)?|ชื่อ-สกุล)\s+`;
const AFFIL_LABEL = String.raw`(?:สังกัด(?:หน่วยงาน)?|affiliation)\s*[:：]?\s*(.+?)(?=\s*(?:เบอร์|โทร|Tel|Email|อีเมล)|$)`;
const SCHOOL = String.raw`((?:สำนักวิชา|คณะ|สาขา(?:วิชา)?|School of|Faculty of|Department of)[^,.\n]+)`;
const JUNK_TITLE = String.raw`^(?:แบบเสนอโครงการ|ชื่อโครงการวิจัย|เอกสารข้อมูล|Research Proposal\b|Title\s*\(|คำรับรอง|แบบรายงาน)`;

function personFromBlob(blob) {
  blob = strip(blob);
  const em = search(EMAIL, blob);
  const email = em ? em[0] : "";
  const pm = search(PHONE, blob);
  const phone = pm ? strip(pm[0]) : "";

  const cleaned = strip(sub(FORM_LABEL_PREFIX, "", blob));
  let name = strip(split(String.raw`,|Email|Tel|โทร|อีเมล|\bat\b|สังกัด`, cleaned, "i")[0]);
  name = strip(sub(FORM_LABEL_PREFIX, "", name));
  let nameTh = name;
  let nameEn = "";
  const paren = search(String.raw`\(([^)]+)\)`, blob);
  if (paren && search("[A-Za-z]", paren[1])) {
    nameEn = strip(paren[1]);
    nameTh = strip(sub(String.raw`\([^)]*\)`, "", name));
  }
  if (!search("[ก-๙]", nameTh) && search("[A-Za-z]", nameTh)) nameEn = nameEn || nameTh;

  let affiliation = inline(blob, ["School", "สังกัด", "สาขา", "หน่วยงาน", "คณะ"]);
  if (!affiliation) {
    const m = search(AFFIL_LABEL, blob, "i");
    if (m) affiliation = strip(m[1], " .");
  }
  if (!affiliation) {
    const m = search(SCHOOL, blob, "i");
    if (m) affiliation = strip(m[1], " .");
  }

  let address = inline(blob, ["Address", "ที่อยู่"]);
  if (!address && has(blob, "แม่ฟ้าหลวง", "Mae Fah Luang")) address = "มหาวิทยาลัยแม่ฟ้าหลวง";

  let studentYear = null;
  const ym = search(String.raw`(?:Year|ชั้นปี(?:ที่)?)\s*(\d+)`, blob, "i");
  if (ym) studentYear = `ชั้นปีที่ ${ym[1]}`;
  const isThesis = has(blob, "thesis", "วิทยานิพนธ์", "สำเร็จการศึกษา") ? true : null;

  return newPerson({
    title_th: nameTh, name_en: nameEn, status: personStatus(blob), student_year: studentYear,
    is_thesis_work: isThesis, affiliation, address, phone, email,
  });
}

const isNobody = (blob) => Boolean(match(String.raw`^[\s\-–—_.:]*(?:(?:ไม่มี|none|n/?a|nil)(?:[\s\-–—_.]|$)|$)`, blob, "i"));

function labeledPeople(text, startLabels, stopLabels, maxLines = 10) {
  const startSrc = startLabels.join("|");
  const stopSrc = stopLabels.join("|");
  const people = [];
  const lines = splitlines(text);
  let i = 0;
  while (i < lines.length) {
    const m = search(startSrc, lines[i], "i");
    if (!m) { i += 1; continue; }
    const chunks = [];
    const tail = lstrip(lines[i].slice(m.end), " :：-");
    if (strip(tail)) chunks.push(strip(tail));
    let j = i + 1;
    while (j < lines.length && chunks.length < maxLines) {
      const line = lines[j];
      if (!strip(line)) {
        if (chunks.length) break;
        j += 1;
        continue;
      }
      if (search(startSrc, line, "i") || (search(stopSrc, line, "i") && match(String.raw`^\s*[\wก-๙]`, line))) break;
      chunks.push(strip(line));
      j += 1;
    }
    const blob = strip(chunks.join(" "));
    // Beyond Python: "— ไม่มี —" / "none" under a role heading means nobody, not a person
    if (blob && !isNobody(blob)) people.push(personFromBlob(blob));
    i = j > i ? j : i + 1;
  }
  return people;
}

// Team listed as a table, as in NRIIS / Fundamental Fund proposals:
//   "อ.ดร. ชื่อ สกุล | สำนักวิชา... | หัวหน้าโครงการ | 85%"
// Not in the Python tool; used only when such a table names a project lead.
const ROLE = {
  pi: String.raw`^(?:หัวหน้าโครงการ(?:วิจัย)?|ผู้วิจัยหลัก|หัวหน้า|Principal Investigator|PI)$`,
  co: String.raw`^(?:ผู้ร่วมวิจัย|ผู้วิจัยร่วม|ผู้ร่วมโครงการ(?:วิจัย)?|นักวิจัยร่วม|Co-?Investigators?)$`,
  advisor: String.raw`^(?:อาจารย์ที่ปรึกษา|ที่ปรึกษาโครงการ(?:วิจัย)?|ที่ปรึกษา|(?:Research )?Advisor)$`,
  coordinator: String.raw`^(?:ผู้ประสานงาน(?:โครงการ)?|(?:Research )?Coordinator)$`,
};
const AFFIL_CELL = String.raw`สำนักวิชา|คณะ|สาขา|ภาควิชา|หน่วยงาน|มหาวิทยาลัย|สถาบัน|ศูนย์|School|Faculty|Department|University|Institute`;

function rosterFromTable(text) {
  const out = { pi: null, co: [], advisor: [], coordinator: null };
  for (const line of splitlines(text)) {
    if (!line.includes(" | ")) continue;
    const cells = line.split(" | ").map((c) => strip(c));
    let role = null;
    let roleIdx = -1;
    cells.forEach((c, i) => {
      if (role) return;
      for (const [k, re] of Object.entries(ROLE)) {
        if (c.length < 40 && search(re, c, "i")) { role = k; roleIdx = i; return; }
      }
    });
    if (!role) continue;
    const rest = cells.filter((_, i) => i !== roleIdx);
    const affiliation = rest.find((c) => search(AFFIL_CELL, c, "i")) || "";
    const name = rest.find((c) => c !== affiliation && search("[ก-๙A-Za-z]", c) && !search(String.raw`^\d+(?:\.\d+)?\s*%$`, c) && !search(EMAIL, c)) || "";
    if (!name) continue;
    const em = search(EMAIL, line);
    const pm = search(PHONE, line);
    const p = newPerson({
      title_th: search("[ก-๙]", name) ? name : "", name_en: search("[ก-๙]", name) ? "" : name,
      status: personStatus(line), affiliation, email: em ? em[0] : "", phone: pm ? strip(pm[0]) : "",
    });
    if (role === "pi") out.pi = out.pi || p;
    else if (role === "coordinator") out.coordinator = out.coordinator || p;
    else out[role].push(p);
  }
  return out.pi ? out : null;
}

// The same team table read from a PDF, where each row breaks over several lines with no
// cell separator and a page number may fall in between:
//   อ.ดร. ก ข สำนักวิชาเทคโนโลยี / ดิจิทัลประยุกต์ / หัวหน้าโครงการ 85%
//   ดร. ก ข / หน่วยงาน : มหาวิทยาลัยแม่ฟ้าหลวง สำนัก... / หัวหน้าโครงการ 85.00 นักวิจัยใหม่  (NRIIS)
// A row ends at its role line; the person starts at the last line with a title (อ. ดร. นาย ...).
const PERSON_TITLE = String.raw`^(?:(?:ศ|รศ|ผศ|อ|ดร|นพ|พญ|ทพ|ภก|ภญ|พ\.?ต\.?[ทอต])\.|ศาสตราจารย์|รองศาสตราจารย์|ผู้ช่วยศาสตราจารย์|อาจารย์|นางสาว|นาง|นาย|น\.ส\.|(?:Dr|Mr|Mrs|Ms|Prof|Asst|Assoc)\.?\s)`;
const ROLE_LINE = String.raw`^(หัวหน้าโครงการ(?:วิจัย)?|ผู้วิจัยหลัก|ผู้ร่วมวิจัย|ผู้วิจัยร่วม|ผู้ร่วมโครงการ(?:วิจัย)?|นักวิจัยร่วม|อาจารย์ที่ปรึกษา|ที่ปรึกษาโครงการ(?:วิจัย)?|ที่ปรึกษา|ผู้ประสานงาน(?:โครงการ)?|Principal Investigator|Co-?Investigators?|(?:Research )?Advisor|(?:Research )?Coordinator)(?=\s|$)`;

function rosterFromLines(text) {
  const lines = splitlines(text).map((l) => strip(l));
  const head = lines.findIndex((l) => search("ชื่อ\\s*-?\\s*สกุล|ชื่อ-นามสกุล|^Name", l, "i") && search("ตำแหน่ง|หน่วยงาน|Role|Position", l, "i"));
  if (head < 0) return null;
  const out = { pi: null, co: [], advisor: [], coordinator: null };
  let buf = [];
  for (const line of lines.slice(head + 1, head + 80)) {
    if (!line || /^\d{1,3}$/.test(line)) continue; // blank, or a page number
    if (search(String.raw`^(?:ส่วนที่|\d{1,2}\.\s|บทสรุป|ลงชื่อ)`, line) && !buf.length) break;
    const rm = search(ROLE_LINE, line, "i");
    if (!rm) { buf.push(line); continue; }
    const start = buf.map((l) => Boolean(search(PERSON_TITLE, l, "i"))).lastIndexOf(true);
    const blob = (start >= 0 ? buf.slice(start) : buf.slice(-2)).join(" ").replace(/\s+/g, " ");
    buf = [];
    const role = Object.entries(ROLE).find(([, re]) => search(re, rm[1], "i"))?.[0];
    if (!role || !blob) continue;
    // the affiliation begins at "หน่วยงาน :" or at the first school / faculty word
    const am = search(String.raw`หน่วยงาน\s*[:：]\s*|(?=${SCHOOL_START})`, blob);
    const name = strip(am ? blob.slice(0, am.index) : blob);
    let affiliation = am ? strip(blob.slice(am.end)) : "";
    // NRIIS writes "มหาวิทยาลัยแม่ฟ้าหลวง สำนักวิชา..."; the forms want the school
    const school = search(SCHOOL_START, affiliation);
    if (school && school.index > 0) affiliation = strip(affiliation.slice(school.index));
    affiliation = affiliation.replace(/(?<=[ก-๙])\s+(?=[ก-๙])/g, ""); // a school name broken over two lines
    if (!name || name.length > 60) continue;
    const p = newPerson({ title_th: search("[ก-๙]", name) ? name : "", name_en: search("[ก-๙]", name) ? "" : name, status: personStatus(name), affiliation });
    if (role === "pi") out.pi = out.pi || p;
    else if (role === "coordinator") out.coordinator = out.coordinator || p;
    else out[role].push(p);
  }
  return out.pi ? out : null;
}
const SCHOOL_START = String.raw`สำนักวิชา|คณะ|ภาควิชา|สาขาวิชา|School of|Faculty of|Department of`;

// ---------------------------------------------------------------- fields

// Grant-type options under the RS-1 heading: tab-separated cells on the lines before the
// first numbered heading; a cell "R" (Wingdings ticked box) or a check-mark character
// (U+2713, U+2611, U+25A0) marks the next cell as chosen.
function grantOptions(text) {
  const lines = splitlines(text).slice(0, 30);
  const k = lines.findIndex((l) => search("ประจำปีงบประมาณ|Fundamental Fund|แหล่งทุน", l, "i"));
  const options = [];
  let ticked = "";
  if (k < 0) return { options, ticked };
  for (const line of lines.slice(k + 1)) {
    if (match(NUM_HEADING, strip(line))) break;
    const cells = line.split(/\t+/).map((c) => strip(c)).filter(Boolean);
    cells.forEach((c, i) => {
      const mark = match(String.raw`^(?:R|\u2713|\u2611|\u25A0|\[[xX/]\])(?:\s+(.+))?$`, c);
      if (mark) {
        const chosen = mark[1] || cells[i + 1] || "";
        if (chosen && !ticked) ticked = strip(chosen, " .");
      } else options.push(c);
    });
  }
  return { options, ticked };
}

function funding(text) {
  const blk = block(text, ["Funding", "แหล่งทุน", "^ทุน", "งบประมาณ"],
    ["Field", "Background", "Rationale", "Objectives", "สาขา", "หลักการ", "ความสำคัญ", "วัตถุประสงค์"]);
  const scope = blk || text;
  // on a filled EC form only the ticked kind of grant counts
  const boxed = BOXED.test(scope);
  const kind = tickedOnly(scope);
  let ftype = "personal";
  if (has(kind, "university", "มหาวิทยาลัย", "สำนักวิชา", String.raw`internal (?:research )?grant`, "คณะ")) ftype = "university";
  if (has(kind, "government", "รัฐบาล", "ภาครัฐ", String.raw`วช\.?`, "สกสว", "บพข", "สวรส")) ftype = "government";
  if (has(kind, "private", "company", "บริษัท", "เอกชน")) ftype = "private";
  if (has(kind, "self[- ]?funded", "personal", "ทุนส่วนตัว", "ไม่มีทุน", "no funding")) ftype = "personal";
  // AP 02 has no box for the university's own grant: "[ / ] ทุนจากหน่วยงานของรัฐบาล ระบุ
  // งานวิจัยของมหาวิทยาลัยแม่ฟ้าหลวง" is the MFU grant (fee C, not A)
  if (boxed && ftype === "government" && has(kind, "แม่ฟ้าหลวง", String.raw`\bMFU\b`)) ftype = "university";

  let amount = null;
  const am = search(AMOUNT, scope, "i");
  if (am) amount = pyFloat(am[1].replace(/,/g, ""));
  let grantCode = inline(scope, ["grant code", String.raw`grant no\.?`, "รหัสทุน", "code"]);
  if (!grantCode) {
    const cm = search(String.raw`(?:grant code|รหัสทุน)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_/]+)`, scope, "i");
    if (cm) grantCode = cm[1];
  }
  let grantTh = inline(scope, ["ชื่อทุน", "grant name"]);
  let grantEn = "";
  if (grantTh && !search("[ก-๙]", grantTh)) { grantEn = grantTh; grantTh = ""; }
  if (!grantTh && !grantEn) {
    let head = split(String.raw`,|\(|grant code|รหัส`, scope, "i", 1)[0];
    head = sub(String.raw`^(?:Funding|แหล่งทุน)\s*[:：]?\s*`, "", head, "i");
    head = strip(head, " .");
    // Beyond Python: MFU RS-1 lists every grant type after the heading, tab-separated,
    // with the chosen one marked (Wingdings "R" = ticked box, or a check-mark character). Keep the heading
    // and the ticked type only; Python kept the whole list.
    if (/\t/.test(head)) {
      const opts = grantOptions(text);
      const firstOpt = opts.options.find((o) => head.includes(o));
      const base = strip(firstOpt ? head.slice(0, head.indexOf(firstOpt)) : head.split("\t")[0], " .");
      head = opts.ticked ? `${base} (${opts.ticked})` : base;
    }
    if (head) {
      if (search("[ก-๙]", head)) grantTh = head;
      else grantEn = head;
    }
  }
  return {
    ...clone(DEFAULTS.submission.funding),
    funding_type: ftype, amount_baht: amount, grant_code: grantCode, grant_name_th: grantTh, grant_name_en: grantEn,
  };
}

function population(text) {
  return {
    ...clone(DEFAULTS.submission.population),
    healthy: has(text, "healthy", "สุขภาพดี", "ประชากรสุขภาพดี"),
    patients: hasPositive(text, "patient") || has(text, "ผู้ป่วย"),
    chronic_patients: has(text, "chronic", "โรคเรื้อรัง"),
    pregnant: has(text, "pregnan", "ตั้งครรภ์"),
    children: has(text, "child", "เด็ก", String.raw`อายุ\s*7`, "minor"),
    military_police: has(text, "military", "police", "ทหาร", "ตำรวจ"),
    students: has(text, "student", "undergrad", "นักศึกษา", "นักเรียน", "pupil"),
    institutional_staff: has(text, "institutional staff", "บุคลากรในสถาบัน", "พนักงานในสถาบัน"),
    ethnic_groups: has(text, "ethnic", "ชาติพันธุ์"),
    refugees: has(text, "refugee", "ผู้ลี้ภัย", "ผู้อพยพ"),
    homeless: has(text, "homeless", "ไร้บ้าน", "เร่ร่อน"),
    prisoners: has(text, "prisoner", "นักโทษ", "ผู้ต้องขัง"),
    cognitive_impaired: has(text, "cognitive impair", "บกพร่องทางสติปัญญา"),
    terminally_ill: has(text, "terminal", "ระยะสุดท้าย"),
  };
}

function classification(text) {
  const hp = (k) => hasPositive(text, k);
  return {
    ...clone(DEFAULTS.submission.classification),
    is_education: has(text, "education research", "งานวิจัยด้านการศึกษา", "classroom", "การเรียนการสอน"),
    is_survey_interview: has(text, "survey", "interview", "questionnaire", "usability", "observation",
      "สำรวจ", "สัมภาษณ์", "แบบสอบถาม", "สังเกต"),
    is_secondary_data: has(text, "secondary data", "existing data", "medical record", "เวชระเบียน", "ข้อมูลที่เก็บไว้แล้ว"),
    has_drug: hp("investigational drug") || hp("ยาแผนปัจจุบัน") || hp("ทดลองยา"),
    has_food_product: hp("food product") || hp("ผลิตภัณฑ์อาหาร"),
    has_dietary_supplement: hp("dietary supplement") || hp("เสริมอาหาร"),
    has_herbal: hp("herbal") || hp("สมุนไพร"),
    has_cosmetic: hp("cosmetic") || hp("เครื่องสำอาง"),
    has_medical_device: hp("medical[- ]device") || hp("เครื่องมือแพทย์"),
    has_procedure: hp(String.raw`blood (?:draw|sample|collection)`) || hp("เจาะเลือด") || hp("หัตถการ") || hp("invasive procedure"),
    has_genetics: hp("genetic") || hp("พันธุกรรม") || hp(String.raw`\bdna\b`) || hp("genome"),
    has_placebo: hp("placebo") || hp("ยาหลอก"),
  };
}

function consentMethod(text) {
  if (has(text, "waiver of consent", "ยกเว้นการขอความยินยอม")) return "waiver";
  if (has(text, "e-?consent", "electronic consent", "อิเล็กทรอนิกส์")) return "electronic";
  if (has(text, "verbal consent", "ด้วยวาจา")) return "verbal";
  if (has(text, "consent by action", "โดยการกระทำ", "return.*questionnaire")) return "action";
  return "written";
}

function retentionYears(text) {
  let m = search(String.raw`(?:retain(?:ed)?|kept|store[ds]?|เก็บ(?:รักษา)?)[^.\n]*?(\d{1,3})\s*(?:year|ปี)`, text, "i");
  if (!m) m = search(String.raw`(\d{1,3})\s*(?:years?|ปี)`, text, "i");
  return m ? pyInt(m[1]) : null;
}

function intNear(text, keyword) {
  const m = search(`${keyword}[^\\d]{0,40}?([\\d]{1,5})|([\\d]{1,5})[^\\d]{0,20}?${keyword}`, text, "i");
  if (!m) return null;
  return pyInt(m[1] || m[2]);
}

// ---------------------------------------------------------------- top level

export function buildLocalSubmission(text) {
  text = text || "";

  let titleTh = inline(text, [String.raw`Title\s*\(TH\)`, "ชื่อโครงการ.*?ไทย", "ชื่อภาษาไทย", "ชื่อโครงการวิจัย.*?ไทย"]);
  let titleEn = inline(text, [String.raw`Title\s*\(EN\)`, "ชื่อโครงการ.*?อังกฤษ", "English title", "ชื่อภาษาอังกฤษ"]);
  if (titleTh && match(JUNK_TITLE, strip(titleTh), "i")) titleTh = "";
  if (titleEn && match(JUNK_TITLE, strip(titleEn), "i")) titleEn = "";
  if (!titleTh) {
    const m = search(String.raw`\(ภาษาไทย\)[ \t]*(.+)`, text);
    if (m && !match(JUNK_TITLE, strip(m[1]), "i")) titleTh = strip(m[1], " .");
  }
  if (!titleEn) {
    const m = search(String.raw`\(ภาษาอังกฤษ\)[ \t]*(.+)`, text);
    if (m && !match(JUNK_TITLE, strip(m[1]), "i")) titleEn = strip(m[1], " .");
  }
  if (!titleTh && !titleEn) {
    const generic = inline(text, ["Title", "ชื่อโครงการ"]);
    if (generic && !match(JUNK_TITLE, generic, "i")) {
      if (search("[ก-๙]", generic)) titleTh = generic;
      else titleEn = generic;
    }
  }
  if (!titleTh && !titleEn) {
    for (const line of splitlines(text)) {
      const cand = strip(line);
      if (cand && cand.length > 6 && !match(JUNK_TITLE, cand, "i")) {
        if (search("[ก-๙]", cand)) titleTh = cand;
        else titleEn = cand;
        break;
      }
    }
  }

  const sigIdx = text.indexOf("ลงชื่อ");
  const rosterText = sigIdx !== -1 ? text.slice(0, sigIdx) : text;

  const table = rosterFromTable(rosterText) || rosterFromLines(rosterText);
  let piBlob = "";
  let pi;
  let coInvestigators;
  let advisors;
  if (table) {
    pi = table.pi;
    coInvestigators = table.co;
    advisors = table.advisor;
  } else {
    piBlob = block(rosterText, ["Principal Investigator", "ผู้วิจัยหลัก", "หัวหน้าโครงการ"],
      ["Co-?Investigator", "ผู้วิจัยร่วม", "ผู้ร่วมโครงการวิจัย", "Advisor", "ที่ปรึกษา", "Funding", "แหล่งทุน", "Field", "Background"]);
    pi = piBlob ? personFromBlob(piBlob) : newPerson();
    const nextFieldStops = ["ประเภทของการวิจัย", "คำสำคัญ"];
    coInvestigators = labeledPeople(rosterText,
      ["Co-?Investigators?", "ผู้วิจัยร่วม", "ผู้ร่วมโครงการวิจัย"],
      ["Research Advisor", "อาจารย์ที่ปรึกษา", "ที่ปรึกษาโครงการ", "Funding", "แหล่งทุน", "Field", "Background", ...nextFieldStops]);
    advisors = labeledPeople(rosterText,
      ["Research Advisor", "ที่ปรึกษาโครงการ(?:วิจัย)?", "อาจารย์ที่ปรึกษา"],
      ["Co-?Investigator", "ผู้วิจัยร่วม", "ผู้ร่วมโครงการวิจัย", "Funding", "แหล่งทุน", "Field", "Background",
        "Coordinator", "ผู้ประสานงาน", ...nextFieldStops]);
  }
  if (advisors.length && !isStudent(pi.status) && !coInvestigators.some((c) => isStudent(c.status))) {
    const evidence = search(String.raw`นักศึกษา|วิทยานิพนธ์|thesis|ป\.\s*(?:ตรี|โท|เอก)|ชั้นปีที่`,
      piBlob + coInvestigators.map((c) => c.title_th + c.affiliation).join(" "));
    if (!evidence) {
      coInvestigators.push(...advisors);
      advisors = [];
    }
  }

  const scanText = classificationScanText(rosterText);

  const OBJ_STOPS = ["การทบทวนวรรณกรรม", "literature review", "ขอบเขต", "ระเบียบวิธี", "วิธีการดำเนิน", "กรอบแนวค", "กรอบการวิจัย", "สมมติฐาน"];
  const objItems = sectionBody(text, ["วัตถุประสงค์(?:ของโครงการ|การวิจัย|หลัก)?", "Objectives?"], OBJ_STOPS);
  // Beyond Python: an English gloss "(Primary Objective)" after the label, "ย่อย" for
  // secondary, and labels standing alone with their objectives on the lines below.
  const PRI = String.raw`^(?:primary\s*(?:objective)?|วัตถุประสงค์หลัก|หลัก)(?:\s*\([^)]*\))?\s*[:：\-]?\s*`;
  const SEC = String.raw`^(?:secondary\s*(?:objectives?)?|วัตถุประสงค์(?:รอง|ย่อย)|รอง|ย่อย)(?:\s*\([^)]*\))?\s*[:：\-]?\s*`;
  let primary = "";
  let secondaryItems = [];
  if (objItems.length) {
    const labelled = objItems.filter((it) => match(PRI, it, "i") || match(SEC, it, "i"));
    if (labelled.length) {
      let mode = null; // set by a label that has no value of its own
      for (const it of objItems) {
        if (match(PRI, it, "i")) {
          const v = strip(sub(PRI, "", it, "i"));
          if (v) { primary = primary || v; mode = null; } else mode = "pri";
        } else if (match(SEC, it, "i")) {
          const v = strip(sub(SEC, "", it, "i"));
          if (v) { secondaryItems = secondaryItems.concat(splitItems(v)); mode = null; } else mode = "sec";
        } else if (mode === "pri") {
          if (!primary) primary = it;
          else secondaryItems.push(it);
        } else if (mode === "sec") secondaryItems.push(it);
      }
    } else {
      primary = objItems[0];
      secondaryItems = objItems.slice(1);
    }
  }
  if (!primary) primary = inline(text, ["Primary objective", "Primary", "วัตถุประสงค์หลัก"]);
  if (!secondaryItems.length) secondaryItems = splitItems(inline(text, ["Secondary objective", "Secondary", "วัตถุประสงค์รอง"]));

  const narr = (startLabels, stops) => inline(text, startLabels) || sectionBody(text, startLabels, stops).join(" ");

  const rationale = narr(["หลักการและเหตุผล", "ความสำคัญ(?:และที่มา|ที่มา)?", "ที่มาของปัญหา", "Rationale", "Background"],
    ["วัตถุประสงค์", "Objectives?", "การทบทวนวรรณกรรม", "ขอบเขต", "รูปแบบการวิจัย", "ประชากร"]);
  const design = narr(["Study design", "รูปแบบการวิจัย"], ["Population", "ประชากร", "ระเบียบวิธี"]);
  const procedures = narr(
    ["แนวทางการดำเนินงาน(?:วิจัย)?", "กระบวนการและวิธีการ", "วิธีการดำเนินการวิจัย", "ระเบียบวิธีวิจัย", "ขั้นตอนการวิจัย", "วิธีดำเนินการ", "Procedures?"],
    ["Outcome", "Statistic", "Risks?", "ผลลัพธ์", "สถิติ", "ความเสี่ยง", "แผนการดำเนินงาน", "งบประมาณ", "สถานที่ทำการ"]);
  const statistics = narr(["การวิเคราะห์(?:ข้อมูล|ผล)", "สถิติ", "Statistic", "Data analysis"],
    ["Risks?", "Benefit", "Consent", "ความเสี่ยง", "ประโยชน์", "ยินยอม", "ระยะเวลาที่ทำการ", "แผนการดำเนิน"]);
  const outcomes = inline(text, ["Outcomes?", "ตัวแปร", "Outcome measures?"]);

  const inclusionInline = splitItems(inline(text, ["Inclusion", "เกณฑ์คัดเข้า"]));
  const methodology = {
    ...clone(DEFAULTS.submission.methodology),
    research_field: inline(text, ["Field", "สาขา", "สาขาวิชา"]),
    rationale,
    study_design: design,
    primary_objective: primary,
    secondary_objectives: secondaryItems,
    expected_benefits: narr(
      ["ผลลัพธ์ที่คาดว่าจะได้รับ", "ประโยชน์ที่(?:คาดว่า|จะได้)", "Expected (?:outcomes?|benefits?)", "Benefits?"],
      ["การบูรณาการ", "งบประมาณ", "แผนการดำเนิน", "Consent", "ความเสี่ยง"]),
    target_population: narr(
      ["ประชากรและกลุ่มตัวอย่าง", "ประชากรเป้าหมาย", String.raw`ประชากร\b`, "target population", "Population"],
      ["กลุ่มตัวอย่าง", "เครื่องมือ", "การเก็บข้อมูล", "เกณฑ์", "วิธีการ"]),
    sample_size: findSampleSize(text),
    sample_size_calculation: inline(text, ["sample size", "ขนาดตัวอย่าง"]),
    recruitment_process: narr(["การสรรหา", "Recruit", "สรรหา", "การเข้าถึง"], ["เกณฑ์", "Inclusion"]),
    inclusion_criteria: inclusionInline.length ? inclusionInline
      : sectionBody(text, ["เกณฑ์การคัดเข้า", "เกณฑ์คัดเข้า", "Inclusion criteria"],
        ["เกณฑ์(?:การคัดออก|คัดออก)", "Exclusion", "เครื่องมือ", "วิธีการ"]),
    exclusion_criteria: splitItems(inline(text, ["Exclusion", "เกณฑ์คัดออก"])),
    withdrawal_criteria: splitItems(inline(text, ["Withdrawal", "เกณฑ์ถอน"])),
    procedures,
    outcome_measures: outcomes,
    statistical_analysis: statistics,
    consent_method: consentMethod(text),
    consent_process: inline(text, ["Consent", "การขอความยินยอม"]),
  };

  const risksBlock = block(text, ["Risks?", "ความเสี่ยง"],
    ["Benefit", "Consent", "Data", "ประโยชน์", "ยินยอม", "การจัดการข้อมูล"]);
  const rp = (k) => hasPositive(risksBlock, k);
  const sp = (k) => hasPositive(scanText, k);
  const psych = rp("psycholog") || rp("fatigue") || rp("discomfort") || rp("ทางจิต") || rp("อึดอัด") || rp("กังวล") || rp("เสียเวลา");
  const risks = {
    ...clone(DEFAULTS.submission.risks),
    physical: rp("physical") || rp("ทางกาย") || rp("เจ็บ") || rp("แพ้ยา"),
    psychological: psych,
    social: rp("social") || rp("reputation") || rp("ทางสังคม") || rp("ชื่อเสียง"),
    economic: rp("economic") || rp("financial") || rp("เศรษฐกิจ") || rp("การเงิน"),
    psychological_detail: psych ? risksBlock : "",
    collects_personal_data: sp(String.raw`personal (?:identifiable )?data`) || sp("ข้อมูลส่วนบุคคล") || sp("hospital number"),
    legal_or_reputational_risk: rp("legal") || rp("criminal") || rp("reputation") || rp("คดี"),
    uses_deception: sp("deception") || sp("หลอกลวง") || sp("ปกปิดวัตถุประสงค์"),
    audio_video_recording: has(scanText, "audio record", "video record", "recorded", "บันทึกเสียง", "ถ่ายภาพ", "บันทึกวิดีโอ"),
    mitigation: inline(text, ["mitigat", "ลดความเสี่ยง"]),
  };

  const benefits = {
    ...clone(DEFAULTS.submission.benefits),
    direct: hasPositive(scanText, "direct benefit"),
    to_society: has(scanText, "benefit.*society", "benefit.*future users", "ประโยชน์ต่อสังคม", "องค์ความรู้"),
    indirect_detail: inline(text, ["indirect benefit"]),
    to_others_detail: inline(text, ["Benefits?"]),
  };
  if (has(text, "no direct benefit", "ไม่มีประโยชน์โดยตรง")) {
    benefits.direct = false;
    benefits.direct_detail = "ไม่มีประโยชน์โดยตรงต่อผู้เข้าร่วม";
  }

  const data = {
    ...clone(DEFAULTS.submission.data_management),
    identifiability: has(text, "anonym", "participant code", "ไม่ระบุตัวตน", "รหัสผู้เข้าร่วม") ? "anonymized" : "identifiable",
    storage_method: inline(text, ["stored", "storage", "เก็บข้อมูล", "จัดเก็บ"]),
    confidentiality_method: inline(text, ["confidential", "encrypt", "password", "รักษาความลับ", "รหัส"]),
    retention_years: retentionYears(text),
    destruction_plan: inline(text, ["delet", "destroy", "ทำลายข้อมูล", "ลบข้อมูล"]),
  };

  const layman = {
    ...clone(DEFAULTS.submission.layman),
    // Differs from Python on purpose: Python put the first 600 characters of the rationale
    // here, cut mid-word and duplicating section 3. The summary must be written (by the
    // researcher or with the Claude-assist panel), so it starts empty.
    plain_summary: "",
    plain_rationale: rationale,
    plain_objectives: primary,
    plain_design: design,
    participant_tasks: procedures,
    foreseeable_risks: risksBlock,
    direct_benefits: benefits.direct_detail,
    indirect_benefits: benefits.to_others_detail,
    confidentiality: data.confidentiality_method,
    compensation: inline(text, ["Compensation", "ค่าตอบแทน", "reimburse"]),
    participant_costs: inline(text, ["cost to participant", "ค่าใช้จ่าย.*ผู้เข้าร่วม"]),
  };

  let startDate = parseDate(inline(text, ["Start date", "Data collection start", "เดือน/ปี ที่จะเริ่ม",
    "วันที่เริ่ม", "เริ่มเก็บข้อมูล", "เริ่มโครงการ", "^เริ่ม"]));
  let endDate = parseDate(inline(text, ["Expected completion", "Completion date", "End date",
    "วันที่คาดว่าจะเสร็จ", "คาดว่าจะสิ้นสุด", "สิ้นสุดโครงการ", "สิ้นสุดการวิจัย"]));
  // Beyond Python: a project period written as a range, e.g.
  // "ระยะเวลาที่ทำการวิจัย: 12 เดือน (1 ตุลาคม 2569 – 30 กันยายน 2570)"
  if (!startDate || !endDate) {
    const D = String.raw`(?:\d{1,2}\s+)?(?:` + TH_MONTH_RE + String.raw`|[A-Za-z]{3,9}\.?)\s*(?:พ\.ศ\.\s*)?\d{4}`;
    const rm = search(String.raw`(?:ระยะเวลา|period|duration)[^\n]{0,80}?(` + D + String.raw`)\s*(?:[–\-]|ถึง|to|until)\s*(` + D + ")", text, "i");
    if (rm) {
      startDate = startDate || parseDate(rm[1]);
      endDate = endDate || parseDate(rm[2]);
    }
  }
  let duration = null;
  const dm = search(String.raw`ระยะเวลา[^\d]{0,30}?(\d{1,3})\s*(ปี|เดือน|year|month)`, text, "i");
  if (dm) {
    const n = pyInt(dm[1]);
    duration = match("ปี|year", dm[2], "i") ? n * 12 : n;
  }
  if (duration == null) duration = monthDiff(startDate, endDate);
  if (duration == null) {
    const ym = search(String.raw`(\d{1,2})\s*(?:ปี|years?)\b`, text);
    duration = ym ? pyInt(ym[1]) * 12 : (intNear(text, "month") || intNear(text, "เดือน"));
  }

  const sites = inline(text, ["Research site", "Study site", "Location", "Site", "สถานที่ทำการวิจัย", "สถานที่วิจัย", "สถานที่เก็บข้อมูล"]);
  const isMulti = hasPositive(text, "multi-?cent(?:er|re)") || hasPositive(text, "สหสถาบัน") || hasPositive(text, "หลายสถาบัน");
  const multiInst = isMulti ? inline(text, ["participating (?:site|institution)s?", "สถาบันที่ร่วมวิจัย", "ร่วมกับสถาบัน"]) : "";

  const meta = {
    ...clone(DEFAULTS.submission.meta),
    title_th: strip(titleTh), title_en: strip(titleEn), start_date: startDate, end_date: endDate,
    duration_months: duration, sites, is_multicenter: isMulti, multicenter_institutions: multiInst,
  };

  const fund = funding(text);
  if (!fund.recipient_name) fund.recipient_name = pi.title_th;
  if (fund.recipient_status == null) fund.recipient_status = pi.status;

  return {
    ...clone(DEFAULTS.submission),
    meta,
    principal_investigator: pi,
    co_investigators: coInvestigators,
    advisors,
    funding: fund,
    flags: { is_research: true, is_human_subject: !has(scanText, "not (?:a )?human", "ไม่ใช่การวิจัยในมนุษย์") },
    population: population(scanText),
    classification: classification(scanText),
    methodology,
    risks,
    benefits,
    data_management: data,
    layman,
  };
}

// ---------------------------------------------------------------- heuristics (extractor.apply_heuristics)

const vulnerableAny = (v) => v.cognitive_communication || v.institutional || v.deferral || v.medical
  || v.economic || v.social || Boolean(strip(v.other || ""));

export function recommendReview(s) {
  const c = s.classification;
  const r = s.risks;
  const high = c.has_drug || c.has_medical_device || c.has_procedure || c.has_genetics || c.has_placebo
    || r.physical || s.vulnerable.medical || s.vulnerable.cognitive_communication;
  if (high) return "full_board";
  const lowDesign = c.is_education || c.is_survey_interview || c.is_secondary_data;
  const minimal = !(r.legal_or_reputational_risk || r.physical || r.uses_deception);
  if (lowDesign && minimal && !vulnerableAny(s.vulnerable)) return "exempt";
  if (lowDesign && minimal) return "expedited";
  return "full_board";
}

export function applyHeuristics(s) {
  const pop = s.population;
  const v = s.vulnerable;
  const c = s.classification;
  if (pop.students) v.deferral = true;
  if (pop.institutional_staff) v.deferral = true;
  if (pop.military_police || pop.prisoners) v.institutional = true;
  if (pop.children || pop.cognitive_impaired) v.cognitive_communication = true;
  if (pop.terminally_ill || pop.chronic_patients) v.medical = true;
  if (pop.homeless || pop.refugees) v.economic = true;
  if (pop.ethnic_groups) v.social = true;

  if (!c.has_drug) c.drug_names = "";
  if (!c.has_food_product) c.food_detail = "";
  if (!c.has_dietary_supplement) c.supplement_detail = "";
  if (!c.has_herbal) c.herbal_detail = "";
  if (!c.has_cosmetic) c.cosmetic_detail = "";
  if (!c.has_medical_device) c.device_names = "";
  if (!c.has_procedure) c.procedure_detail = "";

  if (!s.coi_declarations.length) {
    for (const p of [s.principal_investigator, ...s.co_investigators]) {
      const name = p.title_th || p.name_en;
      if (name) s.coi_declarations.push({ ...clone(DEFAULTS.coi), person_name: name });
    }
  }
  s.recommended_review = recommendReview(s);
  return s;
}

// ---------------------------------------------------------------- fee (fees.compute_fee)

const FEE_LABELS = {
  A: "โครงการวิจัยที่ได้รับทุนจากภาครัฐภายในประเทศ หรือหน่วยงานที่ไม่แสวงหาผลกำไร",
  B: "โครงการวิจัยที่ได้รับทุนจากบริษัทเอกชนแสวงหาผลกำไร หรือทุนจากต่างประเทศ",
  C: "ทุนมหาวิทยาลัยแม่ฟ้าหลวง หรือไม่ได้รับทุน ดำเนินการโดยพนักงานสายวิชาการ",
  D: "ทุนมหาวิทยาลัยแม่ฟ้าหลวง หรือไม่ได้รับทุน ดำเนินการโดยนักศึกษาปริญญาโท/เอก",
  E: "ทุนมหาวิทยาลัยแม่ฟ้าหลวง หรือไม่ได้รับทุน ดำเนินการโดยนักศึกษาปริญญาตรี",
  F: "โครงการวิจัยหลายสถาบันภายใต้ความร่วมมือกับ CREC",
};
const FEE_AMOUNTS = { A: 3500, B: 7000, C: 1500, D: 500, E: 0, F: 1500 };

export function computeFee(s) {
  const f = s.funding;
  const st = s.principal_investigator.status;
  let opt;
  if (f.is_crec_multicenter) opt = "F";
  else if (f.funding_type === "government" || f.funding_type === "nonprofit") opt = "A";
  else if (f.funding_type === "private" || f.funding_type === "foreign") opt = "B";
  else if (st === "bachelor") opt = "E";
  else if (st === "master" || st === "doctoral") opt = "D";
  else opt = "C";
  return { option: opt, amount_baht: FEE_AMOUNTS[opt], label: FEE_LABELS[opt], exempt: FEE_AMOUNTS[opt] === 0 };
}

// ---------------------------------------------------------------- forms (forms.select_forms)

export const FORM_TITLES = {
  AP01_1: "แบบรายงานการส่งโครงการวิจัยเพื่อพิจารณา",
  AP01_2: "เอกสารเปิดเผยการมีผลประโยชน์ทับซ้อน",
  AP01_3: "หนังสือรับรองการเป็นอาจารย์ที่ปรึกษาโครงการวิจัยของนักศึกษา",
  AP02: "แบบเสนอโครงการวิจัยเพื่อพิจารณา",
  AP03_1: "เอกสารข้อมูลและขอความยินยอมเข้าร่วมการวิจัย",
  AP03_2: "เอกสารขอความยินยอมแบบเปิดกว้าง (เก็บข้อมูล/ตัวอย่างชีวภาพเพื่อการวิจัยในอนาคต)",
  AP03_3: "เอกสารขอความยินยอมสำหรับการวิจัยด้านพันธุกรรม",
  AP03_4: "เอกสารขอความยินยอม อาสาสมัครเด็ก อายุ 7-12 ปี",
  AP03_5: "เอกสารขอความยินยอมสำหรับการใช้ศพเพื่อการศึกษาหรือวิจัย",
  AP03_6: "เอกสารขอความยินยอมสำหรับการรายงานกรณีศึกษา",
};

export function selectForms(s) {
  const out = ["AP01_1", "AP01_2", "AP02", "AP03_1"].map((code) => ({
    code, title: FORM_TITLES[code], reason: "เอกสารหลักที่ทุกโครงการต้องส่ง", core: true,
  }));
  const add = (code, reason) => out.push({ code, title: FORM_TITLES[code], reason, core: false });
  if (isStudent(s.principal_investigator.status) || s.advisors.length) {
    add("AP01_3", "เป็นโครงการวิจัยของนักศึกษา (ผู้วิจัยหลักเป็นนักศึกษา หรือมีอาจารย์ที่ปรึกษา)");
  }
  const c = s.classification;
  if (c.has_future_biobank) add("AP03_2", "มีการเก็บรักษาข้อมูล/ตัวอย่างชีวภาพไว้ใช้ในการวิจัยอื่นในอนาคต (9.7)");
  if (c.has_genetics) add("AP03_3", "เป็นการวิจัยด้านพันธุกรรม/มนุษย์พันธุศาสตร์ (9.6)");
  if (s.population.children) add("AP03_4", "มีอาสาสมัครเด็กเข้าร่วมการวิจัย (4.5) — ต้องมีเอกสารยินยอมสำหรับเด็ก");
  if (c.uses_cadaver) add("AP03_5", "มีการใช้ศพเพื่อการศึกษาหรือวิจัย");
  if (c.is_case_report) add("AP03_6", "เป็นการรายงานกรณีศึกษา (case report)");
  return out;
}

// Python textnorm.thai_join (exported for the golden test only; not applied, see top)
export function thaiJoin(t) {
  if (!t) return t;
  return t.replace(/[ \t ]{2,}/g, " ").replace(/(?<=[฀-๿])[ \t ]+(?=[฀-๿])/g, "");
}

// Work plan (Gantt) from a .docx table: a header row with an activity column and month
// columns numbered 1..N (or Thai month abbreviations); a month counts as planned when its
// cell has any mark or is shaded. Rows with no planned month (phase titles) are skipped.
export function planFromTables(tables) {
  const monthAbbr = Object.keys(TH_MONTHS).filter((k) => k.includes("."));
  for (const t of tables || []) {
    const h = t.findIndex((row) => row.some((c) => search("กิจกรรม|activit", c.text, "i"))
      && row.filter((c) => /^\d{1,2}$/.test(c.text) || monthAbbr.some((m) => c.text.startsWith(m))).length >= 3);
    if (h < 0) continue;
    const head = t[h];
    const monthCols = head.map((c, i) => (/^\d{1,2}$/.test(c.text) || monthAbbr.some((m) => c.text.startsWith(m)) ? i : -1)).filter((i) => i >= 0);
    const taskCol = head.findIndex((c) => search("กิจกรรม|activit", c.text, "i"));
    const ownerCol = head.findIndex((c) => search("ผู้รับผิดชอบ|responsib", c.text, "i"));
    const rows = [];
    for (const row of t.slice(h + 1)) {
      const task = strip(sub(String.raw`^\d{1,2}[.)]\s*`, "", row[taskCol]?.text || ""));
      if (!task) continue;
      const m = monthCols.map((i) => Boolean(row[i] && ((row[i].text && !/^\[ \]$/.test(row[i].text)) || row[i].shaded)));
      if (!m.some(Boolean)) continue;
      rows.push({ task: task.replace(/\s+/g, " "), m, owner: ownerCol >= 0 ? strip(row[ownerCol]?.text || "") : "" });
    }
    if (rows.length) return rows;
  }
  return [];
}

// Literature review (AP 02 ข้อ 9) and references (AP 02 ข้อ 18); the Python tool has
// neither. A review runs over several paragraphs with its own sub-headings ("8.1 ..."),
// so it is read from its heading to the next major heading, keeping paragraph breaks.
const LIT_START = String.raw`^(?:การทบทวนวรรณกรรม|ทบทวนวรรณกรรม|การรวบรวมรายงานที่เกี่ยวข้อง|แนวคิด\s*(?:,\s*)?ทฤษฎี|ทฤษฎี(?:และ|\s)*(?:เอกสาร|งานวิจัย)ที่เกี่ยวข้อง|เอกสารและงานวิจัยที่เกี่ยวข้อง|ทบทวนเอกสาร|ผลงานวิจัย(?:ต่าง\s*ๆ)?\s*ที่เกี่ยวข้อง|งานวิจัยที่เกี่ยวข้อง|(?:review of\s+)?(?:related\s+)?literature(?:\s+review)?|related (?:work|studies))`;
const REF_START = String.raw`^(?:เอกสารอ้างอิง|บรรณานุกรม|รายการอ้างอิง|references?|bibliography)`;
const AFTER_LIT = String.raw`^(?:เอกสารอ้างอิง|บรรณานุกรม|รายการอ้างอิง|references?\b|bibliography|กระบวนการและวิธีการ|วิธีการดำเนิน|ระเบียบวิธี|ขอบเขต|กรอบแนวคิด|กรอบการวิจัย|สมมติฐาน|รูปแบบ(?:ของ)?(?:การ|งาน)วิจัย|ประชากร|ลักษณะ(?:ของ)?(?:กลุ่ม)?(?:ตัวอย่าง|ประชากร)|study design|methods?\b|methodology|procedures?\b)`;
const AFTER_REF = String.raw`^(?:กระบวนการและวิธีการ|วิธีการดำเนิน|ระเบียบวิธี|แผนการดำเนิน|ขอบเขต|งบประมาณ|ภาคผนวก|ประวัติ|ระยะเวลา|appendix|methods?\b|methodology|procedures?\b|budget)`;
// numbering in front of a heading: "8.", "8.1", "ก.", "บทที่ 2", "Chapter 2"
const HEAD_LEAD = String.raw`^[\s\-•*#>]*(?:(?:บทที่|chapter)\s*\d{1,2}\.?\s*[:：]?\s*|\d{1,2}(?:\.\d{1,2})*\.?\s+|[ก-ฮ]\.\s+)?`;
const headText = (line) => strip(sub(HEAD_LEAD, "", line));
const shortLine = (line) => strip(line).length <= 90;

// The section under the first heading matching startRe: { start, end, lines: [{ i, t }] }
// with `i` the line index in `text` and `end` the index of the heading that closes it.
function sectionSpan(text, startRe, stopRe, maxLines = 300) {
  const lines = splitlines(text);
  for (let i = 0; i < lines.length; i++) {
    const h = headText(lines[i]);
    const m = search(startRe, h, "i");
    if (!m || !shortLine(lines[i])) continue;
    const out = [];
    const tail = strip(lstrip(h.slice(m.end), " :：-"));
    // "การทบทวนวรรณกรรม ผลงานวิจัยต่างๆ ที่เกี่ยวข้อง", "เอกสารอ้างอิงของโครงการ ระบุตาม..."
    // are still the heading, not content
    // Only text after "หัวข้อ:" or a long run-on is content; a short tail ("วิจัยและวิธีการ
    // ดำเนินการ" after "ระเบียบวิธี") is the rest of the heading.
    const inlineValue = search(String.raw`^\s*[:：]`, h.slice(m.end)) || tail.length > 90;
    if (tail && inlineValue && !search(LIT_START, tail, "i") && !search(String.raw`^(?:ของ|ที่|ระบุ|/|\(|สารสนเทศ)`, tail)) out.push({ i, t: tail });
    let j = i + 1;
    let parent = null; // "8" once a sub-heading "8.1" is seen: later "8.x" lines belong here
    // "9. การรวบรวมรายงาน..." ends at "10. ..." whatever ข้อ 10 is called ("รูปแบบงานวิจัย")
    const no = match(String.raw`^\s*(\d{1,2})\.\s`, lines[i]);
    const nextNo = no ? Number(no[1]) + 1 : null;
    for (; j < lines.length && out.length < maxLines; j++) {
      const raw = lines[j];
      if (!strip(raw)) continue;
      const sub2 = match(String.raw`^\s*(\d{1,2})\.\d{1,2}`, raw);
      if (sub2 && parent === null) parent = sub2[1];
      // a sub-heading of this section ("8.3 การวิเคราะห์ข้อมูล..." inside ข้อ 8) never ends it
      const ownSub = sub2 && sub2[1] === parent;
      if (!ownSub && shortLine(raw) && search(stopRe, headText(raw), "i")) break;
      // only a line that looks like a heading: short words, no year, link or ";" / ":" as a
      // reference has ("10. กรมการแพทย์. แนวทาง... 2563.", "10. WHO. https://...")
      const top = nextNo && match(String.raw`^\s*(\d{1,2})\.(?:\s+(\S.*))?$`, raw);
      const headLike = top && strip(top[2] || "").length <= 60 && !/\d{4}|https?:|www\.|[;:]/.test(top[2] || "");
      if (headLike && Number(top[1]) === nextNo && !isCitation(raw)) break;
      out.push({ i: j, t: strip(sub(String.raw`^[\s\-•*>]+`, "", raw)) });
    }
    if (out.length) return { start: i, end: j, lines: out };
  }
  return null;
}

const sectionLines = (text, startRe, stopRe) => (sectionSpan(text, startRe, stopRe)?.lines || []).map((l) => l.t);

export function literatureReview(text) {
  return sectionLines(text || "", LIT_START, AFTER_LIT).join("\n");
}

// ---------------------------------------------------------------- pictures and tables

// Fields of the forms that may hold pictures and tables, with the proposal headings they
// come from. A picture or table found under one of these headings in the .docx is put into
// that field, at its place in the text as a marker line "[[รูป 1]]" / "[[ตาราง 1]]";
// the form draws the item where its marker is.
export const MEDIA_MARK = /\[\[(รูป|ตาราง) (\d+)\]\]/g;
const OTHER_MAJOR = String.raw`เอกสารอ้างอิง|บรรณานุกรม|รายการอ้างอิง|references?\b|bibliography|แผนการดำเนิน|แผนการใช้จ่าย|งบประมาณ|ระยะเวลา|ผลผลิต|ผลลัพธ์|ผลกระทบ|ประโยชน์ที่|ข้อพิจารณาด้านจริยธรรม|ภาคผนวก|ประวัติ|วัตถุประสงค์|หลักการและเหตุผล|ความสำคัญของ|กลุ่มเป้าหมาย|ส่วนที่\s*\d|บทสรุป|คำถาม(?:การ)?วิจัย|ระดับความพร้อม|มาตรฐานการวิจัย|หน่วยงานร่วม|พื้นที่ที่ได้รับประโยชน์|ลักษณะ(?:ของ)?(?:กลุ่ม)?(?:ตัวอย่าง|ประชากร)`;
const MEDIA_TARGETS = [
  { path: "methodology.literature_review", start: LIT_START.slice(1) },
  { path: "methodology.study_design", start: String.raw`(?:รูปแบบ(?:ของ)?(?:การ|งาน)วิจัย|การออกแบบการวิจัย|กรอบแนว(?:ความ)?คิด|กรอบการวิจัย|study design|research design|conceptual framework)` },
  { path: "methodology.procedures", start: String.raw`(?:กระบวนการและวิธีการ|วิธีการดำเนิน|ระเบียบวิธี|ขั้นตอนการวิจัย|แนวทางการดำเนินงาน|methods?\b|methodology|procedures?\b)` },
  // not a bare "คำจำกัดความ": grant forms use it for their own output-type tables
  { path: "methodology.operational_definitions", start: String.raw`(?:คำจำกัดความ(?:ที่ใช้ใน|เชิงปฏิบัติการ|ศัพท์)|นิยามศัพท์|นิยามเชิงปฏิบัติการ|operational definitions?)` },
  { path: "methodology.statistical_analysis", start: String.raw`(?:การวิเคราะห์(?:ข้อมูล|ผล|ทางสถิติ)|สถิติที่ใช้|statistical analysis|data analysis)` },
];

// Spans of the target headings inside text lines [from, to), as line indexes of the whole text.
function targetSpans(lines, from, to) {
  const part = lines.slice(from, to).join("\n");
  return MEDIA_TARGETS.map((t) => {
    const others = MEDIA_TARGETS.filter((o) => o !== t && !(t.through || []).includes(o.path)).map((o) => o.start).join("|");
    const sp = sectionSpan(part, `^${t.start}`, `^(?:${others}|${OTHER_MAJOR})`);
    return sp && { path: t.path, span: { start: sp.start + from, end: sp.end + from, lines: sp.lines.map((l) => ({ i: l.i + from, t: l.t })) } };
  }).filter(Boolean);
}

// A reference-list entry: "Cheng, B., ... (2016). Title" (APA) or "Doe J. Title. 2021;5:6" (Vancouver).
const CITATION = String.raw`^(?:\[\d{1,3}\]\s*|\d{1,3}[.)]\s*)?(?:[A-ZÀ-ɏ][\wÀ-ɏ'’\-]+(?:\s[\wÀ-ɏ'’\-]+){0,3},?\s[A-Z]|[ก-๙]+\s[ก-๙]+[.,]?\s).*?(?:\(\d{4}[a-z]?[,)]|[,.]\s*\d{4}[a-z]?[.;,]|\.\s*\d{4};)`;
// also a Latin-script line with a year, e.g. "de León-Solis, C., ... 2023. Metabolomics ..."
const isCitation = (l) => Boolean(search(CITATION, l)) || (!search("[ก-๙]", l) && l.length > 30 && Boolean(search(String.raw`\b(?:19|20)\d{2}[a-z]?\b`, l)));

// Long sections (AP 02 ข้อ 9, 10, 12.1.1, 12.3, 13): the whole text under the proposal's
// heading, sub-headings included, with each picture or table of the .docx as a marker
// line "[[รูป 1]]" / "[[ตาราง 1]]" where it stood; the form draws the item there.
// The rules above stop at the first sub-heading, so the longer text wins. A run of
// reference entries closing the review (forms without a "เอกสารอ้างอิง" heading) goes to ข้อ 18.
// `media` items may carry `seg: [from, to)`, the lines of the file they came from when
// several files were joined; headings are then looked up in that file only.
export function fillSections(s, text, media = []) {
  const skipped = media.filter((m) => m.kind === "skip");
  // on a filled EC form the tables are the form's own layout, not content
  media = media.filter((m) => m.kind !== "skip" && !(s._locked && m.kind === "table"));
  // for the page: what the file held and what could be used (not stored with the project)
  const report = { pictures: media.filter((m) => m.kind === "img").length + skipped.length, tables: media.filter((m) => m.kind === "table").length,
    placedPictures: 0, placedTables: 0, unusable: skipped.map((m) => m.why) };
  Object.defineProperty(s, "_mediaReport", { value: report, enumerable: false, configurable: true });
  const lines = splitlines(text);
  const segKey = (m) => (m.seg ? m.seg.join(":") : "all");
  const spansBySeg = { all: targetSpans(lines, 0, lines.length) };
  for (const m of media) {
    const k = segKey(m);
    if (!spansBySeg[k]) spansBySeg[k] = targetSpans(lines, m.seg[0], m.seg[1]);
  }
  const counts = { img: 0, table: 0 };
  const placed = {}; // path -> [{ line, id, skip: [from, to), span }]
  if (media.length) s.media = { ...(s.media || {}) };
  for (const m of [...media].sort((a, b) => a.line - b.line)) {
    const home = spansBySeg[segKey(m)].filter((x) => x.span.start < m.line && m.line <= x.span.end)
      .sort((a, b) => b.span.start - a.span.start)[0];
    if (!home) continue;
    const id = m.kind === "img" ? `รูป ${++counts.img}` : `ตาราง ${++counts.table}`;
    if (m.kind === "img") report.placedPictures++; else report.placedTables++;
    s.media[id] = m.kind === "img" ? { kind: "img", src: m.src, name: m.name || "" } : { kind: "table", rows: m.rows };
    (placed[home.path] ||= []).push({ line: m.line, id, skip: m.kind === "table" ? [m.line, m.line + (m.lines || 0)] : null, span: home.span });
  }
  const bare = (v) => strip(String(v || "").replace(MEDIA_MARK, ""));
  const done = new Set();
  for (const { path, span } of spansBySeg.all) {
    const [k1, k2] = path.split(".");
    const all = placed[path] || [];
    const items = all.filter((it) => it.span.start === span.start);
    const rest = all.filter((it) => !items.includes(it));
    done.add(path);
    let body = span.lines;
    if (path === "methodology.literature_review") {
      let r = body.length;
      while (r > 0 && isCitation(body[r - 1].t)) r--;
      if (body.length - r >= 3) {
        const refs = body.slice(r).map((l) => strip(sub(String.raw`^(?:\[\d{1,3}\]|\d{1,3}[.)])\s*`, "", l.t)));
        if (!s.ap02?.references?.length) s.ap02 = { ...(s.ap02 || {}), references: refs };
        body = body.slice(0, r);
      }
    }
    const out = [];
    let n = 0;
    for (const l of body) {
      while (n < items.length && items[n].line <= l.i) out.push(`[[${items[n++].id}]]`);
      if (items.some((it) => it.skip && l.i >= it.skip[0] && l.i < it.skip[1])) continue;
      out.push(l.t);
    }
    while (n < items.length) out.push(`[[${items[n++].id}]]`);
    const fromSpan = out.join("\n");
    // a value read from a filled EC form is final: only its pictures are added
    if (s._locked?.has(path)) { if (items.length) s[k1][k2] = [strip(s[k1][k2] || ""), ...items.map((it) => `[[${it.id}]]`)].join("\n"); }
    else if (bare(fromSpan).length >= bare(s[k1][k2]).length) s[k1][k2] = fromSpan;
    else if (items.length) s[k1][k2] = [strip(s[k1][k2] || ""), ...items.map((it) => `[[${it.id}]]`)].join("\n");
    // from another file: after the text
    if (rest.length) s[k1][k2] = [strip(s[k1][k2] || ""), ...rest.map((it) => `[[${it.id}]]`)].filter(Boolean).join("\n");
  }
  // pictures under a heading that only another file has
  for (const path of Object.keys(placed)) {
    if (done.has(path)) continue;
    const [k1, k2] = path.split(".");
    s[k1][k2] = [strip(s[k1][k2] || ""), ...placed[path].map((it) => `[[${it.id}]]`)].filter(Boolean).join("\n");
  }
  return s;
}

export function referenceList(text) {
  // one entry per line; drop "1." / "[1]" numbering and guidance lines
  return sectionLines(text || "", REF_START, AFTER_REF)
    .map((l) => strip(sub(String.raw`^(?:\[\d{1,3}\]|\d{1,3}[.)])\s*`, "", l)))
    .filter((l) => l && !search(String.raw`^(?:ระบุตาม|ใช้รูปแบบ)`, l));
}

// ---------------------------------------------------------------- budget (AP 02 ข้อ 17.2)

// Grant budgets are kept by the funder's headings (ค่าจ้าง, ค่าตอบแทน, ค่าใช้สอย, ค่าวัสดุ);
// EC asks for 8 others. Every line of the proposal's budget table is put under one EC
// heading by its words; the researcher checks and can move a line on the main page.
export const EC_BUDGET = [
  ["compensation", "ค่าตอบแทนผู้เข้าร่วมการวิจัย"], ["care", "ค่าดูแลรักษาผู้เข้าร่วม"], ["supplies", "ค่าอุปกรณ์การวิจัย"],
  ["travel", "ค่าเดินทาง / ที่พัก"], ["design", "ค่าเขียนแบบ ออกแบบ และจัดทำต้นแบบ"], ["equipment", "ค่าครุภัณฑ์"],
  ["analysis", "ค่าวิเคราะห์ข้อมูล"], ["other", "อื่น ๆ"],
];

export function budgetCategory(text, group = "") {
  const t = `${text} ${group}`;
  if (search("ครุภัณฑ์", t)) return "equipment";
  // paid to participants only; pay for assistants, experts or students is "อื่น ๆ"
  if (search(String.raw`ค่าตอบแทน\S*\s*(?:\S+\s*)?(?:อาสาสมัคร|ผู้เข้าร่วม|ผู้ให้ข้อมูล|ผู้ตอบ|กลุ่มตัวอย่าง)|ค่าเสียเวลา|ของที่ระลึก|ของสมนาคุณ`, text)) return "compensation";
  if (search(String.raw`ค่ารักษา|ค่าดูแล|ประกันอุบัติเหตุ|ประกันภัย|ค่าชดเชย`, text)) return "care";
  if (search(String.raw`พาหนะ|เดินทาง|ค่าที่พัก|เบี้ยเลี้ยง|ค่าน้ำมัน|ค่าโดยสาร|เครื่องบิน|taxi|แท็กซี่`, text, "i")) return "travel";
  if (search(String.raw`^\s*(?:\d+[.)]?\s*)?(?:ค่า)?วัสดุ`, text) || search("วัสดุ", group)) return "supplies";
  if (search(String.raw`ต้นแบบ|ออกแบบ|เขียนแบบ|จัดทำชุด|prototype`, text, "i")) return "design";
  if (search(String.raw`วิเคราะห์|ทดสอบ|ประมวลผล|ห้องปฏิบัติการ|\blab\b|omics|sequenc`, text, "i")) return "analysis";
  if (search(String.raw`อุปกรณ์`, text)) return "supplies";
  return "other";
}

const money = (t) => {
  const s = String(t || "").replace(/\s/g, "");
  return /^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/.test(s) ? Number(s.replace(/,/g, "")) : null;
};

// { items: [{ item, detail, amount, group, cat }], total } from the most detailed budget table.
export function budgetFromTables(tables) {
  let best = null;
  for (const t of tables || []) {
    const rows = t.map((r) => r.map((c) => strip(c.text || "").replace(/\s+/g, " ")));
    const first = rows.findIndex((r) => r.some((c) => (money(c) ?? 0) >= 100));
    if (first <= 0) continue;
    const ncol = Math.max(...rows.map((r) => r.length));
    const head = (i) => rows.slice(0, first).map((r) => r[i] || "").join(" ");
    const cols = [...Array(ncol).keys()];
    const itemCol = cols.find((i) => search(String.raw`รายการ|รายละเอียดงบประมาณ`, head(i)) && !search("แตกตัวคูณ", head(i)));
    if (itemCol == null) continue;
    // the line's own amount: a "รวม" column (summing the instalments), else "งบประมาณ (บาท)",
    // never the funder's per-heading subtotal column ("งบประมาณรวมในรายการ...")
    const right = [...cols].reverse();
    let amtCol = right.find((i) => search(String.raw`(?:^|\s)รวม(?:\s|$)`, head(i)) && !search("รวมใน", head(i)));
    if (amtCol == null) amtCol = right.find((i) => search(String.raw`งบประมาณ\s*\(บาท\)`, head(i)) && !search("รวมใน", head(i)));
    if (amtCol == null) amtCol = right.find((i) => search("จำนวนเงิน|บาท", head(i)));
    if (amtCol == null || amtCol <= itemCol) continue;
    const detailCol = cols.find((i) => i > itemCol && i < amtCol && search(String.raw`แตกตัวคูณ|รายละเอียด`, head(i)));
    const items = [];
    let group = "";
    let total = null;
    for (const r of rows.slice(first)) {
      const item = r[itemCol] || "";
      let amt = money(r[amtCol]);
      // no amount in that column: an instalment column left of it may hold it; a number
      // only in a column to its right is the funder's subtotal on a heading row
      if (amt == null) amt = [...r.slice(itemCol + 1, amtCol)].reverse().map(money).find((x) => x != null) ?? null;
      if (r.some((c) => /^รวม/.test(c) && c.length < 80)) {
        // a total row may carry its number in any column (FF puts it in the subtotal one)
        const nums = r.map(money).filter((x) => x != null);
        if (nums.length) total = Math.max(total ?? 0, ...nums);
        continue;
      }
      if (!amt) {
        const g = r.find(Boolean);
        if (g) group = g;
        continue;
      }
      const detail = detailCol != null && r[detailCol] !== item ? r[detailCol] || "" : "";
      const label = item || r.find((c) => c && money(c) == null) || "";
      items.push({ item: label, detail, amount: amt, group, cat: budgetCategory(`${label} ${detail}`, group) });
    }
    if (items.length && (!best || items.length > best.items.length)) best = { items, total };
  }
  return best;
}

// The 8 EC headings from the lines (a heading with nothing is left empty, not 0).
export function budgetSums(items) {
  const out = {};
  for (const [k] of EC_BUDGET) {
    const sum = items.filter((x) => x.cat === k).reduce((a, x) => a + x.amount, 0);
    out[k] = sum ? Math.round(sum * 100) / 100 : null;
  }
  return out;
}

// Full pipeline used by the page. `tables` and `media` (from loadDocument) are optional.
export function extractSubmission(text, tables = [], media = [], outline = null) {
  // the page header and footer a printed form repeats ("Version... Date... AP 02/2026",
  // "หน้า 4 จาก 10") are never an answer: blanked, so line numbers still hold; the form
  // reader gets the file as it is (its header names the form)
  const raw = String(text || "");
  text = raw.split("\n").map((l) => (PAGE_MARK.test(l.trim()) ? "" : l)).join("\n");
  const s = applyHeuristics(buildLocalSubmission(text));
  // general pass by the document's own headings and "หัวข้อ | ค่า" rows (sections.js)
  const sources = fillFromOutline(s, text, outline || textOutline(text), tables);
  // a filled EC form read back by the forms' own labels replaces the guesses
  const noForm = typeof process !== "undefined" && process.env?.EC_NO_FORM; // for before/after measurements
  const rulePi = s.principal_investigator.title_th; // the recipient was copied from this
  const form = noForm ? null : readEcForm(s, raw, tables, parseDate);
  if (form) {
    for (const p of form.paths) if (!(p in form.found)) delete sources[p]; // blank on the form
    for (const p of Object.keys(form.found)) sources[p] = { form: form.form };
    Object.defineProperty(s, "_locked", { value: new Set([...Object.keys(form.found), ...form.paths]), enumerable: false, configurable: true });
    // the declarations follow the names read from the form
    s.coi_declarations = [s.principal_investigator, ...s.co_investigators]
      .map((p) => p.title_th || p.name_en).filter(Boolean)
      .map((name) => ({ ...clone(DEFAULTS.coi), person_name: name }));
  }
  Object.defineProperty(s, "_sources", { value: sources, enumerable: false, configurable: true });
  const plan = planFromTables(tables);
  if (plan.length) s.ap02 = { ...(s.ap02 || {}), timeline: plan };
  const refs = referenceList(text);
  if (refs.length && !s._locked?.has("ap02.references")) s.ap02 = { ...(s.ap02 || {}), references: refs };
  fillSections(s, text, media);
  // titles labelled "ชื่อโครงการ (ไทย): ..." / "(ชื่อภาษาอังกฤษ) ..." / "Title (EN): ..."; a form
  // code or a dotted blank picked up as a title is dropped
  const badTitle = (t) => !t || /^(?:AP\s*0\d|FEE\/|Version\b|แบบเสนอ|แบบรายงาน|[.…\s]+$)/i.test(String(t).trim());
  for (const [key, lang] of [["title_th", String.raw`ไทย|Thai`], ["title_en", String.raw`อังกฤษ|English`]]) {
    if (!badTitle(s.meta[key]) || s._locked?.has(`meta.${key}`)) continue;
    const m = search(String.raw`^\s*\(?(?:ชื่อ(?:โครงการ(?:วิจัย)?|เรื่อง)?)?\s*\(?(?:ภาษา)?(?:${lang})\)?\s*[:：]?\s*(.{6,})$`, text, "im");
    s.meta[key] = m && !badTitle(m[1]) ? strip(m[1]) : badTitle(s.meta[key]) ? "" : s.meta[key];
  }
  // unlabelled titles right under a "ชื่อโครงการวิจัย (Title)" heading: Thai line, then Latin line
  if (badTitle(s.meta.title_th) || badTitle(s.meta.title_en)) {
    const ls = splitlines(text).map((l) => strip(l));
    const h = ls.findIndex((l) => /^(?:\d{1,2}\.\s*)?ชื่อ(?:โครงการ|เรื่อง)(?:วิจัย)?(?:และนวัตกรรม)?\s*(?:\(Title\))?$/i.test(l) || /^(?:\d{1,2}\.\s*)?(?:project |research )?title$/i.test(l));
    for (const l of h >= 0 ? ls.slice(h + 1, h + 4) : []) {
      if (!l || l.length < 8 || badTitle(l) || /^\d{1,2}\.\s/.test(l)) continue;
      if (/[ก-๙]/.test(l) && badTitle(s.meta.title_th)) s.meta.title_th = l;
      else if (!/[ก-๙]/.test(l) && badTitle(s.meta.title_en)) s.meta.title_en = l;
    }
  }
  // the official forms' guidance sentences are never part of an answer
  for (const grp of ["methodology", "risks", "benefits", "data_management", "layman"]) {
    for (const [k, v] of Object.entries(s[grp] || {})) {
      if (!noForm && typeof v === "string" && v.length >= 25 && !s._locked?.has(`${grp}.${k}`)) s[grp][k] = stripFormText(v);
    }
  }
  // On a filled EC form, a guess of the other rules for a place the form has, made only of
  // the form's own words, dotted blanks and pieces of its labels ("ยินยอม", "ลายมือชื่อ",
  // "ขอความยินยอมเมื่อไร ที่ใด (ระ..."), is the form's empty place, not an answer.
  if (form) {
    const words = FORM_LABELS.filter((e) => e.form === form.form).map((e) => e.label.replace(/\s+/g, ""));
    const formWord = (l) => { const n = l.replace(/\s+/g, ""); return !n || /^[.…_\-–\s]*$/.test(n) || words.some((w) => w.includes(n) || (n.length >= 6 && w.startsWith(n.slice(0, 12)))); };
    for (const path of new Set(FORM_LABELS.filter((e) => e.form === form.form && e.path).map((e) => e.path))) {
      const [k1, k2] = path.split(".");
      const v = s[k1]?.[k2];
      if (typeof v !== "string" || !v.trim() || s._locked?.has(path)) continue;
      if (v.split("\n").every(formWord)) { s[k1][k2] = ""; delete sources[path]; }
    }
  }
  // a short value the label rules cut out of the middle of a sentence or a table row
  // ("MLO) | PLOs ที่เกี่ยวข้อง" after "Outcome-based") is not an answer
  for (const k of ["outcome_measures", "research_field", "consent_process", "sample_size_calculation", "recruitment_process"]) {
    const v = s.methodology[k];
    const t = typeof v === "string" ? v.trim() : "";
    // a ")" before any "(" means the value starts inside a bracket ("based Credibility)")
    const opensInside = t.indexOf(")") >= 0 && (t.indexOf("(") < 0 || t.indexOf(")") < t.indexOf("("));
    // "Outcome-based ..." read as the label "Outcome" and the value "based ..."
    const compoundTail = /^(?:based|oriented|driven|centered|centred|focused)\b/i.test(t);
    if (t && (/^[)\]|,.;:–-]/.test(t) || t.includes(" | ") || opensInside || compoundTail) && !s._locked?.has(`methodology.${k}`)) {
      if (typeof process !== "undefined" && process.env?.EC_DEBUG_DROP) console.log(`drop ${k}: ${t.slice(0, 100)}`);
      s.methodology[k] = "";
    }
  }
  // an EC form already has the 8 headings; only a proposal's own budget table is mapped
  const budget = [...(s._locked || [])].some((p) => p.startsWith("ap02.budget.")) ? null : budgetFromTables(tables);
  if (budget) {
    s.ap02 = { ...(s.ap02 || {}), budget_items: budget.items, budget: { ...(s.ap02?.budget || {}), ...budgetSums(budget.items) } };
    if (s.funding.amount_baht == null && budget.total) s.funding.amount_baht = budget.total;
  }
  // People. A "name" that is really a run of form text ("หรือ หัวหน้าโครงการวิจัย ตำแหน่ง...",
  // "ลำดับ | ...", "AP 01_2/2024") is not a person: the PI is taken from the form's person card
  // ("ตำแหน่งวิชาการ-ยศ-ชื่อ-สกุล | ชื่อ") or "ผู้วิจัยหลัก: ชื่อ", or left for the researcher;
  // such entries are dropped from the team; an English name in brackets goes to name_en.
  const LABEL_WORDS = /ตำแหน่งวิชาการ|ชื่อ\s*-\s*สกุล|หัวหน้าโครงการ|ผู้วิจัยหลัก|ผู้วิจัยร่วม|สาขาวิชา|ลำดับ|ที่ปรึกษา|วันที่|ลงนาม|ความเห็น|AP\s*0\d|ระบุชื่อ|ไม่มี|โครงการวิจัย|\.{3}|…|\|/;
  const PERSON = /^(?:นาย|นาง|นางสาว|น\.ส\.|ดร\.?|อ\.|อาจารย์|ผศ\.?|รศ\.?|ศ\.|ผู้ช่วยศาสตราจารย์|รองศาสตราจารย์|ศาสตราจารย์|พ\.?ต\.?|ร\.?ต\.?|Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|Asst\.?|Assoc\.?)|^[ก-๙]{2,}\s+[ก-๙]{2,}$/;
  const isPerson = (n) => Boolean(n) && n.length <= 70 && !LABEL_WORDS.test(n) && PERSON.test(n.trim());
  const splitName = (p) => {
    const m = String(p.title_th || "").match(/^([^(]*[ก-๙][^(]*?)\s*(?:\((.+?)\)|((?:Asst\.|Assoc\.|Prof\.|Dr\.|Mr\.|Mrs\.|Ms\.)[A-Za-z .,'-]+))\s*$/);
    if (m) { p.title_th = strip(m[1]); if (!p.name_en) p.name_en = strip(m[2] || m[3]); }
    return p;
  };
  const pi = splitName(s.principal_investigator);
  pi.title_th = strip(String(pi.title_th || "").replace(/[\s—–-]+$/, ""));
  for (const p of [pi, ...(s.co_investigators || []), ...(s.advisors || [])]) {
    if (p.name_en && (/Investigator|Advisor|Coordinator|\|/i.test(p.name_en) || p.name_en.length > 60)) p.name_en = "";
  }
  if (!isPerson(pi.title_th)) {
    const card = search(String.raw`^\s*ตำแหน่งวิชาการ\S*ชื่อ\S*สกุล\s*(?:\|\s*)?([^|\n]{3,60})`, text, "m");
    const m = search(String.raw`^\s*(?:ผู้วิจัยหลัก|หัวหน้าโครงการ)\s*[:：]\s*([^(—|\n]{3,60})`, text, "m");
    // "... ชื่อ-สกุล นางสาว ก ข สังกัดหน่วยงาน ..." inside one cell
    const inner = search(String.raw`ชื่อ\s*-\s*สกุล\s*[:：]?\s*((?:นาย|นาง|นางสาว|ดร\.|อ\.|อาจารย์|ผศ\.|รศ\.|ศ\.|ผู้ช่วยศาสตราจารย์|รองศาสตราจารย์)[^|\n]{2,50}?)(?=\s+(?:สังกัด|สาขา|หน่วยงาน|เบอร์|โทร|อีเมล|Email)|\s*\||\s*$)`, text, "m");
    const name = [card?.[1], m?.[1], inner?.[1]].map((x) => strip(x || "")).find(isPerson) || "";
    pi.title_th = name;
    if (!name) pi.affiliation = LABEL_WORDS.test(pi.affiliation || "") ? "" : pi.affiliation;
  }
  for (const k of ["co_investigators", "advisors"]) {
    s[k] = (s[k] || []).map(splitName).filter((p) => isPerson(p.title_th) || isPerson(p.name_en));
  }
  // the declarations (AP 01_2) are one per person of the team
  s.coi_declarations = [pi, ...s.co_investigators].map((p) => p.title_th || p.name_en).filter(Boolean)
    .map((name) => ({ ...clone(DEFAULTS.coi), person_name: name }));
  // the grant recipient defaults to the PI: follow the corrected name, unless the file
  // named the recipient itself (AP 01_1 ข้อ 2.2)
  if (!s._locked?.has("funding.recipient_name") && (!s.funding.recipient_name || s.funding.recipient_name === rulePi)) {
    s.funding.recipient_name = pi.title_th;
    if (pi.status) s.funding.recipient_status = pi.status;
  }
  s._fee = computeFee(s);
  s._forms = selectForms(s);
  return s;
}

// ---------------------------------------------------------------- several files

// Several files (a proposal and filled EC forms, or AP 01_1 + AP 02 + ...): each is read
// on its own, so a heading or a form label never runs from one file into the next, then
// the results are joined field by field. A value read from a filled EC form wins; else the
// first file that answers a field wins and later files fill the gaps. `docs` are
// loadDocument results; returns { submission, text, outline } with the joined text and
// outline (headings by line in that text) for the page.
export function extractSubmissions(docs) {
  const parts = [];
  const texts = [];
  const outline = [];
  let offset = 0;
  const counts = { รูป: 0, ตาราง: 0 };
  for (const d of docs) {
    const s = extractSubmission(d.text, d.tables || [], d.media || [], d.outline || null);
    // pictures and tables are numbered from 1 in each file: number them on
    const shift = { ...counts };
    const renum = (v) => typeof v === "string" ? v.replace(MEDIA_MARK, (_, k, n) => `[[${k} ${Number(n) + shift[k]}]]`)
      : Array.isArray(v) ? v.map(renum)
        : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renum(x)])) : v;
    const media = {};
    for (const [id, m] of Object.entries(s.media || {})) {
      const [k, n] = id.split(" ");
      media[`${k} ${Number(n) + shift[k]}`] = m;
      counts[k] = Math.max(counts[k], Number(n) + shift[k]);
    }
    const r = renum(s);
    if (s.media) r.media = media;
    const sources = {};
    for (const [p, src] of Object.entries(s._sources || {})) sources[p] = src.heading != null ? { ...src, heading: src.heading + outline.length } : src;
    parts.push({ s: r, sources, locked: s._locked || new Set(), report: s._mediaReport });
    const own = d.outline || textOutline(d.text);
    outline.push(...own.map((h) => ({ ...h, line: h.line + offset })));
    texts.push(d.text);
    offset += d.text.split("\n").length + 1;
  }
  const text = texts.join("\n\n");
  if (parts.length === 1) {
    const s = parts[0].s;
    for (const [k, v] of [["_sources", parts[0].sources], ["_locked", parts[0].locked], ["_mediaReport", parts[0].report]]) {
      if (v) Object.defineProperty(s, k, { value: v, enumerable: false, configurable: true });
    }
    return { submission: s, text, outline };
  }

  const locked = new Set();
  const sources = {};
  const isLocked = (part, path) => [...part.locked].some((p) => path === p || path.startsWith(`${p}.`));
  const def = (path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), DEFAULTS.submission);
  const blank = (v, path) => v == null || v === "" || (typeof v === "string" && !strip(v))
    || (Array.isArray(v) && !v.length) || JSON.stringify(v) === JSON.stringify(def(path));
  const marks = (v) => (typeof v === "string" ? v.match(MEDIA_MARK) || [] : []);
  const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
  const keysAt = (path) => [...new Set(parts.flatMap((p) => {
    const v = path ? path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), p.s) : p.s;
    return plain(v) ? Object.keys(v) : [];
  }))];
  const at = (part, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), part.s);
  const merge = (path) => {
    const vals = parts.map((p) => at(p, path));
    if (vals.some(plain) && !vals.some((v) => v != null && !plain(v))) {
      return Object.fromEntries(keysAt(path).map((k) => [k, merge(`${path}.${k}`)]));
    }
    // a filled form's answer, then the first file's, then the later ones'
    // a field one filled form has (even blank) is never filled from another form's guesses
    // (AP 01_1 has no ข้อ 2 สาขาวิชา of AP 02); a proposal file may fill it
    const formHas = parts.some((p) => isLocked(p, path));
    const order = [...parts.keys()].filter((i) => !formHas || isLocked(parts[i], path) || !parts[i].locked.size)
      .sort((a, b) => Number(isLocked(parts[b], path)) - Number(isLocked(parts[a], path)) || a - b);
    const win = order.find((i) => !blank(vals[i], path)) ?? order[0] ?? 0;
    let v = vals[win];
    if (isLocked(parts[win], path)) locked.add(path);
    if (parts[win].sources[path]) sources[path] = parts[win].sources[path];
    // pictures another file has under the same heading: after the text
    if (typeof v === "string") {
      const more = parts.flatMap((p, i) => (i === win ? [] : marks(vals[i]))).filter((m) => !v.includes(m));
      if (more.length) v = [strip(v), ...more].filter(Boolean).join("\n");
    }
    return v;
  };
  const s = Object.fromEntries(keysAt("").map((k) => [k, merge(k)]));
  s.media = Object.assign({}, ...parts.map((p) => p.s.media || {}));
  if (!Object.keys(s.media).length) delete s.media;
  // fields worked out from the others
  s.coi_declarations = [s.principal_investigator, ...s.co_investigators].map((p) => p.title_th || p.name_en).filter(Boolean)
    .map((name) => ({ ...clone(DEFAULTS.coi), person_name: name }));
  applyHeuristics(s);
  s._fee = computeFee(s);
  s._forms = selectForms(s);
  const report = parts.map((p) => p.report).filter(Boolean).reduce((a, r) => ({
    pictures: a.pictures + r.pictures, tables: a.tables + r.tables, placedPictures: a.placedPictures + r.placedPictures,
    placedTables: a.placedTables + r.placedTables, unusable: [...a.unusable, ...r.unusable],
  }), { pictures: 0, tables: 0, placedPictures: 0, placedTables: 0, unusable: [] });
  for (const [k, v] of [["_sources", sources], ["_locked", locked], ["_mediaReport", report]]) {
    Object.defineProperty(s, k, { value: v, enumerable: false, configurable: true });
  }
  return { submission: s, text, outline };
}
