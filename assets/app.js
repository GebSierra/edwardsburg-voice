// The Edwardsburg Voice — viewer
// Plain ES module, no build step, no framework. See README for how to add an issue.

import * as pdfjsLib from '../vendor/pdfjs/pdf.mjs';

// Resolve the worker against THIS module's URL, not the page URL. A bare relative
// string gets resolved against pdf.js's own module location, which silently yields
// vendor/vendor/... once the site is served from a subpath like /edwardsburg-voice/.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;

const ZOOM_STEPS = [1, 1.5, 2, 3, 4];
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const MAX_CANVAS_PIXELS = 16_000_000; // iOS Safari fails silently above ~16.7M
const SWIPE_THRESHOLD = 50;

// ---------- DOM ----------
const els = {
  frame: document.getElementById('viewer-frame'),
  status: document.getElementById('viewer-status'),
  panes: {
    a: document.getElementById('pane-a'),
    b: document.getElementById('pane-b'),
  },
  canvases: {
    a: document.getElementById('canvas-a'),
    b: document.getElementById('canvas-b'),
  },
  issueDate: document.getElementById('issue-date'),
  pageIndicator: document.getElementById('page-indicator'),
  zoomIndicator: document.getElementById('zoom-indicator'),
  btnPrev: document.getElementById('btn-prev'),
  btnNext: document.getElementById('btn-next'),
  btnZoomIn: document.getElementById('btn-zoom-in'),
  btnZoomOut: document.getElementById('btn-zoom-out'),
  btnZoomReset: document.getElementById('btn-zoom-reset'),
  archiveStrip: document.getElementById('archive-strip'),
};

