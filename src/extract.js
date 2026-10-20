// Rule-based extraction of a proposal into an EthicsSubmission object.
// Line-by-line port of ec_mfu/local_extractor.py (build_local_submission) plus
// extractor.apply_heuristics, fees.compute_fee and forms.select_forms, so the
// browser gives the same answers as the Python tool. Golden-tested in tests/.
//
// One deliberate difference: Python ran thai_join() (deletes spaces between Thai
// words) to help Word justify text. The HTML forms are not justified, and those
// spaces are the reader's phrase breaks, so they are kept here.

import { DEFAULTS } from "./schema-defaults.js";
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

function personStatus(blob) {
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
  let ftype = "personal";
  if (has(scope, "university", "มหาวิทยาลัย", "สำนักวิชา", String.raw`internal (?:research )?grant`, "คณะ")) ftype = "university";
  if (has(scope, "government", "รัฐบาล", "ภาครัฐ", String.raw`วช\.?`, "สกสว", "บพข", "สวรส")) ftype = "government";
  if (has(scope, "private", "company", "บริษัท", "เอกชน")) ftype = "private";
  if (has(scope, "self[- ]?funded", "personal", "ทุนส่วนตัว", "ไม่มีทุน", "no funding")) ftype = "personal";

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

  const table = rosterFromTable(rosterText);
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
      const m = monthCols.map((i) => Boolean(row[i] && (row[i].text || row[i].shaded)));
      if (!m.some(Boolean)) continue;
      rows.push({ task: task.replace(/\s+/g, " "), m, owner: ownerCol >= 0 ? strip(row[ownerCol]?.text || "") : "" });
    }
    if (rows.length) return rows;
  }
  return [];
}

// Full pipeline used by the page. `tables` (from loadDocument) is optional.
export function extractSubmission(text, tables = []) {
  const s = applyHeuristics(buildLocalSubmission(text));
  const plan = planFromTables(tables);
  if (plan.length) s.ap02 = { ...(s.ap02 || {}), timeline: plan };
  s._fee = computeFee(s);
  s._forms = selectForms(s);
  return s;
}
