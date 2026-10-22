// Build an editable Word (.doc) from a filled EC form, entirely in the browser.
//
// The official forms get their look from CSS (column widths, borders, header shading,
// 16pt headings) plus CSS-generated checkboxes and dotted blanks. Word-conversion tools
// (pandoc, LibreOffice) drop most of that, but Microsoft Word itself honours inline table
// borders/widths. So we freeze the browser-COMPUTED styles onto each element as inline
// attributes, turn the CSS checkboxes/gaps into real characters, and emit Word-HTML.
// Open the .doc in Word and "Save As .docx" for a true .docx.
//
// Same engine is reused by tools/doc-export (headless Chrome) via window.ecWordHtml().

const PROPS = ["font-family", "font-size", "font-weight", "font-style", "line-height", "text-indent",
  "margin-top", "margin-bottom", "text-align", "text-decoration-line", "vertical-align",
  "background-color", "color", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-top-style", "border-top-color", "border-right-width", "border-right-style",
  "border-right-color", "border-bottom-width", "border-bottom-style", "border-bottom-color",
  "border-left-width", "border-left-style", "border-left-color", "width"];

// Returns the Word-HTML document string. Works on a CLONE so the live page is untouched.
export function wordHtml(doc) {
  const win = doc.defaultView;
  const liveSheet = doc.querySelector(".sheet");
  const clone = liveSheet.cloneNode(true);
  // live and clone trees are identical in order, so walk them in lockstep to copy the
  // computed look (clones have no layout of their own to read).
  const live = [liveSheet, ...liveSheet.querySelectorAll("*")];
  const cl = [clone, ...clone.querySelectorAll("*")];
  for (let i = 0; i < live.length; i++) {
    const el = live[i], ce = cl[i];
    if (!ce || el.tagName === "TEMPLATE") continue;
    const cs = win.getComputedStyle(el); let s = "";
    for (const p of PROPS) {
      const v = cs.getPropertyValue(p); if (!v) continue;
      if (p === "background-color" && (v === "rgba(0, 0, 0, 0)" || v === "transparent")) continue;
      if (p.startsWith("border") && p.endsWith("width") && v === "0px") continue;
      if (p === "width" && !["TD", "TH", "TABLE", "COL"].includes(el.tagName)) continue;
      s += `${p}:${v};`;
    }
    if (el.tagName === "TABLE") s += "border-collapse:collapse;";
    if (el.tagName === "TD" || el.tagName === "TH") ce.setAttribute("valign", "top");
    if (s) ce.setAttribute("style", (ce.getAttribute("style") || "") + s);
  }
  // CSS-generated content -> real characters
  clone.querySelectorAll(".cb").forEach((c) => { c.textContent = c.classList.contains("on") ? "[ / ]" : "[   ]"; });
  clone.querySelectorAll(".gap").forEach((g) => { if (!g.textContent.trim()) g.textContent = ".".repeat(36); g.style.removeProperty("background-color"); });
  clone.querySelectorAll(".unknown").forEach((u) => u.style.removeProperty("background-color"));
  clone.querySelectorAll(".hint").forEach((h) => h.remove());               // blue EC guidance, not printed
  clone.querySelectorAll("[contenteditable]").forEach((e) => e.removeAttribute("contenteditable"));
  clone.querySelectorAll("[data-goto]").forEach((e) => { e.removeAttribute("data-goto"); e.removeAttribute("title"); });
  // legacy table attrs Word + LibreOffice both honour
  clone.querySelectorAll("table").forEach((t) => {
    t.setAttribute("border", "1"); t.setAttribute("cellspacing", "0"); t.setAttribute("cellpadding", "2");
  });
  // pictures: Word sizes them by the width/height attributes, so give it the size on screen
  const liveImgs = [...liveSheet.querySelectorAll("img")];
  clone.querySelectorAll("img").forEach((im, i) => {
    const r = liveImgs[i]?.getBoundingClientRect();
    if (r?.width) { im.setAttribute("width", String(Math.round(r.width))); im.setAttribute("height", String(Math.round(r.height))); }
  });
  // a <p> may not hold a table or a picture block in Word: make those paragraphs <div>s
  clone.querySelectorAll("p").forEach((p) => {
    if (!p.querySelector("table, .fig")) return;
    const d = doc.createElement("div");
    for (const a of p.attributes) d.setAttribute(a.name, a.value);
    d.innerHTML = p.innerHTML;
    p.replaceWith(d);
  });
  // Word maps <h1>..<h6> to its big built-in Heading styles; swap to <div> so the form's
  // own (already-frozen inline) sizes stand instead.
  clone.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
    const d = doc.createElement("div");
    for (const a of h.attributes) d.setAttribute(a.name, a.value);
    d.innerHTML = h.innerHTML;
    h.replaceWith(d);
  });
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">`
    + `<head><meta charset="utf-8"><style>`
    + `@page{size:21cm 29.7cm;margin:2cm 1.5cm 1.8cm 2cm;}`
    + `body{font-family:"TH Sarabun New","Sarabun",sans-serif;font-size:16pt;}`
    + `table{border-collapse:collapse;}</style></head><body>${clone.outerHTML}</body></html>`;
}

// Word does not show <img src="data:...">. When the form has pictures, the .doc is an
// MHTML "single file web page" instead: the HTML plus each picture as its own MIME part,
// which Word opens with the pictures in place.
const B64 = (s) => {
  const u8 = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
};
const wrap76 = (s) => s.replace(/.{1,76}/g, "$&\r\n");

export function wordDoc(doc) {
  let html = wordHtml(doc);
  const pics = [];
  html = html.replace(/src="data:(image\/[\w.+-]+);base64,([^"]+)"/g, (_, mime, data) => {
    const name = `image${String(pics.length + 1).padStart(3, "0")}.${mime.split("/")[1].replace("jpeg", "jpg").replace("svg+xml", "svg")}`;
    pics.push({ name, mime, data });
    return `src="ec_files/${name}"`;
  });
  if (!pics.length) return html;
  const bound = "----=_NextPart_ECMFU";
  const base = "file:///C:/ec/form.htm";
  let out = `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${bound}"; type="text/html"\r\n\r\n`;
  out += `--${bound}\r\nContent-Location: ${base}\r\nContent-Transfer-Encoding: base64\r\nContent-Type: text/html; charset="utf-8"\r\n\r\n${wrap76(B64(html))}\r\n`;
  for (const p of pics) {
    out += `--${bound}\r\nContent-Location: file:///C:/ec/ec_files/${p.name}\r\nContent-Transfer-Encoding: base64\r\nContent-Type: ${p.mime}\r\n\r\n${wrap76(p.data)}\r\n`;
  }
  return `${out}--${bound}--\r\n`;
}

// Build the .doc and hand it to the browser as a download.
export function downloadDoc(doc, code) {
  const html = wordDoc(doc);
  const blob = new Blob(html.startsWith("MIME-Version") ? [html] : ["﻿", html], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url; a.download = `${code || "form"}.doc`;
  doc.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