// Discourage casual right-click "save image as" on the rendered pages.
// This is a deterrent, not real protection — the source PDF file is still
// reachable directly at its URL by anyone who looks in the Network tab.
for (const c of [els.canvases.a, els.canvases.b]) {
  c.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------- State ----------
const state = {
  manifest: null,          // { title, issues: [...] }
  issueId: null,           // currently displayed issue id
  pdfDoc: null,            // active PDFDocumentProxy
  numPages: 1,
  currentPage: 1,
  zoom: 1,
  activeSlot: 'a',         // which pane/canvas is currently visible
  pdfCache: new Map(),      // issueId -> Promise<PDFDocumentProxy>
  pinch: null,               // active pinch-gesture bookkeeping, or null
  swipe: null,                // active single-pointer swipe bookkeeping, or null
};

// ---------- Manifest + PDF loading ----------

async function loadManifest() {
  const res = await fetch('issues.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`issues.json failed to load: ${res.status}`);
  const manifest = await res.json();
  if (!Array.isArray(manifest.issues) || manifest.issues.length === 0) {
    throw new Error('issues.json has no issues');
  }
  return manifest;
}

function getIssue(issueId) {
  return state.manifest.issues.find((i) => i.id === issueId) || null;
}

function loadPdf(issue) {
  if (state.pdfCache.has(issue.id)) return state.pdfCache.get(issue.id);
  const task = pdfjsLib.getDocument({ url: issue.file });
  const promise = task.promise;
  state.pdfCache.set(issue.id, promise);
  return promise;
}

// ---------- Rendering ----------

function computeRenderScale(baseViewport, containerWidth, zoom) {
  const fitScale = containerWidth / baseViewport.width;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let renderScale = fitScale * zoom * dpr;

  const px = (baseViewport.width * renderScale) * (baseViewport.height * renderScale);
  if (px > MAX_CANVAS_PIXELS) {
    renderScale *= Math.sqrt(MAX_CANVAS_PIXELS / px);
  }
  return { renderScale, fitScale };
}

/*
 * Every render goes through one queue, so no two page.render() calls are ever live
 * at once. pdf.js breaks two different ways when they overlap: a second render on a
 * busy PDFPageProxy leaves both promises unsettled forever (a frozen page turn), and
 * a second render into a busy canvas throws "Cannot use the same canvas...". Checking
 * for those conflicts pairwise doesn't work, because the check and the render call are
 * separated by awaits, so two turns can both pass the check and then collide anyway.
 * Serialising removes the race by construction.
 */
let renderQueue = Promise.resolve();
let activeTask = null;

function enqueueRender(job) {
  // Cut short whatever is drawing now, so the newest request starts sooner.
  if (activeTask) {
    try { activeTask.cancel(); } catch { /* already finished */ }
  }
  const next = async () => {
    // Let pdf.js finish releasing the canvas it was drawing into. After a cancel it
    // rejects our promise first and frees the canvas a tick later, so starting the
    // next render immediately trips its "same canvas" guard.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return job();
  };
  const result = renderQueue.then(next, next);
  renderQueue = result.then(() => {}, () => {}); // queue survives a failed job
  return result;
}

/**
 * Renders `pageNum` into `canvas` at the given zoom, sized to fit `containerWidth`.
 * Returns null if the render was cancelled or `stillWanted()` went false while queued.
 */
function renderPageInto(pageNum, canvas, zoom, containerWidth, stillWanted) {
  return enqueueRender(() => drawPage(pageNum, canvas, zoom, containerWidth, stillWanted));
}

async function drawPage(pageNum, canvas, zoom, containerWidth, stillWanted) {
  if (stillWanted && !stillWanted()) return null;

  const page = await state.pdfDoc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const { renderScale, fitScale } = computeRenderScale(base, containerWidth, zoom);
  const viewport = page.getViewport({ scale: renderScale });

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const cssWidth = base.width * fitScale * zoom;
  const cssHeight = base.height * fitScale * zoom;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  const ctx = canvas.getContext('2d');
  const task = page.render({ canvasContext: ctx, viewport });
  activeTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return null;
    throw err;
  } finally {
    if (activeTask === task) activeTask = null;
  }

  return { cssWidth, cssHeight };
}

function frameContentWidth() {
  // Available width inside the frame, minus the pane's own padding (1rem each side).
  const style = getComputedStyle(els.panes.a);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  return Math.max(els.frame.clientWidth - padding, 100);
}

// ---------- Page navigation ----------

function otherSlot(slot) {
  return slot === 'a' ? 'b' : 'a';
}

function updatePageIndicator() {
  els.pageIndicator.textContent = `Page ${state.currentPage} of ${state.numPages}`;
  els.btnPrev.disabled = state.currentPage <= 1;
  els.btnNext.disabled = state.currentPage >= state.numPages;
}

function updateZoomIndicator() {
  els.zoomIndicator.textContent = `${Math.round(state.zoom * 100)}%`;
  els.btnZoomReset.hidden = state.zoom <= 1;
  els.btnZoomOut.disabled = state.zoom <= MIN_ZOOM;
  els.btnZoomIn.disabled = state.zoom >= MAX_ZOOM;
  // Hands horizontal panning back to the browser only while zoomed in; at 1x the
  // horizontal gesture belongs to swipe-to-turn. See the touch-action note in CSS.
  els.frame.classList.toggle('is-zoomed', state.zoom > 1);
}

function announce(text) {
  els.status.textContent = text;
}

async function renderCurrentPage({ animateDirection = null, seq = null } = {}) {
  const visibleCanvas = els.canvases[state.activeSlot];
  const width = frameContentWidth();

  if (!animateDirection) {
    await renderPageInto(state.currentPage, visibleCanvas, state.zoom, width);
    updatePageIndicator();
    updateZoomIndicator();
    return;
  }

  // Animated page turn: render into the hidden pane, then cross-fade/slide.
  const fromSlot = state.activeSlot;
  const toSlot = otherSlot(fromSlot);
  const toCanvas = els.canvases[toSlot];
  const toPane = els.panes[toSlot];
  const fromPane = els.panes[fromSlot];

  const rendered = await renderPageInto(
    state.currentPage, toCanvas, state.zoom, width,
    () => seq === null || seq === turnSeq
  );
  // Bail if this render was cancelled, or if a newer turn started while we drew.
  if (!rendered || (seq !== null && seq !== turnSeq)) return;

  // Only the incoming page animates: it fades up on top of the outgoing one, which
  // stays fully opaque underneath. Neither is ever semi-transparent over the page
  // background, so there is no bright flash between pages.
  const enterClass = animateDirection === 'next' ? 'pane-enter-from-right' : 'pane-enter-from-left';

  toPane.classList.remove('viewer__pane--hidden');
  toPane.classList.add('pane-incoming', enterClass);
  fromPane.classList.add('pane-outgoing');

  await Promise.race([
    new Promise((resolve) => toPane.addEventListener('animationend', resolve, { once: true })),
    new Promise((resolve) => setTimeout(resolve, 520)), // safety net if animations are disabled
  ]);

  fromPane.classList.add('viewer__pane--hidden');
  fromPane.classList.remove('pane-outgoing');
  toPane.classList.remove('pane-incoming', enterClass);

  state.activeSlot = toSlot;
  els.frame.scrollTop = 0;
  els.frame.scrollLeft = 0;

  updatePageIndicator();
  updateZoomIndicator();
}


// Turns supersede rather than block. A lock here meant that on a big screen, where
// rendering a tabloid page takes the better part of a second, a second swipe during
// that window was silently thrown away. Now every gesture is accepted and the most
// recent one wins.
let turnSeq = 0;

async function goToPage(targetPage, { pushHistory = false } = {}) {
  const clamped = Math.min(Math.max(targetPage, 1), state.numPages);
  if (clamped === state.currentPage) return;

  const seq = ++turnSeq;
  const direction = clamped > state.currentPage ? 'next' : 'prev';
  state.currentPage = clamped;
  state.zoom = 1; // reset zoom on every page change, per spec

  // Update the counter before the render so a swipe registers instantly, even
  // though the page itself takes a moment to draw.
  updatePageIndicator();
  updateZoomIndicator();
  announce(`Loading page ${state.currentPage}`);

  try {
    await renderCurrentPage({ animateDirection: direction, seq });
  } catch (err) {
    if (seq === turnSeq) announce('That page could not be displayed.');
    // eslint-disable-next-line no-console
    console.error(err);
    return;
  }
  if (seq !== turnSeq) return; // a newer turn took over while this one rendered

  announce(`Page ${state.currentPage} of ${state.numPages}`);
  writeHash({ push: pushHistory });
}

// ---------- Zoom ----------

function nearestStepIndex(zoom) {
  let closest = 0;
  let closestDelta = Infinity;
  ZOOM_STEPS.forEach((z, i) => {
    const d = Math.abs(z - zoom);
    if (d < closestDelta) { closestDelta = d; closest = i; }
  });
  return closest;
}

const clamp01 = (n) => Math.min(Math.max(n, 0), 1);

/**
 * Re-renders the current page at `newZoom`, keeping the point under `anchor`
 * (viewport/client coordinates) in place.
 *
 * Anchoring is measured against the canvas's own rect, before and after the
 * re-render. An earlier version mixed scroll-content coordinates with canvas
 * coordinates, which ignored the pane's padding and the centring offset — so
 * every pinch crept down and to the right instead of zooming where you pinched.
 */
async function setZoom(newZoom, anchor = null) {
  const clamped = Math.min(Math.max(newZoom, MIN_ZOOM), MAX_ZOOM);
  if (Math.abs(clamped - state.zoom) < 0.001) return;

  const frame = els.frame;
  const frameRect = frame.getBoundingClientRect();
  const point = anchor || {
    x: frameRect.left + frame.clientWidth / 2,
    y: frameRect.top + frame.clientHeight / 2,
  };

  const canvas = els.canvases[state.activeSlot];
  const before = canvas.getBoundingClientRect();
  // Where the anchor falls on the page itself, 0..1. Clamped so a pinch landing
  // in the margin beside the page still resolves to a sensible spot on it.
  const fracX = before.width ? clamp01((point.x - before.left) / before.width) : 0.5;
  const fracY = before.height ? clamp01((point.y - before.top) / before.height) : 0.5;

  state.zoom = clamped;
  await renderPageInto(state.currentPage, canvas, state.zoom, frameContentWidth());

  // Nudge the scroll so that same spot lands back under the fingers, using real
  // post-layout geometry rather than assuming where the canvas sits.
  const after = canvas.getBoundingClientRect();
  frame.scrollLeft += (after.left + fracX * after.width) - point.x;
  frame.scrollTop += (after.top + fracY * after.height) - point.y;

  updateZoomIndicator();
}

function zoomStep(delta) {
  const idx = nearestStepIndex(state.zoom);
  const nextIdx = Math.min(Math.max(idx + delta, 0), ZOOM_STEPS.length - 1);
  setZoom(ZOOM_STEPS[nextIdx]);
}

// ---------- Pointer gestures: pinch-to-zoom and swipe-to-turn ----------

const activePointers = new Map();

function pointerDistance(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

function pointerMidpoint(p1, p2) {
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
}

els.frame.addEventListener('pointerdown', (e) => {
  // Capture so a swipe that travels past the edge of the frame still delivers its
  // pointerup here. Without this a fast flick on a phone just vanishes.
  try { els.frame.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 2) {
    // Begin pinch — cancel any single-pointer swipe tracking in progress.
    state.swipe = null;
    const [p1, p2] = [...activePointers.values()];
    const pane = els.panes[state.activeSlot];
    const rect = pane.getBoundingClientRect();
    const mid = pointerMidpoint(p1, p2);
    state.pinch = {
      startDistance: pointerDistance(p1, p2),
      startZoom: state.zoom,
      originXPct: ((mid.x - rect.left) / rect.width) * 100,
      originYPct: ((mid.y - rect.top) / rect.height) * 100,
      lastMid: mid,
    };
    pane.style.transformOrigin = `${state.pinch.originXPct}% ${state.pinch.originYPct}%`;
  } else if (activePointers.size === 1 && state.zoom === 1) {
    state.swipe = { startX: e.clientX, startY: e.clientY };
  }
});

els.frame.addEventListener('pointermove', (e) => {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (state.pinch && activePointers.size === 2) {
    const [p1, p2] = [...activePointers.values()];
    const distance = pointerDistance(p1, p2);
    const ratio = distance / state.pinch.startDistance;
    const previewZoom = Math.min(Math.max(state.pinch.startZoom * ratio, MIN_ZOOM), MAX_ZOOM);
    const cssRatio = previewZoom / state.pinch.startZoom;
    // Transient, GPU-only preview — no re-render until the gesture ends.
    els.panes[state.activeSlot].style.transform = `scale(${cssRatio})`;
    state.pinch.lastRatio = ratio;
    state.pinch.lastMid = pointerMidpoint(p1, p2);
  }
});

function endPinchIfDone() {
  if (state.pinch && activePointers.size < 2) {
    const pane = els.panes[state.activeSlot];
    const finalZoom = Math.min(
      Math.max(state.pinch.startZoom * (state.pinch.lastRatio || 1), MIN_ZOOM),
      MAX_ZOOM
    );
    pane.style.transform = '';
    pane.style.transformOrigin = '';
    const mid = state.pinch.lastMid;
    state.pinch = null;
    setZoom(finalZoom, mid);
  }
}

function handleSwipeEnd(e) {
  if (!state.swipe) return;
  const dx = e.clientX - state.swipe.startX;
  const dy = e.clientY - state.swipe.startY;
  state.swipe = null;
  if (Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
    if (dx < 0) goToPage(state.currentPage + 1);
    else goToPage(state.currentPage - 1);
  }
}

function releasePointer(e, completed) {
  try { els.frame.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  const hadTwo = activePointers.size === 2;
  activePointers.delete(e.pointerId);
  if (hadTwo) endPinchIfDone();
  else if (completed) handleSwipeEnd(e);
  else state.swipe = null; // browser took the gesture over; don't turn the page
}

els.frame.addEventListener('pointerup', (e) => releasePointer(e, true));
els.frame.addEventListener('pointercancel', (e) => releasePointer(e, false));

// Desktop: ctrl+wheel to zoom, double-click to zoom.
els.frame.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const delta = -e.deltaY * 0.01;
  setZoom(state.zoom * (1 + delta), { x: e.clientX, y: e.clientY });
}, { passive: false });

els.frame.addEventListener('dblclick', (e) => {
  const target = state.zoom > 1 ? 1 : 2.5;
  setZoom(target, { x: e.clientX, y: e.clientY });
});

// Keyboard: arrows to turn pages, Home/End to jump, only when the frame has focus.
els.frame.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowRight': e.preventDefault(); goToPage(state.currentPage + 1); break;
    case 'ArrowLeft': e.preventDefault(); goToPage(state.currentPage - 1); break;
    case 'Home': e.preventDefault(); goToPage(1); break;
    case 'End': e.preventDefault(); goToPage(state.numPages); break;
  }
});

