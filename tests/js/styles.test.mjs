// Harness for the markup/stylesheet contracts the shell owns.
//
// There is no browser in this environment, so this asserts the declarations are
// present and win the cascade — it cannot and does not claim to have observed
// the resulting layout. M14: #notes-panel had no grow factor, so the panel sat
// at content height inside its flex column and notes.css's `.nt-list { flex: 1 }`
// had nothing to fill.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };

const ROOT = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

/** Declarations of every rule whose selector list contains `selector`, merged in source order. */
function declarationsFor(css, selector) {
    const out = {};
    for (const [, selectors, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!selectors.split(',').some((s) => s.trim() === selector)) continue;
        for (const decl of body.split(';')) {
            const at = decl.indexOf(':');
            if (at < 0) continue;
            out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
        }
    }
    return out;
}

// U25 split app.css by feature; the app sheets, concatenated in their <link> order, are the
// one stylesheet every check below reads — the cascade is theirs in that order.
const APP_SHEETS = ['app', 'sidebar', 'document', 'a11y'].map((n) => `static/css/${n}.css`);
const app = APP_SHEETS.map(read).join('\n');
const html = read('static/index.html');

console.log('\n0. U25 — index.html loads the app sheets in the order read here, before notes.css');
const linked = [...html.matchAll(/<link rel="stylesheet" href="\/(static\/css\/[\w-]+\.css)">/g)].map((m) => m[1]);
ok('   they are the first sheets linked, in cascade order',
    JSON.stringify(linked.slice(0, APP_SHEETS.length)) === JSON.stringify(APP_SHEETS)
    && linked[APP_SHEETS.length] === 'static/css/notes.css', linked.join(','));

console.log('\n1. R3 — the Highlights list heads the notes column');
const panel = declarationsFor(app, '#notes-panel');
const column = declarationsFor(app, '#notes-column');
ok('   #notes-column is a column flex container', column.display === 'flex' && column['flex-direction'] === 'column',
    JSON.stringify(column));
ok('   #notes-panel keeps its own height (it neither grows nor is squeezed by the notes)',
    panel.flex === 'none', String(panel.flex));
ok('   ... up to a cap from a token, past which its list scrolls inside it',
    /^var\(--[\w-]+\)$/.test(panel['max-height'] ?? ''), String(panel['max-height']));
