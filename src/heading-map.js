// Heading library: which headings of a proposal go to which EC field.
//
// Edit this file to teach the page a new way of writing a heading; no other code changes.
// Each entry of `heads` is one way of writing the heading (a regular expression, matched at
// the start of the heading's words, after its number "8." / "10.2"). Case is ignored.
//
// GENERIC is used for every file. TEMPLATES are grant proposal forms the page knows: when a
// file shows enough of a template's own headings (`detect`, at least `min` of them), that
// template's `fields` are taken first and replace what the general rules guessed, and its
// `none` fields (parts the template does not have, whose look-alike headings mean
// something else) are left for the researcher. A filled EC form read back still wins.
//
// Field entries: { type, heads, keepRows?, skip? }
//   type      "area" (paragraphs) | "list" (items) | "count" (a number) | "text" (one line)
//   keepRows  true: table rows under the heading are the content ("ด้านเศรษฐกิจ | 1. ...")
//   skip      lines to leave out (regular expressions), e.g. the form's own definitions

export const GENERIC = {
  fields: {
    "methodology.rationale": { type: "area", heads: [
      String.raw`ความสำคัญ(?:ของ(?:ปัญหา|โครงการ|การวิจัย))?`,
      String.raw`ที่มา(?:และความสำคัญ)?`,
      String.raw`หลักการและเหตุผล`,
      String.raw`เหตุผล(?:และ)?ความจำเป็น`,
      String.raw`rationale`,
      String.raw`background`,
      String.raw`significance`,
      String.raw`บทนำ`,
      String.raw`introduction`,
    ] },
    "methodology.expected_benefits": { type: "area", heads: [
      String.raw`ประโยชน์ที่(?:คาดว่าจะ)?(?:ได้รับ|จะได้)`,
      String.raw`ผล(?:ลัพธ์)?ที่คาดว่าจะได้รับ`,
      String.raw`ประโยชน์ของ(?:การวิจัย|โครงการ)`,
      String.raw`expected (?:benefits?|outcomes?)`,
      String.raw`benefits? of (?:the )?(?:study|research)`,
    ] },
    "methodology.target_population": { type: "area", heads: [
      String.raw`ประชากร(?:เป้าหมาย|ที่ศึกษา|ที่ใช้ในการวิจัย|และกลุ่มตัวอย่าง)?`,
      String.raw`ลักษณะ(?:ของ)?(?:ตัวอย่าง|ประชากร)`,
      String.raw`กลุ่มเป้าหมาย(?:ของการวิจัย|ที่ศึกษา)`,
      String.raw`ผู้เข้าร่วม(?:การ)?วิจัย`,
      String.raw`(?:target )?population`,
      String.raw`participants?\b`,
      String.raw`study (?:subjects|population)`,
    ] },
    "methodology.sample_size": { type: "count", heads: [
      String.raw`ขนาด(?:ของ)?(?:กลุ่ม)?ตัวอย่าง`,
      String.raw`จำนวน(?:ผู้เข้าร่วม(?:การ)?วิจัย|กลุ่มตัวอย่าง|ตัวอย่าง)`,
      String.raw`sample size\b(?! calc)`,
    ] },
    "methodology.sample_size_calculation": { type: "area", heads: [
      String.raw`(?:การ|สูตร(?:การ)?|วิธีการ)?(?:คำนวณ|กำหนด)ขนาด(?:ของ)?(?:กลุ่ม)?ตัวอย่าง`,
      String.raw`sample size (?:calculation|determination|justification)`,
      String.raw`power analysis`,
    ] },
    "methodology.recruitment_process": { type: "area", heads: [
      String.raw`(?:วิธีการ)?(?:เข้าถึงและ)?(?:การ)?สรรหา`,
      String.raw`(?:วิธี)?การ(?:คัด)?เลือก(?:กลุ่มตัวอย่าง|ผู้เข้าร่วม|ตัวอย่าง)`,
      String.raw`วิธีการ(?:เลือก|สุ่ม)(?:กลุ่ม)?ตัวอย่าง`,
      String.raw`การสุ่มตัวอย่าง`,
      String.raw`recruitment`,
      String.raw`sampling(?: method| technique)?`,
    ] },
    "methodology.inclusion_criteria": { type: "list", heads: [
      String.raw`เกณฑ์(?:การ)?คัด(?:เลือก)?เข้า`,
      String.raw`เกณฑ์การ(?:คัด)?เลือก(?:กลุ่ม)?(?:ตัวอย่าง|ผู้เข้าร่วม)`,
      String.raw`คุณสมบัติ(?:ของ)?(?:ผู้เข้าร่วม|กลุ่มตัวอย่าง)`,
      String.raw`inclusion criteria`,
      String.raw`eligibility criteria`,
    ] },
    "methodology.exclusion_criteria": { type: "list", heads: [
      String.raw`เกณฑ์(?:การ)?คัด(?:เลือก)?ออก`,
      String.raw`exclusion criteria`,
    ] },
    "methodology.withdrawal_criteria": { type: "list", heads: [
      String.raw`เกณฑ์(?:การ)?(?:ถอน|ยุติการเข้าร่วม|ให้ผู้เข้าร่วม\S*ออก)`,
      String.raw`withdrawal criteria`,
      String.raw`discontinuation criteria`,
    ] },
    "methodology.outcome_measures": { type: "area", heads: [
      String.raw`ตัวแปร(?:ตาม|ที่ศึกษา|ผลลัพธ์|ที่ใช้ในการวิจัย|ในการวิจัย)`,
      String.raw`(?:สรุป)?การวัดผล(?:การวิจัย|ลัพธ์)?`,
      String.raw`ผลลัพธ์(?:หลัก|ที่วัด|ที่ต้องการวัด)`,
      String.raw`outcome measures?`,
      String.raw`primary (?:outcome|endpoint)s?`,
      String.raw`dependent variables?`,
    ] },
    "methodology.operational_definitions": { type: "area", heads: [
      String.raw`นิยามศัพท์`,
      String.raw`คำจำกัดความ(?:ที่ใช้|เชิงปฏิบัติการ|ศัพท์)`,
      String.raw`นิยามเชิงปฏิบัติการ`,
      String.raw`operational definitions?`,
    ] },
    "risks.mitigation": { type: "area", heads: [
      String.raw`(?:วิธี|มาตรการ|แนวทาง)?(?:การ)?(?:ป้องกัน(?:และ)?)?(?:ลด|บริหาร|จัดการ)ความเสี่ยง`,
      String.raw`(?:แผน)?บริหารความเสี่ยง`,
      String.raw`risk (?:management|mitigation|minimi[sz]ation)`,
    ] },
    "risks.physical_detail": { type: "area", heads: [
      String.raw`ความเสี่ยงทางกาย`,
      String.raw`physical risks?`,
    ] },
    "risks.psychological_detail": { type: "area", heads: [
      String.raw`ความเสี่ยงทางจิตใจ`,
      String.raw`psychological risks?`,
    ] },
    "risks.social_detail": { type: "area", heads: [
      String.raw`ความเสี่ยงทางสังคม`,
      String.raw`social risks?`,
    ] },
    "risks.economic_detail": { type: "area", heads: [
      String.raw`ความเสี่ยงทางเศรษฐกิจ`,
      String.raw`economic risks?`,
    ] },
    "risks.inconvenience": { type: "area", heads: [
      String.raw`ความไม่สะดวก(?:สบาย)?`,
      String.raw`inconvenience`,
      String.raw`discomfort`,
    ] },
    "benefits.direct_detail": { type: "area", heads: [
      String.raw`ประโยชน์โดยตรง`,
      String.raw`direct benefits?`,
    ] },
    "benefits.indirect_detail": { type: "area", heads: [
      String.raw`ประโยชน์ทางอ้อม`,
      String.raw`indirect benefits?`,
    ] },
    "benefits.to_others_detail": { type: "area", heads: [
      String.raw`ประโยชน์ต่อ(?:ผู้อื่น|สังคม|ชุมชน|องค์ความรู้)`,
      String.raw`benefits? to (?:others|society)`,
    ] },
    // "การเก็บข้อมูล" alone is data collection, not keeping the data
    "data_management.storage_method": { type: "area", heads: [
      String.raw`(?:การ|วิธีการ|รูปแบบการ)?(?:จัดเก็บ|เก็บรักษา)(?:และ\S+)?ข้อมูล`,
      String.raw`รูปแบบการเก็บข้อมูล`,
      String.raw`สถานที่(?:จัด)?เก็บข้อมูล`,
      String.raw`การจัดการข้อมูล(?:ส่วนบุคคล|การวิจัย)?`,
      String.raw`data (?:storage|management plan)`,
    ] },
    "data_management.confidentiality_method": { type: "area", heads: [
      String.raw`(?:วิธี(?:การ)?)?(?:การ)?รักษาความลับ`,
      String.raw`การปกป้องข้อมูล(?:ส่วนบุคคล)?`,
      String.raw`ความเป็นส่วนตัว`,
      String.raw`confidentiality`,
      String.raw`privacy`,
      String.raw`data protection`,
    ] },
    "data_management.retention_years": { type: "count", heads: [
      String.raw`ระยะเวลา(?:ใน)?(?:การ)?(?:เก็บรักษา|จัดเก็บ)(?:ข้อมูล)?`,
      String.raw`data retention`,
      String.raw`retention period`,
    ] },
    "data_management.destruction_plan": { type: "area", heads: [
      String.raw`(?:การ|จะ)?ทำลายข้อมูล`,
      String.raw`การลบข้อมูล`,
      String.raw`data (?:destruction|disposal)`,
    ] },
    "methodology.consent_process": { type: "area", heads: [
      String.raw`(?:กระบวนการ|วิธีการ|ขั้นตอน)?(?:การ)?ขอความยินยอม`,
      String.raw`informed consent`,
      String.raw`consent process`,
    ] },
    "methodology.research_field": { type: "text", heads: [
      String.raw`สาขาวิชาที่ทำการวิจัย`,
      String.raw`สาขาวิชา(?!และ|\s*[/,]?\s*หน่วยงาน)(?=\s|$|[:：(])`,
      String.raw`สาขาการวิจัย(?:หลัก)?`,
      String.raw`research field`,
      String.raw`field of (?:study|research)`,
    ] },
    "meta.sites": { type: "text", heads: [
      String.raw`สถานที่(?:ทำการ)?(?:วิจัย|ทดลอง|เก็บข้อมูล|ดำเนินการ)`,
      String.raw`study sites?`,
      String.raw`research sites?`,
    ] },
  },
  // Headings that always start a new part of a proposal, whatever level Word gave them.
  breaks: [
    String.raw`วัตถุประสงค์`,
    String.raw`ระเบียบวิธี`,
    String.raw`วิธีการดำเนิน`,
    String.raw`กระบวนการและวิธีการ`,
    String.raw`รูปแบบการวิจัย`,
    String.raw`การวิเคราะห์(?:ทางสถิติ|ข้อมูล)`,
    String.raw`ข้อพิจารณาด้านจริยธรรม`,
    String.raw`จริยธรรม`,
    String.raw`แผนการดำเนิน`,
    String.raw`งบประมาณ`,
    String.raw`เอกสารอ้างอิง`,
    String.raw`บรรณานุกรม`,
    String.raw`ภาคผนวก`,
    String.raw`ผลผลิต`,
    String.raw`ผลลัพธ์`,
    String.raw`ผลกระทบ`,
    String.raw`ประวัติ`,
    String.raw`การทบทวนวรรณกรรม`,
    String.raw`ทบทวนวรรณกรรม`,
    String.raw`แนวคิด\s*ทฤษฎี`,
    String.raw`กรอบแนวคิด`,
    String.raw`กรอบการวิจัย`,
    String.raw`ส่วนที่\s*\d`,
    String.raw`objectives?`,
    String.raw`methods?`,
    String.raw`methodology`,
    String.raw`research (?:methodology|methods|design|plan)`,
    String.raw`study (?:design|procedures?)`,
    String.raw`statistical analysis`,
    String.raw`data analysis`,
    String.raw`ethic`,
    String.raw`budget`,
    String.raw`references`,
    String.raw`bibliography`,
    String.raw`appendi`,
  ],
};