// ---------- Buttons ----------

els.btnPrev.addEventListener('click', () => goToPage(state.currentPage - 1));
els.btnNext.addEventListener('click', () => goToPage(state.currentPage + 1));
els.btnZoomIn.addEventListener('click', () => zoomStep(1));
els.btnZoomOut.addEventListener('click', () => zoomStep(-1));
els.btnZoomReset.addEventListener('click', () => setZoom(1));

// Re-render crisply on resize (debounced), preserving page and zoom.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderCurrentPage();
  }, 150);
});

// ---------- URL state (#YYYY-MM/pN) ----------

function parseHash() {
  const m = /^#([0-9]{4}-[0-9]{2})\/p([0-9]+)$/.exec(location.hash);
  if (!m) return null;
  return { issueId: m[1], page: parseInt(m[2], 10) };
}

function writeHash({ push = false } = {}) {
  const next = `#${state.issueId}/p${state.currentPage}`;
  if (push) history.pushState(null, '', next);
  else history.replaceState(null, '', next);
}

async function syncFromHash() {
  const parsed = parseHash();
  const issue = (parsed && getIssue(parsed.issueId)) || state.manifest.issues[0];
  const page = parsed && getIssue(parsed.issueId) ? parsed.page : 1;
  if (issue.id === state.issueId) {
    await goToPage(page);
  } else {
    await openIssue(issue, { page, pushHistory: false });
  }
}