ok('   an id selector outranks notes.css\'s .nt-panel, so file order cannot undo it',
    /#notes-panel/.test(app) && !/^\s*\.nt-panel\s*\{/m.test(app));
const editPanel = declarationsFor(read('static/css/notesedit.css'), '.ne-panel');
ok('   the notes take the rest by growing, not min-height: 100% (which overflows by the list\'s height)',
    /^1 0 auto$/.test(editPanel.flex ?? '') && editPanel['min-height'] !== '100%', JSON.stringify(editPanel));
const notesSheet = read('static/css/notes.css');
ok('   a collapsed list really hides ([hidden] beats the content\'s display: flex)',
    declarationsFor(notesSheet, '.nt-panel .nt-content[hidden]').display === 'none');

console.log('\n2. the markup the rules target');
ok('   #notes-panel is the first thing in #notes-column, so the margin notes sit below it',
    /<aside id="notes-column"[^>]*>\s*(?:<!--[\s\S]*?-->\s*)?<section id="notes-panel"[^>]*aria-label="Highlights"/.test(html));
ok('   the left bar has no Highlights tab or panel any more',
    !/data-tab="notes"/.test(html) && !/id="tab-notes"/.test(html));
console.log('\n2. R3/R7 — the highlights list has left the sidebar (the notes column mounts #notes-panel)');
ok('   no notes tab panel in the sidebar', !/id="tab-notes"/.test(html));
const sidebarHtml = html.slice(html.indexOf('<aside id="sidebar"'), html.indexOf('</aside>'));
ok('   no #notes-panel inside the sidebar', !/id="notes-panel"/.test(sidebarHtml));

console.log('\n3. T3 — light palette contrast (WCAG 2.x relative luminance)');
/** Custom properties declared in the first bare `:root { }` block. */
function rootTokens(css) {
    const body = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/(?:^|\n):root\s*\{([^}]*)\}/)[1];
    return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
}
const hex = (h) => { const m = /^#([0-9a-f]{6})$/i.exec(h); return m && [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)); };
const luminance = (rgb) => {
    const [r, g, b] = rgb.map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const MIN_TEXT_CONTRAST = 4.5;
const tokens = rootTokens(app);
const TEXT_TOKENS = ['--text', '--text-muted'];
const SURFACES = ['--bg', '--panel', '--panel-2', '--notes-bg', '--input-bg', '--hover-bg'];
for (const fg of TEXT_TOKENS) {
    for (const bg of SURFACES) {
        const [f, b] = [hex(tokens[fg] ?? ''), hex(tokens[bg] ?? '')];
        const ratio = f && b ? contrast(f, b) : 0;
        ok(`   ${fg} on ${bg}: ${ratio.toFixed(2)}:1 ≥ ${MIN_TEXT_CONTRAST}`, ratio >= MIN_TEXT_CONTRAST, `${tokens[fg]} / ${tokens[bg]}`);
    }
}
for (const [fg, bg] of [['--accent', '--panel-2'], ['--on-accent', '--accent'], ['--danger', '--panel-2'], ['--success', '--panel-2'], ['--warn', '--panel-2']]) {
    const ratio = contrast(hex(tokens[fg]), hex(tokens[bg]));
    ok(`   ${fg} on ${bg}: ${ratio.toFixed(2)}:1 ≥ ${MIN_TEXT_CONTRAST}`, ratio >= MIN_TEXT_CONTRAST);
}
// Small text sitting on translucent tints: composite the tint over the surface it lands on.
const rgba = (v) => { const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(v); return m && { rgb: m.slice(1, 4).map(Number), a: Number(m[4]) }; };
const over = (base, tint) => base.map((c, i) => tint.a * tint.rgb[i] + (1 - tint.a) * c);
const layered = (surface, ...tints) => tints.reduce((acc, t) => over(acc, rgba(tokens[t])), hex(tokens[surface]));
const TINTED_TEXT = [
    ['--accent', ['--panel', '--accent-dim'], 'drop-zone hover'],
    ['--accent', ['--panel', '--accent-dim', '--accent-dim'], 'the contents entry being read'],
    ['--success', ['--panel', '--success-dim'], 'loaded drop zone'],
    ['--text-muted', ['--pressed-bg'], 'a pressed row'],
];
for (const [fg, [surface, ...tints], where] of TINTED_TEXT) {
    const ratio = contrast(hex(tokens[fg]), layered(surface, ...tints));
    ok(`   ${fg} on ${[surface, ...tints].join(' + ')} (${where}): ${ratio.toFixed(2)}:1 ≥ ${MIN_TEXT_CONTRAST}`, ratio >= MIN_TEXT_CONTRAST);
}
ok('   the page is declared light-only', /<meta name="color-scheme" content="light">/.test(html));

console.log('\n4. T3 — accessibility preferences are honoured');
for (const q of ['prefers-reduced-motion: reduce', 'prefers-reduced-transparency: reduce', 'prefers-contrast: more']) {
    ok(`   @media (${q}) is present`, app.includes(`@media (${q})`));
}
const reduced = app.slice(app.indexOf('@media (prefers-reduced-motion: reduce)'));
ok('   reduced motion drops the slide but keeps a fade', /transform:\s*none/.test(reduced) && /transition:\s*opacity/.test(reduced));
ok('   no blanket transition:none that would make collapse a jump cut', !/\*\s*\{[^}]*transition:\s*none/.test(app));

console.log('\n5. T3 — three-column layout and collapse');
ok('   #tab-subs is an empty tab panel', /<section id="tab-subs" class="tab-panel"[^>]*><\/section>/.test(html));
ok('   #notes-column follows the document area', /<\/main>\s*(?:<!--[\s\S]*?-->\s*)?<aside id="notes-column"/.test(html));
ok('   the rail starts inert', /<nav id="rail"[^>]*\binert\b/.test(html));
const gutterPx = parseFloat(tokens['--gutter']) * (tokens['--gutter'].endsWith('rem') ? 16 : 1);
const content = declarationsFor(app, '#content-area');
ok(`   the PDF column's side padding is the gutter token (${gutterPx}px ≤ 16px)`,
    /var\(--gutter\)/.test(content.padding ?? '') && gutterPx <= 16, JSON.stringify(content));
const collapsedBody = declarationsFor(app, 'body.sidebar-collapsed');
ok('   collapsing swaps the sidebar column for the rail and widens notes',
    /--rail-size/.test(collapsedBody['--rail-w'] ?? '') && collapsedBody['--notes-w-current'] === 'var(--notes-w-wide)');
ok('   the sidebar leaves along the same axis it enters', /body\.sidebar-collapsed #sidebar\s*\{[^}]*transform:\s*translateX\(-100%\)/.test(app));
ok('   exit easing is the inverse curve of enter',
    tokens['--ease-enter'] === 'cubic-bezier(0.2, 0.8, 0.2, 1)' && tokens['--ease-exit'] === 'cubic-bezier(0.8, 0.2, 0.8, 0)');
ok('   the rail is a translucent material', /backdrop-filter/.test(JSON.stringify(declarationsFor(app, '#rail'))));
ok('   the play button swaps icons on .is-playing', declarationsFor(app, '.t-play.is-playing .icon-pause').display === 'block');

console.log('\n6. T3 — every tab has a button wired to its panel; R9/R7 — exactly Read · Subs · Summary · Settings');
const TABS = ['read', 'subs', 'summary', 'settings'];
const tabButtons = [...html.matchAll(/<button class="tab[^"]*"\s+data-tab="(\w+)"/g)].map((m) => m[1]);
ok('   the tab buttons, in order', JSON.stringify(tabButtons) === JSON.stringify(TABS), tabButtons.join(','));
ok('   no Contents or Highlights panel is left behind', !/id="tab-(contents|notes)"/.test(html));
/** The markup of one tab panel, from its opening tag to the next panel (or the sidebar's end). */
const panelHtml = (name) => {
    const from = html.indexOf(`<section id="tab-${name}"`);
    const ends = [html.indexOf('<section id="tab-', from + 1), html.indexOf('</aside>', from)].filter((i) => i > from);
    return from < 0 ? '' : html.slice(from, Math.min(...ends));
};
ok('   R2: the contents tree sits in the Read tab', /id="toc-panel"/.test(panelHtml('read')));
ok('   R2: the reading queue is gone', !/id="(sentence-feed|feed-section|feed-count)"/.test(html));
ok('   R7: Inclusions (with Rebuild) and Scrolling sit in the Settings tab',
    ['read-options', 'rebuildBtn', 'scroll-options', 'smoothScrollBox'].every((id) => panelHtml('settings').includes(`id="${id}"`)));
ok('   R7: ... and not in the Read tab', !/id="(read-options|scroll-options)"/.test(panelHtml('read')));
const TUNE_IDS = ['voiceTune', 'pitchSlider', 'exprSlider', 'bassSlider', 'trebleSlider', 'evenSlider'];
ok('   V1: "Personalise voice" and its five sliders sit in the Settings tab, under a fold-out heading',
    TUNE_IDS.every((id) => panelHtml('settings').includes(`id="${id}"`))
    && /<details id="voiceTune">\s*<summary class="label">Personalise voice<\/summary>/.test(panelHtml('settings')));
ok('   Follow is a locate crosshair, not the arrow-onto-a-line that reads as Download',
    /<symbol id="i-follow"[^>]*><circle /.test(html) && !/<symbol id="i-follow"[^>]*>[^\n]*M10 3v9\.5/.test(html));
ok('   V1: ... and not in the Read tab', !TUNE_IDS.some((id) => panelHtml('read').includes(`id="${id}"`)));
ok('   R1: no Snap button, in the sidebar or on the rail', !/id="(snapBtn|railSnapBtn)"/.test(html) && !/data-proxy="snapBtn"/.test(html));
ok('   R5: no Dev panel or Siri switch', !/id="(dev-options|siriSwitch)"/.test(html));
ok('   R5: Siri Nora is a voice, in a macOS group at the end of the voice dropdown',
    /<select id="voiceSelect"[\s\S]*<optgroup label="macOS"><option value="siri_nora">[^<]*<\/option><\/optgroup>\s*<\/select>/.test(html));
for (const tab of TABS) {
    ok(`   a "${tab}" tab button controls #tab-${tab}`,
        new RegExp(`<button class="tab[^"]*"\\s+data-tab="${tab}"[^>]*aria-controls="tab-${tab}"`).test(html)
        && new RegExp(`<section id="tab-${tab}" class="tab-panel`).test(html));
}

console.log('\n7. T3 round 2 — UI typography does not leak into the pdf.js text layer');
// pdf.js measures glyph runs untracked and scales each span to match; any inherited
// letter- or word-spacing makes spans (and the reading highlight) fall short of the words.
const INHERITED_METRICS = ['letter-spacing', 'word-spacing'];
const ANCESTORS = [':root', 'html', 'body', '#content-area', '#pdf-pages', '.pdf-page-wrap'];
const textLayer = declarationsFor(app, '.textLayer');
for (const prop of INHERITED_METRICS) {
    const setAbove = ANCESTORS.filter((sel) => declarationsFor(app, sel)[prop] !== undefined);
    ok(`   ${prop}: reset to normal on .textLayer (set above it by: ${setAbove.join(', ') || 'none'})`,
        textLayer[prop] === 'normal', String(textLayer[prop]));
}
ok('   no rule gives the text layer spans their own tracking',
    !/\.textLayer[^{]*\{[^}]*(letter|word)-spacing:(?!\s*normal)/.test(app.replace(/\/\*[\s\S]*?\*\//g, '')));

console.log('\n8. T3 — notes.css follows the tokens');
const notes = read('static/css/notes.css').replace(/:root\s*\{[^}]*\}/, '');
ok('   no hard-coded colours outside its :root block', !/#[0-9a-f]{3,6}\b|rgba?\(/i.test(notes));

console.log('\n9. T4 — the text layer is selectable inside pywebview');
// pywebview's default text_select=False injects `body { user-select: none }` (webview/js/customize.js),
// which inherits into the text layer: no selection, so no highlight toolbar and no notes.
ok('   .textLayer opts back in with user-select: text', textLayer['user-select'] === 'text', String(textLayer['user-select']));
ok('   ... and the -webkit- prefix WKWebView reads', textLayer['-webkit-user-select'] === 'text', String(textLayer['-webkit-user-select']));

console.log('\n10. T7 — the notes editor stylesheet');
const edit = read('static/css/notesedit.css');
ok('   index.html links notesedit.css', /<link rel="stylesheet" href="\/static\/css\/notesedit\.css">/.test(html));
ok('   #notes-column is still the column it renders into, and it scrolls',
    declarationsFor(app, '#notes-column')['overflow-y'] === 'auto');
ok('   the header sticks while the notes scroll', declarationsFor(edit, '.ne-head').position === 'sticky');
ok('   a block is the positioning context for the slash menu',
    declarationsFor(edit, '.ne-block').position === 'relative'
    && declarationsFor(edit, '.ne-slash').position === 'absolute');
ok('   block text wraps rather than widening the column',
    declarationsFor(edit, '.ne-text')['white-space'] === 'pre-wrap'
    && declarationsFor(edit, '.ne-text')['min-width'] === '0');
ok('   the placeholder is drawn from the element\'s own data attribute',
    /content:\s*attr\(data-placeholder\)/.test(edit));
ok('   the save state colours "saved" and "error" apart',
    declarationsFor(edit, '.ne-status[data-state="saved"]').color === 'var(--success)'
    && declarationsFor(edit, '.ne-status[data-state="error"]').color === 'var(--danger)');
ok('   no hard-coded colours: every value comes from the app.css tokens',
    !/#[0-9a-f]{3,6}\b|rgba?\(/i.test(edit.replace(/\/\*[\s\S]*?\*\//g, '')));
ok('   reduced motion is honoured here too', edit.includes('@media (prefers-reduced-motion: reduce)'));

console.log('\n11. U6 — the zoom pill');
ok('   it sits with the page pill in #view-status, which floats over the document',
    /<div id="view-status">[\s\S]*?<div id="zoom-pill" hidden>[\s\S]*?<button id="page-pill"/.test(html)
    && declarationsFor(app, '#view-status').position === 'fixed');
ok('   #page-pill no longer positions itself; the container does',
    declarationsFor(app, '#page-pill').position === undefined);
ok('   the container clears the notes column, as the page pill used to',
    /var\(--notes-current\)/.test(declarationsFor(app, '#view-status').right ?? ''));
ok('   the document area starts below the strip the cluster fills, so the pills never cover text',
    declarationsFor(app, '#content-area')['margin-top'] === 'var(--status-band)'
    && declarationsFor(app, '#view-status').top === '0'
    && declarationsFor(app, '#view-status').height === 'var(--status-band)'
    && /var\(--status-btn\)/.test(tokens['--status-band'] ?? ''));
ok('   out / level / in are the three actions, keyed by data-zoom',
    ['out', 'fit', 'in'].every((a) => new RegExp(`data-zoom="${a}"`).test(html)));
ok('   the readout says what 100% means, so "fit to width" is not a guess',
    /title="100% fits the page to the column[^"]*⌘0\)"/.test(html));
ok('   the shortcuts are on the buttons that perform them',
    /data-zoom="out"[\s\S]{0,80}title="Zoom out \(⌘−\)"/.test(html)
    && /data-zoom="in"[\s\S]{0,80}title="Zoom in \(⌘\+\)"/.test(html));
ok('   it is the same floating material as the page pill',
    /backdrop-filter/.test(JSON.stringify(declarationsFor(app, '#zoom-pill'))));
ok('   the percentage is tabular, so stepping does not jiggle the pill',
    declarationsFor(app, '.zoom-level')['font-variant-numeric'] === 'tabular-nums');
ok('   a bound step is shown as disabled rather than silently doing nothing',
    declarationsFor(app, '.zoom-btn:disabled').opacity !== undefined);
ok('   zoomed past the column, the page track grows instead of clipping the left edge',
    declarationsFor(app, '#pdf-pages')['min-width'] === 'fit-content');
// D1: `#zoom-pill { display: flex }` outranks the UA sheet's `[hidden] { display: none }`,
// so the element stayed on screen with no paper open even though `.hidden` was true.
// Every element the app ships hidden and then styles with a display of its own needs this.
const shippedHidden = [...html.matchAll(/id="([\w-]+)"[^>]*\shidden[\s>]/g)].map((m) => m[1]);
ok('   the pill is one of the elements index.html ships hidden', shippedHidden.includes('zoom-pill'), shippedHidden.join(','));
for (const id of shippedHidden) {
    const display = declarationsFor(app, `#${id}`).display;
    if (display === undefined || display === 'none') continue;
    ok(`   #${id} (display: ${display}) still honours [hidden]`,
        declarationsFor(app, `#${id}[hidden]`).display === 'none');
}
// Each query appears twice — once to restate the tokens, once to strip the chrome.
const MEDIA_BLOCK_CHARS = 600;
const underQuery = (q) => [...app.matchAll(new RegExp(`@media \\(${q}\\)`, 'g'))]
    .map((m) => app.slice(m.index, m.index + MEDIA_BLOCK_CHARS)).join('');
for (const q of ['prefers-reduced-transparency: reduce', 'prefers-contrast: more']) {
    ok(`   it drops the material under (${q}) like the rest of the chrome`, underQuery(q).includes('#zoom-pill'));
}

console.log('\n12. U7 — the notes column collapses');
const bodyRule = declarationsFor(app, 'body');
const notesCol = declarationsFor(app, '#notes-column');
ok('   the column floats like the sidebar instead of taking a slot in the flex row',
    notesCol.position === 'fixed' && notesCol.right === '0' && notesCol.width === 'var(--notes-w-current)',
    JSON.stringify(notesCol));
ok('   the document reserves its width with padding, so freeing it is one layout step',
    bodyRule['padding-right'] === 'var(--notes-current)');
ok('   ... and that reservation is the drawn width until the column is collapsed',
    bodyRule['--notes-w-current'] === 'var(--notes-w)'
    && bodyRule['--notes-current'] === 'var(--notes-w-current)');
const notesCollapsedBody = declarationsFor(app, 'body.notes-collapsed');
ok('   collapsed, it reserves nothing — in px, because the value goes into a calc()',
    notesCollapsedBody['--notes-current'] === '0px');
ok('   the notes rule comes after the sidebar rule, so both collapsed stays collapsed',
    app.indexOf('body.notes-collapsed {') > app.indexOf('body.sidebar-collapsed {'));
// declarationsFor merges the reduced-motion override in, so read the base rule itself.
const notesBaseRule = /\n#notes-column \{([^}]*)\}/.exec(app)[1];
ok('   the panel only animates transform and opacity, never its width',
    /transition:\s*transform[^;]*opacity[^;]*;/.test(notesBaseRule) && !/transition:[^;]*width/.test(notesBaseRule),
    notesBaseRule.trim());
ok('   it leaves to the right and returns from the right, on the mirrored curve',
    /body\.notes-collapsed #notes-column\s*\{[^}]*transform:\s*translateX\(100%\)/.test(app)
    && declarationsFor(app, 'body.notes-collapsed #notes-column')['transition-timing-function'] === 'var(--ease-exit)');
ok('   reduced motion cross-fades it instead, as it does the sidebar',
    /#notes-column, body\.notes-collapsed #notes-column/.test(
        app.slice(app.indexOf('@media (prefers-reduced-motion: reduce)'))));

ok('   the handle is the last thing in #view-status, against the column\'s edge',
    /<button id="page-pill"[\s\S]*?<button class="status-btn" id="notesToggleBtn"[\s\S]*?<\/div>/.test(html));
ok('   it is a real toggle: it names the column it controls and its own state',
    /id="notesToggleBtn"[\s\S]{0,200}aria-controls="notes-column"/.test(html)
    && /id="notesToggleBtn"[\s\S]{0,200}aria-expanded="true"/.test(html));
ok('   it is never shipped hidden, so there is always a way back to the notes',
    !shippedHidden.includes('notesToggleBtn'), shippedHidden.join(','));
ok('   it draws the mirrored sidebar glyph, not the sidebar\'s own',
    /<symbol id="i-notes"/.test(html) && /id="notesToggleBtn"[\s\S]{0,240}href="#i-notes"/.test(html));
const statusBtn = declarationsFor(app, '.status-btn');
ok('   it is the same floating material as the rail and the pills',
    /backdrop-filter/.test(JSON.stringify(statusBtn)) && statusBtn['border-radius'] === 'var(--radius-pill)');
ok('   its height is the token that matches the zoom pill, not a loose number',
    statusBtn.height === 'var(--status-btn)' && statusBtn.width === 'var(--status-btn)');
ok('   open reads as active, the way the rail tints its active control',
    declarationsFor(app, '.status-btn[aria-expanded="true"]').color === 'var(--accent)');
for (const q of ['prefers-reduced-transparency: reduce', 'prefers-contrast: more']) {
    ok(`   it drops the material under (${q}) like the rest of the chrome`, underQuery(q).includes('.status-btn'));
}

console.log('\n13. R4 — the audio-ready line is the status field\'s own progress');
const field = declarationsFor(app, '#status-field');
const meter = declarationsFor(app, '#bufferbar');
ok('   the field is the positioning context', field.position === 'relative', JSON.stringify(field));
ok('   the meter is drawn over the field\'s bottom edge, out of the flow, so the text never moves',
    meter.position === 'absolute' && meter.bottom !== undefined && meter['inset-inline'] !== undefined
    && meter['margin-top'] === undefined, JSON.stringify(meter));
const remPx = (v) => parseFloat(v) * (String(v).endsWith('rem') ? 16 : 1);
ok('   it is thinner than the field\'s bottom padding, so it never runs into the words',
    remPx(meter['--buffer-h']) + remPx(tokens['--hairline']) <= remPx(tokens['--space-2']),
    `${meter['--buffer-h']} + ${tokens['--hairline']} vs ${tokens['--space-2']}`);
ok('   its words are for assistive tech only: no second line in the field',
    declarationsFor(app, '.bufferbar-label').position === 'absolute'
    && declarationsFor(app, '.bufferbar-label')['clip-path'] === 'inset(50%)');
ok('   [hidden] (no script yet) beats its own display', declarationsFor(app, '#bufferbar[hidden]').display === 'none');
ok('   the rule tying it to the transport is gone', !/#transport\[hidden\]\s*\+\s*#bufferbar/.test(app));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
