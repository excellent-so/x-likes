// x-likes: the web client. Vanilla JS, no build step. The look is @excellent-so/kit (web/kit/); kit.js runs the
// theme toggle and the copy button.

const $ = (id) => document.getElementById(id);
const grid = $("grid");
const statusEl = $("status");
const emptyEl = $("empty");
const chipsEl = $("chips");

const PAGE = 40;

const state = {
  q: "",
  type: "all", // all | image | link
  sort: "newest", // default: the tweet's own date, newest first (year→month→day)
  author: "",
  authorName: "",
  tag: "",
  tagLabel: "",
  offset: 0,
  total: 0,
  mode: "",
  loading: false,
  done: false,
  items: [], // loaded ResultTweet[] in display order
  cols: [], // column elements
  colCount: 0,
};

// ───────────────────────── helpers ─────────────────────────

const esc = (s) =>
  (s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const mediaUrl = (p) => (p ? "/media/" + p.split("/").map(encodeURIComponent).join("/") : "");
const mediaSrc = (m) => (m.local_path ? mediaUrl(m.local_path) : m.remote_url);
// Grid + related thumbnails use the downscaled webp endpoint; full-res /media is
// reserved for the lightbox. Falls back to the original for remote-only media.
const thumbSrc = (m) => (m.local_path ? "/thumb/" + m.local_path.split("/").map(encodeURIComponent).join("/") : m.remote_url);

// The offline enrichment sometimes tags URL fragments (https, t.co, …). Hide the
// obvious noise so the tag surfaces stay clean.
const TAG_STOP = new Set(["https", "http", "t.co", "tco", "www", "com", "html", "amp", "via", "href", "twitter"]);
const isJunkTag = (t) => {
  const s = (t.slug || "").toLowerCase();
  const l = (t.label || "").toLowerCase();
  return TAG_STOP.has(s) || TAG_STOP.has(l) || l.includes(".") || l.includes("/");
};
const cleanTags = (arr) => (arr || []).filter((t) => !isJunkTag(t));

function domain(url) {
  if (!url) return "";
  return String(url)
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// linkify + highlight query terms, safely
function renderText(text) {
  if (!text) return "";
  let html = esc(text);
  html = html.replace(/https?:\/\/[^\s]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${esc(domain(u))}</a>`);
  html = html.replace(/(^|\s)@(\w{1,15})/g, (_, sp, h) => `${sp}<a href="https://x.com/${h}" target="_blank" rel="noopener">@${h}</a>`);
  html = html.replace(/(^|\s)#(\w+)/g, (_, sp, h) => `${sp}<a href="https://x.com/hashtag/${h}" target="_blank" rel="noopener">#${h}</a>`);
  const terms = state.q.trim().split(/\s+/).filter(Boolean);
  for (const t of terms) {
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    html = html.replace(/(>[^<]*|^[^<]*)/g, (seg) => seg.replace(re, "<mark>$1</mark>"));
  }
  return html;
}

// plain text with query highlight (no linkify), for snippets
function highlight(text) {
  let html = esc(text);
  const terms = state.q.trim().split(/\s+/).filter(Boolean);
  for (const t of terms) {
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    html = html.replace(re, "<mark>$1</mark>");
  }
  return html;
}

// ───────────────────────── masonry ─────────────────────────

function columnCount() {
  const w = grid.clientWidth || window.innerWidth;
  return Math.max(1, Math.min(6, Math.round(w / 300)));
}

const GAP = 16; // keep in step with --xl-gap in styles.css

function buildColumns(n) {
  grid.innerHTML = "";
  state.cols = [];
  for (let i = 0; i < n; i++) {
    const c = document.createElement("div");
    c.className = "col";
    grid.appendChild(c);
    state.cols.push(c);
  }
  state.colCount = n;
  state.colH = new Array(n).fill(0); // running *estimated* column heights
  state.colWidth = Math.max(120, (grid.clientWidth - GAP * (n - 1)) / n);
  state.eagerCount = n * 3; // first ~3 rows load eagerly, the rest lazily
}

// Index of the currently shortest column, by our running estimate. Crucially we
// never read offsetHeight — that would force a synchronous layout per card (the
// old jank) and defeat lazy image loading.
function shortestColIndex() {
  let best = 0;
  for (let i = 1; i < state.colH.length; i++) if (state.colH[i] < state.colH[best]) best = i;
  return best;
}

// Estimate a card's rendered height from data alone (image aspect ratio, text
// length) so placement is balanced without touching the DOM.
function estCardHeight(t) {
  const w = state.colWidth || 300;
  // card body: 16px padding top and bottom, 12px between rows, a 20px meta row
  const meta = 32 + 20;
  if (t.media && t.media.length) {
    const m = t.media[0];
    const ar = m.w && m.h ? m.h / m.w : 1.05;
    return Math.round(w * ar) + 1 + meta + (t.text ? 12 + 40 : 0);
  }
  const perLine = Math.max(12, w / 8);
  const len = (t.text || "").length || 24;
  if (t.links && t.links.length) {
    const lines = Math.min(6, Math.max(1, Math.ceil(len / perLine)));
    return meta + 16 + 12 + lines * 22 + 12;
  }
  const lines = Math.min(12, Math.max(1, Math.ceil(len / perLine)));
  return meta + lines * 22 + 12;
}

function placeCard(item, idx) {
  const el = card(item, idx, idx < (state.eagerCount || 0));
  const est = estCardHeight(item);
  el.style.setProperty("--h", est + "px"); // content-visibility placeholder size
  const ci = shortestColIndex();
  state.cols[ci].appendChild(el);
  state.colH[ci] += est + GAP;
}

function relayout() {
  const n = columnCount();
  if (n === state.colCount && state.cols.length) return;
  buildColumns(n);
  state.items.forEach((it, i) => placeCard(it, i));
}

// ───────────────────────── card rendering ─────────────────────────

// Hover-to-preview on a video card: after a short hover, load a muted looping
// clip over the poster and fade it in once it has a frame; tear it down (and
// abort the load) on mouse-out. The delay means a quick pass-over the grid
// doesn't kick off a video load for every card it crosses.
function attachHoverPreview(el, vsrc) {
  const host = el.querySelector(".card-media") || el;
  let timer = null;
  let vid = null;
  const stop = () => {
    clearTimeout(timer);
    timer = null;
    el.classList.remove("previewing");
    if (vid) {
      vid.pause();
      vid.removeAttribute("src"); // abort any in-flight download
      vid.load();
      vid.remove();
      vid = null;
    }
  };
  el.addEventListener("mouseenter", () => {
    if (vid) return;
    timer = setTimeout(() => {
      vid = document.createElement("video");
      vid.className = "hover-vid";
      vid.muted = true;
      vid.loop = true;
      vid.playsInline = true;
      vid.preload = "auto";
      vid.src = vsrc;
      vid.addEventListener(
        "loadeddata",
        () => {
          if (!vid) return;
          vid.classList.add("on");
          el.classList.add("previewing");
        },
        { once: true }
      );
      host.appendChild(vid);
      vid.play().catch(() => {});
    }, 180);
  });
  el.addEventListener("mouseleave", stop);
}

function card(t, idx, eager) {
  const el = document.createElement("article");
  el.className = "card";
  el.dataset.idx = idx;
  el.tabIndex = 0; // Enter or Space opens it (see the grid keydown handler)

  const hasImg = t.media && t.media.length;
  const hasLink = t.links && t.links.length;
  const avatar = t.author_avatar ? mediaUrl(t.author_avatar) : "";

  if (hasImg) {
    el.classList.add("img-card");
    const first = t.media[0];
    const src = thumbSrc(first);
    const isVideo = first.kind !== "photo" || first.video_url;
    const extra = t.media.length > 1 ? `<span class="ex-badge count-badge">1 / ${t.media.length}</span>` : "";
    const play = isVideo ? `<span class="play-glyph"><span class="ex-sr-only">Video</span></span>` : "";
    // Two lines of the tweet under the image (with the matches marked while searching).
    const snip = t.text ? `<div class="snip">${highlight(t.text)}</div>` : "";
    // Reserve the exact aspect box before load → zero reflow. 1/1 fallback for
    // the rare image whose dimensions we couldn't read (object-fit:cover crops it
    // rather than distorting).
    const ratio = first.w && first.h ? `${first.w}/${first.h}` : "1/1";
    const loadAttr = eager ? `loading="eager" fetchpriority="high"` : `loading="lazy"`;
    el.innerHTML =
      `<div class="card-media"><img class="hero" src="${src}" style="aspect-ratio:${ratio}" ${loadAttr} decoding="async" alt="${esc(first.alt || "")}">${play}${extra}</div>` +
      `<div class="card-body">${snip}${metaRow(t, avatar)}</div>`;
    if (isVideo && first.video_url) {
      el.classList.add("has-video");
      attachHoverPreview(el, `/video?u=${encodeURIComponent(first.video_url)}`);
    }
  } else if (hasLink) {
    el.classList.add("link-card");
    const d = domain(t.links[0].display_url || t.links[0].url);
    const body = t.text ? `<div class="body">${renderText(t.text)}</div>` : `<div class="body">${esc(t.links[0].display_url || t.links[0].url)}</div>`;
    el.innerHTML = `<div class="card-body"><div class="lk">${esc(d)}</div>${body}${metaRow(t, avatar)}</div>`;
  } else {
    el.classList.add("text-card");
    if (t.hydration === "gone") el.classList.add("gone");
    const body = t.text ? renderText(t.text) : t.hydration === "gone" ? "This tweet is no longer available." : "Not yet fetched.";
    el.innerHTML = `<div class="card-body"><div class="body">${body}</div>${metaRow(t, avatar)}</div>`;
  }
  return el;
}

function metaRow(t, avatar) {
  const gone = t.hydration === "gone";
  if (!t.author_handle && !t.created_at && !gone) return "";
  const who = t.author_handle
    ? `${avatar ? `<img class="av" src="${avatar}" loading="lazy" alt="">` : ""}<span class="h">@${esc(t.author_handle)}</span>`
    : `<span class="h">From your archive</span>`;
  const date = t.created_at ? `<span aria-hidden="true">·</span><time datetime="${esc(t.created_at)}">${fmtDate(t.created_at)}</time>` : "";
  const badge = gone
    ? `<span class="ex-badge ex-badge--neutral">Deleted</span>`
    : t.article_count
      ? `<span class="ex-badge ex-badge--neutral">Article</span>`
      : "";
  return `<div class="card-meta">${who}${date}${badge}</div>`;
}

// ───────────────────────── loading ─────────────────────────

function buildQuery() {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.author) p.set("author", state.author);
  if (state.tag) p.set("tag", state.tag);
  if (state.type === "image") p.set("hasImage", "1");
  if (state.type === "link") p.set("hasLink", "1");
  p.set("sort", state.sort);
  p.set("limit", String(PAGE));
  p.set("offset", String(state.offset));
  return p.toString();
}

function showSkeletons() {
  const n = columnCount();
  buildColumns(n);
  const heights = [230, 300, 180, 340, 260, 210, 290, 320];
  for (let i = 0; i < n * 3; i++) {
    const sk = document.createElement("div");
    sk.className = "sk ex-skeleton";
    sk.style.height = heights[i % heights.length] + "px";
    state.cols[i % n].appendChild(sk);
  }
}

async function load(reset) {
  if (state.loading) return;
  if (reset) {
    state.offset = 0;
    state.done = false;
    state.items = [];
    emptyEl.hidden = true;
    showSkeletons();
  }
  if (state.done) return;
  state.loading = true;
  if (!reset) statusEl.textContent = "Loading more…";

  try {
    const res = await fetch(`/api/search?${buildQuery()}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (reset) {
      buildColumns(columnCount()); // clears skeletons
    }
    state.total = data.total;
    state.mode = data.mode || "";
    const startIdx = state.items.length;
    data.results.forEach((t, i) => {
      state.items.push(t);
      placeCard(t, startIdx + i);
    });
    state.offset += data.results.length;
    state.done = state.offset >= data.total || data.results.length === 0;

    renderStatus();
    if (state.total === 0) showEmpty();
  } catch (e) {
    if (reset) buildColumns(columnCount()); // drop the skeletons
    statusEl.innerHTML = `<div class="ex-alert ex-alert--danger" role="alert"><span class="ex-glyph ex-glyph--cross" aria-hidden="true"></span><p class="ex-alert__title">Search failed</p><p class="ex-alert__desc">${esc(e.message)}</p></div>`;
  } finally {
    state.loading = false;
  }
}

function renderStatus() {
  if (!state.total) {
    statusEl.textContent = "";
    return;
  }
  const modeTag =
    state.mode === "hybrid" || state.mode === "semantic"
      ? ` <span class="sem">· found by meaning</span>`
      : "";
  const n = state.total.toLocaleString();
  const noun = state.q || state.author || state.tag || state.type !== "all" ? "matches" : "likes";
  statusEl.innerHTML = state.done
    ? `${n} ${noun}${modeTag}`
    : `${state.offset.toLocaleString()} of ${n}${modeTag}`;
}

function showEmpty() {
  grid.innerHTML = "";
  emptyEl.hidden = false;
  if (!state.q && !activeFilterCount()) {
    // An empty store: say how to fill it.
    emptyEl.innerHTML = `<div class="ex-empty ex-empty--page">
      <h1 class="ex-empty__title">No likes yet</h1>
      <p class="ex-empty__text">Import your X archive with <code class="ex-code">pnpm ingest &lt;archive.zip&gt;</code>, then run <code class="ex-code">pnpm hydrate</code> and <code class="ex-code">pnpm enrich</code>. The README has a demo you can try first.</p>
    </div>`;
    return;
  }
  // Newest, Oldest and Recently liked match words; only Best match searches by meaning.
  const byMeaning = state.q && state.sort !== "relevance";
  emptyEl.innerHTML = `<div class="ex-empty">
    <p class="ex-empty__title">Nothing matches</p>
    <p class="ex-empty__text">${byMeaning ? "No like contains all of those words. Best match searches by meaning instead." : "Try a different search, or clear your filters."}</p>
    <div class="ex-empty__actions">${byMeaning ? `<button type="button" class="ex-btn" data-meaning>Search by meaning</button>` : ""}<button type="button" class="ex-btn ex-btn--outline" data-reset>Clear search and filters</button></div>
  </div>`;
}

emptyEl.addEventListener("click", (e) => {
  if (e.target.closest("[data-meaning]")) {
    state.sort = "relevance";
    apply();
    return;
  }
  if (!e.target.closest("[data-reset]")) return;
  qInput.value = "";
  state.q = "";
  clearQ.hidden = true;
  if (state.sort === "relevance") state.sort = "newest";
  resetFilters();
  apply();
});

// ───────────────────────── active filter chips ─────────────────────────

function renderChips() {
  const chips = [];
  if (state.type === "image") chips.push(chipHtml("type", "Images", "Show"));
  if (state.type === "link") chips.push(chipHtml("type", "Links", "Show"));
  if (state.author) chips.push(chipHtml("author", `@${state.author}`, "Person"));
  if (state.tag) chips.push(chipHtml("tag", state.tagLabel || state.tag, "Tag"));
  if (chips.length) {
    chipsEl.hidden = false;
    chipsEl.innerHTML = chips.join("");
  } else {
    chipsEl.hidden = true;
    chipsEl.innerHTML = "";
  }
  updateFilterBadge();
}

function chipHtml(kind, label, k) {
  return `<button type="button" class="ex-btn ex-btn--outline ex-btn--sm chip" data-clear="${kind}" aria-label="Remove filter: ${esc(k)} ${esc(label)}"><span class="k">${esc(k)}</span>${esc(label)}<span class="ex-glyph ex-glyph--cross" aria-hidden="true"></span></button>`;
}

function activeFilterCount() {
  return (state.type !== "all" ? 1 : 0) + (state.author ? 1 : 0) + (state.tag ? 1 : 0);
}

function updateFilterBadge() {
  const n = activeFilterCount();
  const badge = $("filterCount");
  badge.hidden = n === 0;
  badge.textContent = n;
  $("clearAll").disabled = n === 0;
  syncPanel();
}

// ───────────────────────── filter popover ─────────────────────────

const panel = $("filterPanel");
const filterBtn = $("filterBtn");

function openPanel() {
  panel.hidden = false;
  filterBtn.classList.add("active");
  filterBtn.setAttribute("aria-expanded", "true");
}
function closePanel() {
  panel.hidden = true;
  filterBtn.classList.remove("active");
  filterBtn.setAttribute("aria-expanded", "false");
}
filterBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  panel.hidden ? openPanel() : closePanel();
});
document.addEventListener("click", (e) => {
  if (!panel.hidden && !panel.contains(e.target) && e.target !== filterBtn) closePanel();
});

// Pressed state lives in aria-pressed (styles.css draws it as an ink fill with a check).
const press = (b, on) => b.setAttribute("aria-pressed", String(on));

function syncPanel() {
  $("typeSeg")
    .querySelectorAll("button")
    .forEach((b) => press(b, b.dataset.type === state.type));
  $("sortSeg")
    .querySelectorAll("button")
    .forEach((b) => press(b, b.dataset.sort === state.sort));
  document.querySelectorAll("#peopleList .person").forEach((b) => press(b, b.dataset.author === state.author));
  document.querySelectorAll("#tagCloud button").forEach((b) => press(b, b.dataset.tag === state.tag));
  syncSortAvail();
}

// "Best match" (relevance) only has meaning when there's a query to score
// against — disable it otherwise so the default sort stays newest-first.
function syncSortAvail() {
  const rel = $("sortSeg").querySelector('button[data-sort="relevance"]');
  if (rel) rel.disabled = !state.q;
}

$("typeSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.type = b.dataset.type;
  apply();
});
$("sortSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  state.sort = b.dataset.sort;
  apply();
});
$("peopleList").addEventListener("click", (e) => {
  const b = e.target.closest(".person");
  if (!b) return;
  const on = state.author === b.dataset.author;
  state.author = on ? "" : b.dataset.author;
  state.authorName = on ? "" : b.dataset.name || "";
  apply();
});
$("tagCloud").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const on = state.tag === b.dataset.tag;
  state.tag = on ? "" : b.dataset.tag;
  state.tagLabel = on ? "" : b.textContent;
  apply();
});
function resetFilters() {
  state.type = "all";
  state.author = "";
  state.authorName = "";
  state.tag = "";
  state.tagLabel = "";
}
$("clearAll").addEventListener("click", () => {
  resetFilters();
  apply();
});

// central "filters changed" entry point
function apply() {
  renderChips();
  load(true);
}

// ───────────────────────── search box ─────────────────────────

const qInput = $("q");
const clearQ = $("clearQ");

qInput.addEventListener(
  "input",
  debounce((e) => {
    state.q = e.target.value.trim();
    clearQ.hidden = !state.q;
    // The default stays "Newest" (by tweet date) even while searching — you opt
    // into "Best match" (relevance) explicitly. Relevance only means anything
    // against a query, so fall back to the default order once the box empties.
    if (!state.q && state.sort === "relevance") state.sort = "newest";
    syncSortAvail();
    load(true);
  }, 200)
);
clearQ.addEventListener("click", () => {
  qInput.value = "";
  state.q = "";
  clearQ.hidden = true;
  state.sort = "newest";
  syncSortAvail();
  qInput.focus();
  load(true);
});

// ───────────────────────── chips click (remove) ─────────────────────────

chipsEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const kind = chip.dataset.clear;
  if (kind === "type") state.type = "all";
  if (kind === "author") {
    state.author = "";
    state.authorName = "";
  }
  if (kind === "tag") {
    state.tag = "";
    state.tagLabel = "";
  }
  apply();
});

// ───────────────────────── grid clicks → open detail ─────────────────────────

grid.addEventListener("click", (e) => {
  const el = e.target.closest(".card");
  if (!el || e.target.closest("a")) return; // a link inside the text opens the link, not the card
  const idx = Number(el.dataset.idx);
  openDetail(state.items[idx], idx);
});
grid.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const el = e.target.closest(".card");
  if (!el || e.target !== el) return;
  e.preventDefault();
  const idx = Number(el.dataset.idx);
  openDetail(state.items[idx], idx);
});

// ───────────────────────── detail lightbox ─────────────────────────

const detail = $("detail");
const dPanel = $("dPanel");
const dMedia = $("dMedia");
const dInfo = $("dInfo");
let detailIdx = -1;
let returnFocus = null; // what had focus before the detail view opened

// ── deep-link / history ───────────────────────────────────────────────
// Each item has a stable identifier — its tweet id. An open item is mirrored
// into the URL as ?id=<tweet_id>, so any card is a copy-pasteable link you can
// reopen (or hand to the MCP tools, which key on the same id), and browser
// back/forward walk in and out of items.
const withId = (id) => location.pathname + "?id=" + encodeURIComponent(id);
const urlId = () => new URLSearchParams(location.search).get("id");
function setUrl(id, push) {
  const url = id ? withId(id) : location.pathname;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

// Open a like by id — reuse the loaded copy (keeps prev/next) or fetch it standalone.
function openLikeById(id, fromHistory) {
  const i = state.items.findIndex((x) => x.tweet_id === id);
  if (i >= 0) return openDetail(state.items[i], i, fromHistory);
  fetch(`/api/like?id=${encodeURIComponent(id)}`)
    .then((r) => r.json())
    .then((full) => {
      if (full && full.tweet_id) openDetail(full, -1, fromHistory);
    })
    .catch(() => {});
}

function openDetail(item, idx, fromHistory) {
  if (!item) return;
  detailIdx = typeof idx === "number" ? idx : -1;
  if (detail.hidden) returnFocus = document.activeElement;
  renderDetail(item);
  detail.hidden = false;
  $("dClose").focus();
  document.body.style.overflow = "hidden";
  updateNav();
  // Reflect the item in the URL. Opening fresh from the grid pushes a new entry
  // (so Back closes it); jumping between items (already on an ?id) replaces, so
  // browsing never spams history. History-driven opens don't touch the URL.
  if (!fromHistory) setUrl(item.tweet_id, !urlId());
  // enrich (articles / vision / all tags / related) without blocking the open
  fetchEnrichment(item.tweet_id);
}

function closeDetail(fromHistory) {
  detail.hidden = true;
  document.body.style.overflow = "";
  detailIdx = -1;
  if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
  returnFocus = null;
  if (!fromHistory && urlId()) setUrl(null, false);
}

// Browser back/forward → reconcile the lightbox to whatever the URL says.
window.addEventListener("popstate", () => {
  const id = urlId();
  if (!id) return void (detail.hidden || closeDetail(true));
  if (!detail.hidden && detailIdx >= 0 && state.items[detailIdx]?.tweet_id === id) return;
  openLikeById(id, true);
});

function updateNav() {
  const has = detailIdx >= 0;
  $("dPrev").disabled = !has || detailIdx <= 0;
  $("dNext").disabled = !has || detailIdx >= state.items.length - 1;
}

async function step(dir) {
  if (detailIdx < 0) return;
  let next = detailIdx + dir;
  // pull more pages if we run off the end
  if (next >= state.items.length && !state.done) {
    await load(false);
  }
  if (next < 0 || next >= state.items.length) return;
  detailIdx = next;
  const item = state.items[detailIdx];
  renderDetail(item);
  updateNav();
  setUrl(item.tweet_id, false); // replace — stepping shouldn't stack history
  fetchEnrichment(item.tweet_id);
}

function renderDetail(t) {
  const hasMedia = t.media && t.media.length;
  dPanel.classList.toggle("no-media", !hasMedia);

  // media column
  if (hasMedia) {
    dMedia.innerHTML = t.media
      .map((m) => {
        const src = mediaSrc(m); // full-res image, or the local poster frame for a video
        const dim = m.w && m.h ? `width="${m.w}" height="${m.h}"` : "";
        if (m.video_url) {
          // Real inline player instead of a link-out. animated_gif → silent
          // looping autoplay (gif behaviour); real video → click-to-play with
          // controls. The poster is the frame we downloaded locally; the mp4
          // streams from source (twimg serves it CORS-open with Range/seek).
          const isGif = m.kind === "animated_gif";
          const attrs = isGif
            ? `autoplay loop muted playsinline preload="auto"`
            : `controls playsinline preload="auto"`;
          const poster = m.local_path ? ` poster="${src}"` : "";
          // Served through the local proxy (/video) — same-origin, cached to disk.
          const vsrc = `/video?u=${encodeURIComponent(m.video_url)}`;
          return `<video class="vid" ${attrs}${poster} ${dim}><source src="${vsrc}" type="video/mp4"></video>`;
        }
        return `<img src="${src}" ${dim} data-full="${src}" alt="${esc(m.alt || "")}">`;
      })
      .join("");
  } else {
    dMedia.innerHTML = "";
  }

  // Autoplay the opened clip. Opening is a deliberate click, so try with sound;
  // if the browser's autoplay policy blocks that, fall back to muted playback.
  const dv = dMedia.querySelector("video[controls]");
  if (dv) dv.play().catch(() => {
    dv.muted = true;
    dv.play().catch(() => {});
  });

  // info column
  const avatar = t.author_avatar ? mediaUrl(t.author_avatar) : "";
  const when = t.created_at ? `<time class="dt" datetime="${esc(t.created_at)}">${fmtDate(t.created_at)}</time>` : "";
  const initial = esc(((t.author_name || t.author_handle || "?")[0] || "?").toUpperCase());
  const author = t.author_handle
    ? `<div class="d-author">
         ${avatar ? `<img class="av" src="${avatar}" alt="">` : `<span class="av mono" aria-hidden="true">${initial}</span>`}
         <div class="nm"><span class="n">${esc(t.author_name || t.author_handle)}</span>
         <button type="button" class="hd" data-author="${esc(t.author_handle)}" data-name="${esc(t.author_name || "")}" title="Show only likes from @${esc(t.author_handle)}">@${esc(t.author_handle)}</button></div>
         ${when}
       </div>`
    : `<div class="d-author"><span class="av mono" aria-hidden="true"></span><div class="nm"><span class="n">${t.hydration === "gone" ? "Unavailable" : "From your archive"}</span></div>${when}</div>`;

  const text = t.text
    ? `<div class="d-text ${t.hydration === "gone" ? "gone" : ""}">${renderText(t.text)}</div>`
    : "";

  const links =
    t.links && t.links.length
      ? `<div class="d-links">${t.links
          .map(
            (l) =>
              `<a class="d-linkrow" href="${esc(l.url)}" target="_blank" rel="noopener"><span class="u">${esc(l.display_url || l.url)}</span><span class="ex-glyph ex-glyph--arrow" aria-hidden="true"></span></a>`
          )
          .join("")}</div>`
      : "";

  const openUrl = t.url || (t.author_handle ? `https://x.com/${t.author_handle}/status/${t.tweet_id}` : t.expanded_url);
  const foot = `<div class="d-foot">
      ${openUrl ? `<a class="ex-link ex-link--arrow" href="${esc(openUrl)}" target="_blank" rel="noopener">Open on X</a>` : ""}
      ${t.favorite_count != null ? `<span>${t.favorite_count.toLocaleString()} ${t.favorite_count === 1 ? "like" : "likes"}</span>` : ""}
      ${t.hydration === "gone" ? `<span class="ex-badge ex-badge--neutral">Deleted</span>` : ""}
      <button type="button" class="ex-btn ex-btn--outline ex-btn--xs d-id" data-ex-copy="${esc(t.tweet_id)}" title="Copy this like's id (the MCP tools use the same id)">#${esc(t.tweet_id)}</button>
    </div>`;

  dInfo.innerHTML =
    author +
    text +
    links +
    `<div class="d-enrich"></div>` + // filled by fetchEnrichment (article + tags)
    foot +
    `<div class="d-related" hidden></div>`;

  dInfo.scrollTop = 0;
  dMedia.scrollTop = 0;
}

async function fetchEnrichment(id) {
  const enrichSlot = dInfo.querySelector(".d-enrich");
  const relSlot = dInfo.querySelector(".d-related");
  try {
    const full = await fetch(`/api/like?id=${encodeURIComponent(id)}`).then((r) => r.json());
    // guard: user may have navigated away
    if (detail.hidden) return;
    let html = "";
    const art = full.articles && full.articles[0];
    if (art && (art.title || art.excerpt)) {
      html += `<div class="d-article">
        ${art.title ? `<p class="at">${esc(art.title)}</p>` : ""}
        ${art.excerpt ? `<p class="ax">${esc(art.excerpt)}</p>` : ""}
        <p class="asrc">${esc(art.site_name || domain(art.final_url || art.url))}${art.word_count ? ` · ${art.word_count.toLocaleString()} words` : ""}</p>
      </div>`;
    }
    const tags = cleanTags(full.tags);
    if (tags.length) {
      html += `<div class="d-tags">${tags
        .map((tg) => `<button type="button" class="ex-btn ex-btn--outline ex-btn--xs d-tag" data-tag="${esc(tg.slug)}" data-label="${esc(tg.label)}" title="Show only likes tagged ${esc(tg.label)}">${esc(tg.label)}</button>`)
        .join("")}</div>`;
    }
    enrichSlot.innerHTML = html;
  } catch {
    /* ignore */
  }

  try {
    const rel = await fetch(`/api/related?id=${encodeURIComponent(id)}`).then((r) => r.json());
    if (detail.hidden || !rel.results || !rel.results.length) return;
    relSlot.hidden = false;
    relSlot.innerHTML =
      `<h2 class="rl">Related</h2><div class="rrow">` +
      rel.results
        .slice(0, 8)
        .map((r) => {
          const img = r.media && r.media[0] ? thumbSrc(r.media[0]) : "";
          const label = esc((r.text || "").slice(0, 80));
          if (img) return `<button type="button" class="rthumb" data-id="${esc(r.tweet_id)}" aria-label="${label}"><img src="${img}" loading="lazy" alt=""></button>`;
          return `<button type="button" class="rthumb" data-id="${esc(r.tweet_id)}"><span class="rt">${label}</span></button>`;
        })
        .join("") +
      `</div>`;
  } catch {
    /* ignore */
  }
}

// detail interactions
detail.addEventListener("click", (e) => {
  if (e.target === detail) return closeDetail();

  // The id button ([data-ex-copy]) is copied by kit.js.
  const zoomImg = e.target.closest(".d-media img[data-full]");
  if (zoomImg) {
    $("zoomImg").src = zoomImg.dataset.full;
    $("zoom").hidden = false;
    return;
  }
  const authorLink = e.target.closest("[data-author]");
  if (authorLink) {
    state.author = authorLink.dataset.author;
    state.authorName = authorLink.dataset.name || "";
    closeDetail();
    apply();
    return;
  }
  const tagBtn = e.target.closest(".d-tag");
  if (tagBtn) {
    state.tag = tagBtn.dataset.tag;
    state.tagLabel = tagBtn.dataset.label;
    closeDetail();
    apply();
    return;
  }
  const rthumb = e.target.closest(".rthumb");
  if (rthumb) {
    openLikeById(rthumb.dataset.id);
    return;
  }
});

$("dClose").addEventListener("click", closeDetail);
$("dPrev").addEventListener("click", () => step(-1));
$("dNext").addEventListener("click", () => step(1));

// zoom layer
$("zoom").addEventListener("click", () => ($("zoom").hidden = true));

// ───────────────────────── keyboard ─────────────────────────

document.addEventListener("keydown", (e) => {
  if (!$("zoom").hidden) {
    if (e.key === "Escape") $("zoom").hidden = true;
    return;
  }
  if (!detail.hidden) {
    if (e.key === "Escape") closeDetail();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    return;
  }
  if (!panel.hidden && e.key === "Escape") return closePanel();
  if (e.key === "/" && document.activeElement !== qInput) {
    e.preventDefault();
    qInput.focus();
    qInput.select();
  }
  if (e.key === "Escape" && document.activeElement === qInput && qInput.value) {
    clearQ.click();
  }
});

// ───────────────────────── infinite scroll + resize ─────────────────────────

new IntersectionObserver(
  (entries) => {
    if (entries[0].isIntersecting && !state.loading && !state.done && state.items.length) load(false);
  },
  { rootMargin: "800px" }
).observe($("sentinel"));

window.addEventListener("resize", debounce(relayout, 160));

// ───────────────────────── bootstrap: facets ─────────────────────────

async function loadFacets() {
  try {
    const s = await fetch("/api/stats").then((r) => r.json());
    $("cntImg").textContent = s.withImages ? s.withImages.toLocaleString() : "";
    $("cntLink").textContent = s.withLinks ? s.withLinks.toLocaleString() : "";
    qInput.placeholder = s.likes
      ? `Search ${s.likes.toLocaleString()} things you've saved`
      : "Search everything you've saved";
    if (s.topAuthors && s.topAuthors.length) {
      $("peopleList").innerHTML = s.topAuthors
        .slice(0, 12)
        .map(
          (a) =>
            `<button type="button" class="person" data-author="${esc(a.handle)}" data-name="${esc(a.name || "")}" aria-pressed="${a.handle === state.author}">
               <span class="av mono" aria-hidden="true">${esc((a.handle[0] || "?").toUpperCase())}</span>
               <span class="h">@${esc(a.handle)}</span>
               <span class="ex-glyph" aria-hidden="true"></span>
               <span class="c">${a.count.toLocaleString()}</span>
             </button>`
        )
        .join("");
    } else {
      $("peopleSec").hidden = true;
    }
  } catch {
    /* ignore */
  }

  try {
    const { tags } = await fetch("/api/tags").then((r) => r.json());
    const clean = cleanTags(tags);
    if (clean.length) {
      $("tagSec").hidden = false;
      $("tagCloud").innerHTML = clean
        .slice(0, 40)
        .map((t) => `<button type="button" class="ex-btn ex-btn--outline ex-btn--xs xl-toggle" data-tag="${esc(t.slug)}" aria-pressed="${t.slug === state.tag}">${esc(t.label)}</button>`)
        .join("");
    }
  } catch {
    /* ignore */
  }
}

// ───────────────────────── go ─────────────────────────

loadFacets();
syncSortAvail();
load(true);

// Deep link: /?id=<tweet_id> opens that exact item on load.
const _initialId = urlId();
if (_initialId) openLikeById(_initialId, true);
