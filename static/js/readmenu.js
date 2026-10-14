/**
 * readmenu.js — right-click on the PDF text layer opens a small menu at the pointer
 * offering "Read from here".
 *
 * Right-click inside a page's `.textLayer` replaces the browser's context menu; anywhere
 * else the native menu is untouched. Double-click is not handled here: it selects a word,
 * and the selection toolbar (highlights.js) carries the same "Read from here" action, so a
 * double-click never opens two floating surfaces for one word.
 *
 * The click → `{page, item}` mapping lives here; which sentence that means is
 * readfrom.js's job. No imports; collaborators arrive as options.
 */

const MENU_MARGIN_PX = 6;      // keep the menu this far inside the viewport
const OBSTACLE_GAP_PX = 4;     // clearance from the selection toolbar when dodging it

// ── Pure helpers (exported for tests) ─────────────────────────────────────────

const overlaps = (a, b) =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/**
 * Where to put a `size` menu opened at `point`: down-right of the pointer, flipped left/up
 * when it would leave the viewport, and moved clear of `obstacle` (the selection toolbar)
 * when they would overlap. `origin` is the corner at the pointer, for transform-origin.
 * @returns {{left:number, top:number, origin:string}}
 */
export function placeMenu(point, size, viewport, obstacle = null) {
  const flipX = point.x + size.width > viewport.width - MENU_MARGIN_PX;
  const flipY = point.y + size.height > viewport.height - MENU_MARGIN_PX;
  const clamp = (v, extent, span) => Math.min(Math.max(v, MENU_MARGIN_PX), Math.max(extent - span - MENU_MARGIN_PX, MENU_MARGIN_PX));
  const left = clamp(flipX ? point.x - size.width : point.x, viewport.width, size.width);
  let top = clamp(flipY ? point.y - size.height : point.y, viewport.height, size.height);
  if (obstacle && overlaps({ left, top, ...size }, obstacle)) {
    const below = obstacle.top + obstacle.height + OBSTACLE_GAP_PX;
    const above = obstacle.top - OBSTACLE_GAP_PX - size.height;
    top = below + size.height <= viewport.height - MENU_MARGIN_PX ? below : clamp(above, viewport.height, size.height);
  }
  return { left, top, origin: `${flipX ? 'right' : 'left'} ${flipY ? 'bottom' : 'top'}` };
}

/**
 * The text span a click means when it did not land on one (a figure, a margin): the
 * nearest span at or below the pointer that shares its column, else the nearest span.
 * @param {Array<{left:number, top:number, width:number, height:number}>} rects span rects, in DOM order
 * @returns {number} index into `rects`, -1 when there are none
 */
export function nearestSpanIndex(rects, point) {
  let below = -1;
  let nearest = -1;
  let bestDistance = Infinity;
  (rects || []).forEach((r, i) => {
    if (!r || !(r.width > 0) || !(r.height > 0)) return;
    const inColumn = point.x >= r.left && point.x <= r.left + r.width;
    if (inColumn && r.top + r.height >= point.y && (below < 0 || r.top < rects[below].top)) below = i;
    const dx = Math.max(r.left - point.x, 0, point.x - (r.left + r.width));
    const dy = Math.max(r.top - point.y, 0, point.y - (r.top + r.height));
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) { bestDistance = distance; nearest = i; }
  });
  return below >= 0 ? below : nearest;
}

// ── DOM glue ──────────────────────────────────────────────────────────────────

/**
 * Map a DOM node inside a page's text layer to `{page, item}`, or null outside one.
 * @param {Node} node @param {object} pdfView must provide itemIndexOf(page, span)
 * @param {{x:number, y:number}} [point] pointer, used when the node is not a text span
 */
export function targetFromNode(node, pdfView, point) {
  const host = node && (node.nodeType === 1 ? node : node.parentElement);
  const layer = host?.closest?.('.textLayer');
  const wrap = layer?.closest('.pdf-page-wrap');
  const page = Number(wrap?.dataset.page);
  if (!Number.isInteger(page) || page < 1) return null;
  let span = host.closest('span:not(.markedContent)');
  if ((!span || !layer.contains(span)) && point) {
    const spans = [...layer.querySelectorAll('span:not(.markedContent)')];
    span = spans[nearestSpanIndex(spans.map((s) => s.getBoundingClientRect()), point)] || null;
  }
  const item = span ? pdfView.itemIndexOf(page, span) : -1;
  return { page, item: item >= 0 ? item : null };
}

