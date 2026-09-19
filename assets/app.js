// The Edwardsburg Voice — viewer
// Plain ES module, no build step, no framework. See README for how to add an issue.

import * as pdfjsLib from '../vendor/pdfjs/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '../vendor/pdfjs/pdf.worker.mjs';

const ZOOM_STEPS = [1, 1.5, 2, 3, 4];
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const MAX_CANVAS_PIXELS = 16_000_000; // iOS Safari fails silently above ~16.7M
const SWIPE_THRESHOLD = 50;
const PREFETCH_CACHE_LIMIT = 3;

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
  renderTasks: { a: null, b: null },
  prefetchCache: new Map(), // page number -> { canvas, cssWidth, cssHeight }
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

/** Renders `pageNum` into `canvas` at the given zoom, sized to fit `containerWidth`. */
async function renderPageInto(pageNum, canvas, zoom, containerWidth, slot) {
  const page = await state.pdfDoc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const { renderScale, fitScale } = computeRenderScale(base, containerWidth, zoom);
  const viewport = page.getViewport({ scale: renderScale });

  // Cancel any in-flight render on this canvas before starting a new one,
  // otherwise rapid page turns / resizes can interleave and tear the canvas.
  if (slot && state.renderTasks[slot]) {
    try { state.renderTasks[slot].cancel(); } catch { /* already done */ }
  }

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const cssWidth = base.width * fitScale * zoom;
  const cssHeight = base.height * fitScale * zoom;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  const ctx = canvas.getContext('2d');
  const task = page.render({ canvasContext: ctx, viewport });
  if (slot) state.renderTasks[slot] = task;
  await task.promise;
  if (slot) state.renderTasks[slot] = null;

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
}

function announce(text) {
  els.status.textContent = text;
}

async function renderCurrentPage({ animateDirection = null } = {}) {
  const visibleCanvas = els.canvases[state.activeSlot];
  const width = frameContentWidth();

  if (!animateDirection) {
    await renderPageInto(state.currentPage, visibleCanvas, state.zoom, width, state.activeSlot);
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

  await renderPageInto(state.currentPage, toCanvas, state.zoom, width, toSlot);

  const enterClass = animateDirection === 'next' ? 'pane-enter-from-right' : 'pane-enter-from-left';
  const exitClass = animateDirection === 'next' ? 'pane-exit-to-left' : 'pane-exit-to-right';

  toPane.classList.remove('viewer__pane--hidden');
  toPane.classList.add(enterClass);
  fromPane.classList.add(exitClass);

  await Promise.race([
    new Promise((resolve) => toPane.addEventListener('animationend', resolve, { once: true })),
    new Promise((resolve) => setTimeout(resolve, 220)), // safety net if animations are disabled
  ]);

  fromPane.classList.add('viewer__pane--hidden');
  fromPane.classList.remove(exitClass);
  toPane.classList.remove(enterClass);

  state.activeSlot = toSlot;
  els.frame.scrollTop = 0;
  els.frame.scrollLeft = 0;

  updatePageIndicator();
  updateZoomIndicator();
  schedulePrefetch();
}

function schedulePrefetch() {
  const width = frameContentWidth();
  const targets = [state.currentPage - 1, state.currentPage + 1].filter(
    (p) => p >= 1 && p <= state.numPages
  );
  for (const p of targets) {
    if (state.prefetchCache.has(p)) continue;
    const offCanvas = document.createElement('canvas');
    renderPageInto(p, offCanvas, 1, width, null)
      .then(() => {
        if (state.prefetchCache.size >= PREFETCH_CACHE_LIMIT) {
          const oldestKey = state.prefetchCache.keys().next().value;
          state.prefetchCache.delete(oldestKey);
        }
        state.prefetchCache.set(p, offCanvas);
      })
      .catch(() => { /* best-effort only */ });
  }
}

let navLock = false;

async function goToPage(targetPage, { pushHistory = false } = {}) {
  const clamped = Math.min(Math.max(targetPage, 1), state.numPages);
  if (clamped === state.currentPage || navLock) return;
  navLock = true;

  const direction = clamped > state.currentPage ? 'next' : 'prev';
  state.currentPage = clamped;
  state.zoom = 1; // reset zoom on every page change, per spec
  announce(`Loading page ${state.currentPage}`);

  try {
    await renderCurrentPage({ animateDirection: direction });
    announce(`Page ${state.currentPage} of ${state.numPages}`);
    writeHash({ push: pushHistory });
  } finally {
    navLock = false;
  }
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

/**
 * Re-renders the current page at `newZoom`, keeping the point at
 * (anchorX, anchorY) — in viewport (client) coordinates — under the cursor/fingers.
 */
async function setZoom(newZoom, anchor = null) {
  const clamped = Math.min(Math.max(newZoom, MIN_ZOOM), MAX_ZOOM);
  if (Math.abs(clamped - state.zoom) < 0.001) return;

  const frameRect = els.frame.getBoundingClientRect();
  const anchorX = anchor ? anchor.x - frameRect.left + els.frame.scrollLeft : els.frame.scrollLeft + els.frame.clientWidth / 2;
  const anchorY = anchor ? anchor.y - frameRect.top + els.frame.scrollTop : els.frame.scrollTop + els.frame.clientHeight / 2;

  const canvas = els.canvases[state.activeSlot];
  const oldWidth = canvas.getBoundingClientRect().width || parseFloat(canvas.style.width) || 1;
  const oldHeight = canvas.getBoundingClientRect().height || parseFloat(canvas.style.height) || 1;
  const fracX = anchorX / oldWidth;
  const fracY = anchorY / oldHeight;

  state.zoom = clamped;
  const width = frameContentWidth();
  const { cssWidth, cssHeight } = await renderPageInto(
    state.currentPage, canvas, state.zoom, width, state.activeSlot
  );

  els.frame.scrollLeft = fracX * cssWidth - (anchor ? anchor.x - frameRect.left : els.frame.clientWidth / 2);
  els.frame.scrollTop = fracY * cssHeight - (anchor ? anchor.y - frameRect.top : els.frame.clientHeight / 2);

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

function releasePointer(e) {
  const hadTwo = activePointers.size === 2;
  activePointers.delete(e.pointerId);
  if (hadTwo) endPinchIfDone();
  else handleSwipeEnd(e);
}

els.frame.addEventListener('pointerup', releasePointer);
els.frame.addEventListener('pointercancel', releasePointer);
els.frame.addEventListener('pointerleave', (e) => {
  if (activePointers.has(e.pointerId)) releasePointer(e);
});

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
    state.prefetchCache.clear();
    renderCurrentPage().then(schedulePrefetch);
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
  state.prefetchCache.clear();
  els.issueDate.textContent = issue.label;

  announce(`Loading ${issue.label}`);
  state.pdfDoc = await loadPdf(issue);
  state.numPages = state.pdfDoc.numPages;
  state.currentPage = Math.min(Math.max(page, 1), state.numPages);
  state.zoom = 1;

  await renderPageInto(
    state.currentPage, els.canvases[state.activeSlot], state.zoom, frameContentWidth(), state.activeSlot
  );
  updatePageIndicator();
  updateZoomIndicator();
  announce(`${issue.label}, page ${state.currentPage} of ${state.numPages}`);
  writeHash({ push: pushHistory });
  schedulePrefetch();
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