export const TEMPLATES = [
  {
    id: "mfu-rs01",
    name: "แบบเสนอโครงการวิจัย มฟล. (RS-01)",
    detect: [
      String.raw`ประกอบการของบประมาณงานวิจัยของมหาวิทยาลัยแม่ฟ้าหลวง`,
      String.raw`ส่วน ก\s*:\s*สาระสำคัญของข้อเสนอโครงการวิจัย`,
      String.raw`ระบุความสอดคล้องของโครงการวิจัยกับประเด็นยุทธศาสตร์การวิจัยมหาวิทยาลัยแม่ฟ้าหลวง`,
      String.raw`ความสำคัญที่มาของปัญหาที่ทำการวิจัย`,
      String.raw`กระบวนการและวิธีการดำเนินโครงการวิจัย\s*สถานที่ทำการทดลอง`,
      String.raw`ผลงานตามระยะเวลาการรายงานความก้าวหน้างานวิจัย`,
      String.raw`ระดับการถ่ายทอดสู่สังคม`,
    ],
    min: 4,
    fields: {
      "methodology.study_design": { type: "area", heads: [String.raw`กรอบแนวความคิดการวิจัย`] },
      "meta.sites": { type: "area", heads: [String.raw`สถานที่ทำการทดลองและเก็บข้อมูล`] },
    },
    // ข้อ 14 "ผลลัพธ์ที่คาดว่าจะได้รับ" is the list of papers the grant asks for, not the
    // benefits of the research
    none: ["methodology.expected_benefits"],
  },
  {
    id: "nriis-ff",
    name: "แบบฟอร์มข้อเสนอโครงการ ววน. (NRIIS / Fundamental Fund)",
    detect: [
      String.raw`แบบฟอร์มข้อเสนอโครงการวิจัยและนวัตกรรม`,
      String.raw`งบประมาณเพื่อสนับสนุนงานมูลฐาน`,
      String.raw`ส่วนที่ 1 ข้อมูลทั่วไป`,
      String.raw`สาขา OECD`,
      String.raw`กลุ่มเป้าหมายที่นำผลงาน ววน`,
      String.raw`ระดับความพร้อมที่มีอยู่ในปัจจุบัน`,
      String.raw`ผลผลิตที่คาดว่าจะได้รับ \(Output\)`,
    ],
    min: 4,
    fields: {
      "methodology.expected_benefits": {
        type: "area", heads: [String.raw`ผลกระทบ \(Expected Impacts\)`], keepRows: true,
        skip: [String.raw`^\(?นิยามของผลกระทบ`, String.raw`^ผลที่คาดว่าจะได้รับ \| รายละเอียดผลกระทบ$`],
      },
      "meta.sites": { type: "area", heads: [String.raw`การคัดเลือกพื้นที่วิจัย`] },
    },
    // "แผนบริหารความเสี่ยงในการบูรณาการงาน" is the project's risk, not the participants'
    none: ["risks.mitigation"],
  },
];
