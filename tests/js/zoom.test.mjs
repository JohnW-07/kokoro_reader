// Pure helpers behind PDF zoom (U6): the step ladder, the pinch curve, the ⌘ shortcuts,
// and the scroll anchor that keeps the same content in view across a re-layout.
import { ZOOM_MIN, ZOOM_MAX, ZOOM_FIT, ZOOM_STEPS, clampZoom, stepZoom, formatZoom, pinchZoom, zoomFromKey, isZoomKey, createZoom }
    from '../../static/js/zoom.js';
import { anchoredOffset } from '../../static/js/layout.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };

console.log('\n1. the ladder');
ok('   runs 50% to 300% and stands on fit-width',
    ZOOM_MIN === 0.5 && ZOOM_MAX === 3 && ZOOM_FIT === 1 && ZOOM_STEPS.includes(1));
ok('   is sorted, starts at the floor and ends at the ceiling',
    ZOOM_STEPS[0] === ZOOM_MIN && ZOOM_STEPS.at(-1) === ZOOM_MAX
    && ZOOM_STEPS.every((s, i) => i === 0 || s > ZOOM_STEPS[i - 1]), ZOOM_STEPS.join(','));
ok('   steps up and down between neighbours',
    stepZoom(1, 1) === 1.25 && stepZoom(1.25, -1) === 1 && stepZoom(2, 1) === 2.5);
ok('   an off-ladder level (a pinch) steps to the neighbour on that side',
    stepZoom(1.1, 1) === 1.25 && stepZoom(1.1, -1) === 1 && stepZoom(2.99, 1) === 3);
ok('   never leaves the range', stepZoom(3, 1) === ZOOM_MAX && stepZoom(0.5, -1) === ZOOM_MIN);
ok('   clamps junk to fit-width or the bounds',
    clampZoom(undefined) === 1 && clampZoom('x') === 1 && clampZoom(9) === 3 && clampZoom(0.1) === 0.5);

console.log('\n2. the readout');
ok('   whole percents, unambiguous about 100%',
    formatZoom(1) === '100%' && formatZoom(0.67) === '67%' && formatZoom(3) === '300%');

console.log('\n3. pinch');
ok('   pinching out zooms in, pinching in zooms out',
    pinchZoom(1, -10) > 1 && pinchZoom(1, 10) < 1);
ok('   the same gesture is the same proportion at every level',
    Math.abs((pinchZoom(1, -10) / 1) - (pinchZoom(2, -10) / 2)) < 0.02,
    `${pinchZoom(1, -10)} vs ${pinchZoom(2, -10)}`);
ok('   one event is a small move, not a jump', Math.abs(pinchZoom(1, -10) - 1) < 0.2, String(pinchZoom(1, -10)));
ok('   stays in range whatever the trackpad reports',
    pinchZoom(3, -500) === ZOOM_MAX && pinchZoom(0.5, 500) === ZOOM_MIN && pinchZoom(1, NaN) === 1);
ok('   lands on whole percents so the readout does not flicker',
    Number.isInteger(Math.round(pinchZoom(1, -7) * 100)) && pinchZoom(1, -7) === Math.round(pinchZoom(1, -7) * 100) / 100);
// A mouse is not a trackpad: one notch is a single event carrying the whole gesture.
// Chrome/WebKit report -120 for a pixel-unit notch, a webview line-unit notch ~-40;
// on an uncapped exponential those are 3.3x and 1.5x, i.e. 100% -> 300% in one flick.
const NOTCH_CEILING = 1.2;
ok('   one mouse-wheel notch is a step, not the whole ladder',
    pinchZoom(1, -120) <= NOTCH_CEILING && pinchZoom(1, -40) <= NOTCH_CEILING,
    `-120 -> ${pinchZoom(1, -120)}, -40 -> ${pinchZoom(1, -40)}`);
ok('   and a notch the other way does not bottom out either',
    pinchZoom(1, 120) >= 1 / NOTCH_CEILING && pinchZoom(1, 40) >= 1 / NOTCH_CEILING,
    `120 -> ${pinchZoom(1, 120)}, 40 -> ${pinchZoom(1, 40)}`);
// The cap must not flatten the gesture the gain is tuned for: a trackpad pinch is a
// stream of small deltas, and 20 of deltaY -4 is exp(0.8) = 2.23x however it is summed.
const stream = Array.from({ length: 20 }).reduce((z) => pinchZoom(z, -4), 1);
ok('   a real trackpad pinch still travels its full distance', Math.abs(stream - 2.23) < 0.05, String(stream));

console.log('\n4. the ⌘ shortcuts');
const key = (code, mods = { metaKey: true }) => ({ code, metaKey: false, ctrlKey: false, altKey: false, ...mods });
ok('   ⌘+ steps in, ⌘− steps out, ⌘0 returns to fit-width',
    zoomFromKey(key('Equal'), 1) === 1.25 && zoomFromKey(key('Minus'), 1) === 0.8
    && zoomFromKey(key('Digit0'), 2.5) === ZOOM_FIT);