window.addEventListener('popstate', syncFromHash);
window.addEventListener('hashchange', syncFromHash);

// ---------- Switching issues ----------

async function openIssue(issue, { page = 1, pushHistory = true } = {}) {
  state.issueId = issue.id;
  els.issueDate.textContent = issue.label;

  announce(`Loading ${issue.label}`);
  state.pdfDoc = await loadPdf(issue);
  state.numPages = state.pdfDoc.numPages;
  state.currentPage = Math.min(Math.max(page, 1), state.numPages);
  state.zoom = 1;

  await renderPageInto(
    state.currentPage, els.canvases[state.activeSlot], state.zoom, frameContentWidth()
  );
  updatePageIndicator();
  updateZoomIndicator();
  announce(`${issue.label}, page ${state.currentPage} of ${state.numPages}`);
  writeHash({ push: pushHistory });
  renderArchive();
}

// ---------- Archive strip ----------

const thumbObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const card = entry.target;
    thumbObserver.unobserve(card);
    renderThumbnail(card);
  }
}, { rootMargin: '200px' });

async function renderThumbnail(card) {
  const issueId = card.dataset.issueId;
  const issue = getIssue(issueId);
  const thumbWrap = card.querySelector('.archive-card__thumb');
  try {
    const pdfDoc = await loadPdf(issue);
    const page = await pdfDoc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const targetWidth = 200;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = (targetWidth / base.width) * dpr;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    thumbWrap.replaceChildren(canvas);
  } catch {
    thumbWrap.textContent = issue.label;
  }
}