/**
 * @param {{pdfView:object, onRead:function({page:number, item:number|null}):void}} options
 * @returns {{attach:function, detach:function, close:function, isOpen:function}}
 */
export function createReadMenu({ pdfView, onRead }) {
  if (!pdfView || typeof onRead !== 'function') throw new Error('createReadMenu requires pdfView and onRead');

  let menu = null;
  let target = null;
  let point = null;
  let returnFocus = null;
  let anchor = null; // the right-clicked node; scrolls of containers holding it close the menu

  function build() {
    const node = document.createElement('div');
    node.className = 'read-menu';
    node.setAttribute('role', 'menu');
    node.setAttribute('aria-label', 'Reading');
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'read-menu-item';
    item.setAttribute('role', 'menuitem');
    item.textContent = 'Read from here';
    node.appendChild(item);
    node.addEventListener('click', choose);
    // Enter / Space belong to the focused item, not to the reader's global shortcuts.
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
    });
    document.body.appendChild(node);
    return node;
  }

  /** Pin the menu at the pointer, clear of the selection toolbar if that is open. */
  function place() {
    // offsetWidth/Height ignore the open animation's scale, so the menu never lands off-screen.
    const toolbar = document.querySelector('.hl-toolbar.is-open')?.getBoundingClientRect() || null;
    const spot = placeMenu(point, { width: menu.offsetWidth, height: menu.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight }, toolbar);
    Object.assign(menu.style, { left: `${Math.round(spot.left)}px`, top: `${Math.round(spot.top)}px`, transformOrigin: spot.origin });
  }

  function open(at, nextTarget) {
    if (!menu) menu = build();
    target = nextTarget;
    point = at;
    returnFocus = document.activeElement;
    menu.classList.add('is-open');
    place();
    menu.querySelector('.read-menu-item').focus({ preventScroll: true });
  }

  function close() {
    if (!menu?.classList.contains('is-open')) return;
    menu.classList.remove('is-open');
    target = null;
    anchor = null;
    if (menu.contains(document.activeElement) && returnFocus?.isConnected && returnFocus !== document.body) {
      returnFocus.focus({ preventScroll: true });
    }
    returnFocus = null;
  }

  function choose(event) {
    if (!event.target.closest('.read-menu-item') || !target) return;
    const chosen = target;
    close();
    onRead(chosen);
  }

  function onContextMenu(event) {
    if (menu?.contains(event.target)) return void event.preventDefault();
    const at = { x: event.clientX, y: event.clientY };
    const hit = targetFromNode(event.target, pdfView, at);
    if (!hit) return close();
    event.preventDefault();
    anchor = event.target;
    open(at, hit);
  }

  const onPointerDown = (event) => {
    if (menu && !menu.contains(event.target) && event.button !== 2) close();
  };
  // The selection toolbar opens on the tick after mouseup, which can follow contextmenu:
  // re-place the menu once it is there so the two never overlap.
  const onMouseUp = () => {
    if (menu?.classList.contains('is-open')) setTimeout(() => menu.classList.contains('is-open') && place(), 0);
  };
  // Only a scroll that moves the clicked text closes the menu (not the queue following playback).
  const onScroll = (event) => {
    if (!(event.target instanceof Element) || event.target.contains(anchor)) close();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && menu?.classList.contains('is-open')) close();
  };

  const LISTENERS = [
    [document, 'contextmenu', onContextMenu, false],
    [document, 'pointerdown', onPointerDown, true],
    [document, 'mouseup', onMouseUp, false],
    [document, 'keydown', onKeyDown, true],
    [window, 'scroll', onScroll, true],
    [window, 'resize', close, false],
    [window, 'blur', close, false],
  ];

  let attached = false;
  return {
    attach() {
      if (attached) return;
      attached = true;
      for (const [on, type, fn, capture] of LISTENERS) on.addEventListener(type, fn, capture);
    },
    detach() {
      if (!attached) return;
      attached = false;
      for (const [on, type, fn, capture] of LISTENERS) on.removeEventListener(type, fn, capture);
      close();
    },
    close,
    isOpen: () => Boolean(menu?.classList.contains('is-open')),
  };
}
