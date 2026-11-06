// What x-likes read in a like's images, for the detail view: the text in each image and its caption. Kept apart
// from app.js so the test suite can render it without a browser.

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * HTML for the image reading of one like (the /api/like record), image by image in the order the tweet shows
 * them, or "" when nothing was read. `mark` turns plain text into safe HTML; app.js passes its search highlighter.
 */
export function visionHtml(full, mark = esc) {
  const order = (full.media || []).map((m) => m.remote_url);
  const place = (v) => {
    const i = order.indexOf(v.remote_url);
    return i < 0 ? order.length : i;
  };
  const read = (full.vision || [])
    .filter((v) => (v.ocr_text || "").trim() || (v.caption || "").trim())
    .sort((a, b) => place(a) - place(b));
  if (!read.length) return "";
  const groups = read.map((v) => {
    const n = read.length > 1 ? `<p class="dv-n">Image ${place(v) + 1}</p>` : "";
    const ocr = (v.ocr_text || "").trim()
      ? `<dt>Text in the image</dt><dd class="dv-ocr">${mark(v.ocr_text.trim())}</dd>`
      : "";
    const caption = (v.caption || "").trim() ? `<dt>Caption</dt><dd>${mark(v.caption.trim())}</dd>` : "";
    return `${n}<dl class="dv">${ocr}${caption}</dl>`;
  });
  return `<div class="d-vision">${groups.join("")}</div>`;
}