function renderArchive() {
  els.archiveStrip.replaceChildren();
  const others = state.manifest.issues.filter((i) => i.id !== state.issueId);
  for (const issue of others) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'archive-card';
    card.dataset.issueId = issue.id;
    card.setAttribute('aria-label', `Open ${issue.label} issue`);
    card.innerHTML = `
      <span class="archive-card__thumb"></span>
      <span class="archive-card__label">${issue.label}</span>
    `;
    card.addEventListener('click', () => {
      openIssue(issue, { page: 1, pushHistory: true }).then(() => {
        els.frame.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    els.archiveStrip.appendChild(card);
    thumbObserver.observe(card);
  }
}

// ---------- Background photo bands ----------

// The hero slideshow and the divider drift are pure CSS. This just pauses them
// while they're off-screen, so a phone isn't compositing photos nobody can see
// while someone reads the paper.
const photoBands = ['hero', 'divider']
  .map((id) => document.getElementById(id))
  .filter(Boolean);

if (photoBands.length && 'IntersectionObserver' in window) {
  const bandObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      entry.target.classList.toggle('is-paused', !entry.isIntersecting);
    }
  }, { rootMargin: '80px' });
  photoBands.forEach((el) => bandObserver.observe(el));
}

// ---------- Boot ----------

async function main() {
  try {
    state.manifest = await loadManifest();
    document.title = state.manifest.title || document.title;
    await syncFromHash();
  } catch (err) {
    announce('Sorry, this issue could not be loaded.');
    els.pageIndicator.textContent = '—';
    // eslint-disable-next-line no-console
    console.error(err);
  }
}

main();