ok('   the numpad keys work too',
    zoomFromKey(key('NumpadAdd'), 1) === 1.25 && zoomFromKey(key('NumpadSubtract'), 1) === 0.8
    && zoomFromKey(key('Numpad0'), 2) === 1);
ok('   Ctrl works for a non-Mac keyboard', zoomFromKey(key('Equal', { ctrlKey: true }), 1) === 1.25);
ok('   ⌘⇧+ (what the key really sends) still zooms',
    zoomFromKey(key('Equal', { metaKey: true, shiftKey: true }), 1) === 1.25);
ok('   a bare key is not a zoom: Space, ←, →, S, R and B still belong to the reader',
    ['Space', 'ArrowLeft', 'ArrowRight', 'KeyS', 'KeyR', 'KeyB']
        .every((code) => zoomFromKey(key(code, {}), 1) === null && zoomFromKey(key(code), 1) === null));
ok('   ⌥⌘− is not ours either (it is the window manager\'s)',
    zoomFromKey(key('Minus', { metaKey: true, altKey: true }), 1) === null);
ok('   a missing event is not a zoom', zoomFromKey(null, 1) === null && zoomFromKey(undefined, 1) === null);
ok('   isZoomKey (the notes panel lets these through, U39) agrees with zoomFromKey',
    ['Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract', 'Digit0', 'Numpad0', 'KeyB', 'Space', 'toString']
        .every((code) => isZoomKey(key(code)) === (zoomFromKey(key(code), 1) !== null))
    && isZoomKey(key('Equal')) && !isZoomKey(key('toString')) && !isZoomKey(key('Equal', {})) && !isZoomKey(null));

console.log('\n5. the scroll anchor');
// After a re-layout: scrolled to 3000, the held page now starts 200px into the scroller's
// box and is 1600px tall, and the point being held is a quarter of the way down it.
const TOP = 3000, PAGE_START = 200, PAGE_SIZE = 1600, QUARTER = 0.25;
const held = (anchorPx) => anchoredOffset(TOP, anchorPx, PAGE_START, PAGE_SIZE, QUARTER);
ok('   it scrolls by exactly how far the held point moved away from the anchor',
    held(600) === TOP + (PAGE_START + 400) - 600, String(held(600)));
ok('   a point already under the anchor does not move the page',
    held(PAGE_START + QUARTER * PAGE_SIZE) === TOP);
ok('   anchor 0 pins the top edge (a window resize)', held(0) === TOP + PAGE_START + 400);
ok('   the top of the page and the bottom of the page are the ends of the same line',
    anchoredOffset(TOP, 600, PAGE_START, PAGE_SIZE, 0) === TOP - 400
    && anchoredOffset(TOP, 600, PAGE_START, PAGE_SIZE, 1) === TOP + 1200);
ok('   a page twice the size moves the anchor twice as far',
    anchoredOffset(0, 0, 0, 2 * PAGE_SIZE, QUARTER) === 2 * anchoredOffset(0, 0, 0, PAGE_SIZE, QUARTER));
ok('   never scrolls above the top of the document', anchoredOffset(0, 900, 0, PAGE_SIZE, QUARTER) === 0);
ok('   an unmeasured page leaves the offset alone', anchoredOffset(TOP, 100, 0, 0, QUARTER) === TOP);

console.log('\n6. the binder, with no paper open');
// Smallest DOM the binder touches: the pill is absent (index.html ships it hidden), so
// this is purely about what the handlers do before they reach the document.
function bind({ hasDocument }) {
    const handlers = {};
    const doc = { getElementById: () => null, addEventListener: (t, h) => { handlers[t] = h; } };
    const scroller = { addEventListener: (t, h) => { handlers[t] = h; } };
    const zooms = [];
    createZoom({ scroller, doc, getZoom: () => 1, hasDocument, onZoom: (z, a) => zooms.push([z, a]) });
    return { handlers, zooms };
}
const fire = (handler, event) => { let claimed = false; handler({ preventDefault: () => { claimed = true; }, ...event }); return claimed; };
const closed = bind({ hasDocument: () => false });
ok('   ⌘+ does not zoom a document that is not there',
    fire(closed.handlers.keydown, { code: 'Equal', metaKey: true }) && closed.zooms.length === 0,
    JSON.stringify(closed.zooms));
ok('   ⌘0 does not either', fire(closed.handlers.keydown, { code: 'Digit0', metaKey: true }) && closed.zooms.length === 0);
ok('   but the key is still claimed, so the webview does not zoom its own chrome',
    fire(closed.handlers.keydown, { code: 'Minus', metaKey: true }));
ok('   a pinch over an empty reader is claimed and ignored the same way',
    fire(closed.handlers.wheel, { ctrlKey: true, deltaY: -40 }) && closed.zooms.length === 0);
ok('   a bare key is left alone entirely',
    fire(closed.handlers.keydown, { code: 'Space' }) === false && closed.zooms.length === 0);
const open = bind({ hasDocument: () => true });
ok('   with paper open the same ⌘+ zooms', fire(open.handlers.keydown, { code: 'Equal', metaKey: true })
    && open.zooms.length === 1 && open.zooms[0][0] === 1.25, JSON.stringify(open.zooms));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
