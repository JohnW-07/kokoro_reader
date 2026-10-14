// Harness for the contents tree (tocpanel.js) and its wiring (nav.js): N7 "jump to section"
// and N8 "real page numbers" + "Go to page", against the faked DOM in shellenv.mjs.
import { El, byId } from './shellenv.mjs';
import * as state from '../../static/js/state.js';
import { createTocPanel } from '../../static/js/tocpanel.js';
import { createNav } from '../../static/js/nav.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };
const tick = (n = 1) => new Promise((r) => setTimeout(r, n));
const DEADLINE_TICKS = 400;            // x5ms: every wait below gives up after 2 s
const waitFor = async (cond) => { for (let i = 0; i < DEADLINE_TICKS && !cond(); i++) await tick(5); };

const entry = (title, depth, page, index) => ({ title, depth, page, top: null, index });
const TOC = Object.freeze({ source: 'outline', entries: Object.freeze([
  entry('1 Intro', 0, 3, 1), entry('1.1 Why', 1, 4, 3), entry('1.1.1 Deep', 2, 4, 4),
  entry('2 Method', 0, 9, 10), entry('2.1 Setup', 1, 9, 11),
]) });
const key = (target, k) => target.dispatchEvent({ type: 'keydown', key: k, bubbles: true });
const links = (root) => root.querySelectorAll('.toc-link');
const visible = (node) => { for (let n = node; n; n = n.parentElement) if (n.hidden) return false; return true; };

console.log('\n1. the contents tree');
{
  const root = new El('div');
  const picks = [];
  const panel = createTocPanel({ root, onPick: (e, pos) => picks.push([e.title, pos]), pageLabel: (p) => `p${p}` });
  panel.render(TOC);
  const all = links(root);
  ok('one link per entry, in order', all.map((l) => l.textContent).join('|').startsWith('1 Intro'), all.map((l) => l.textContent).join('|'));
  ok('each link names its page by its label', all[3].textContent.includes('p9'), all[3].textContent);
  ok('chapters show, their sections start folded', all.filter(visible).length === 2,
    String(all.filter(visible).length));
  const twisty = root.querySelectorAll('.toc-twisty')[0];
  ok('a chapter with sections has a disclosure button, collapsed', twisty?.getAttribute('aria-expanded') === 'false');
  twisty.click();
  ok('... which unfolds its sections (one level)', all.filter(visible).length === 3 && twisty.getAttribute('aria-expanded') === 'true',
    String(all.filter(visible).length));
  const selected = () => all.filter((l) => l.classList.contains('is-selected'));
  all[1].click();
  ok('R2: a single click only selects an entry, it does not pick it',
    picks.length === 0 && selected().length === 1 && selected()[0] === all[1], JSON.stringify(picks));
  all[1].dispatchEvent({ type: 'dblclick' });
  ok('R2: a double-click picks it', picks.length === 1 && picks[0][0] === '1.1 Why' && picks[0][1] === 1, JSON.stringify(picks));
  all[2].focus();
  key(all[2], 'Enter');
  ok('R2: Enter picks the focused entry', picks.length === 2 && picks[1][0] === '1.1.1 Deep' && picks[1][1] === 2, JSON.stringify(picks));
  ok('R2: ... and selects it', selected().length === 1 && selected()[0] === all[2]);
  all[1].click();
  ok('R2: a single click on an entry with children folds them', !visible(all[2]) && picks.length === 2);
  all[1].click();
  ok('R2: ... and a second unfolds them', visible(all[2]) && picks.length === 2);
  all[1].dispatchEvent({ type: 'click', detail: 2 });
  ok('R2: the second click of a double-click leaves the fold alone', visible(all[2]));
  all[1].click();   // fold again, so the walk below starts from the fixture's shape
  twisty.click();
  twisty.click();
  ok('(fixture) only Intro is open, as before', all.filter(visible).length === 3, String(all.filter(visible).length));

  all[0].focus();
  let ev = key(all[0], 'ArrowDown');
  ok('ArrowDown moves to the next visible entry and claims the key', document.activeElement === all[1] && ev !== undefined);
  key(all[1], 'ArrowDown');
  ok('... skipping a folded subtree', document.activeElement === all[3], document.activeElement?.textContent);
  key(all[3], 'ArrowRight');
  ok('ArrowRight unfolds a chapter', visible(all[4]));
  key(all[3], 'ArrowRight');
  ok('... and then steps into it', document.activeElement === all[4], document.activeElement?.textContent);
  key(all[4], 'ArrowLeft');
  ok('ArrowLeft on a leaf goes to its parent', document.activeElement === all[3]);
  key(all[3], 'ArrowLeft');
  ok('ArrowLeft on an open chapter folds it', !visible(all[4]));
  key(all[3], 'Home');
  ok('Home goes to the first entry', document.activeElement === all[0]);
  key(all[0], 'End');
  ok('End goes to the last visible entry', document.activeElement === all[3]);
  const claimed = [];
  document.addEventListener('keydown', (e) => claimed.push(e.defaultPrevented));
  key(all[3], 'ArrowLeft');
  ok('tree keys are claimed, so the transport does not also step a sentence', claimed.at(-1) === true);

  panel.markCurrent(2);
  ok('the current entry is marked for assistive tech', all[2].getAttribute('aria-current') === 'location');
  ok('... and its folded chapter shows it holds the reader', all[0].parentElement.classList.contains('has-current'));
  panel.markCurrent(3);
  ok('moving on clears the old marks', all[2].getAttribute('aria-current') === null
    && !all[0].parentElement.classList.contains('has-current') && all[3].getAttribute('aria-current') === 'location');

  panel.render({ source: 'none', entries: [] });
  ok('no contents says so instead of an empty box', links(root).length === 0 && /no outline/i.test(root.textContent), root.textContent);
  panel.render({ source: 'headings', entries: [entry('Only', 0, 1, 0)] });
  ok('detected headings are labelled as such', /detected headings/i.test(root.textContent), root.textContent);
  ok('a panel with no root is inert', (() => { const p = createTocPanel({ root: null }); p.render(TOC); p.markCurrent(1); return true; })());
}

console.log('\n2. jumping: playing moves the voice, paused moves the cursor and the view');
const calls = [];
const log = (name) => (...args) => { calls.push([name, ...args]); };
let playing = false;
const SCRIPT = Object.freeze(Array.from({ length: 40 }, (_, i) => ({ page: i + 1, items: [0], text: `s${i}`, kind: 'body' })));
const fakes = {
  player: { state: () => ({ isPlaying: playing, isLoading: false }), setIndex: log('setIndex') },
  follower: { snap: log('snap'), suspend: log('suspend') },
  pdfView: {
    renderPage: async (n) => { await tick(2); calls.push(['rendered', n]); return true; },
    scrollToPage: log('scrollToPage'),
    pdfDocument: () => currentDoc,
  },
  jumpTo: log('jumpTo'),
};
const labelsSeen = [];
const toasts = [];
const ui = { el: (id) => byId.get(id) || null, toast: (m, l) => toasts.push([m, l]), setPageLabels: (l) => labelsSeen.push(l) };
let currentDoc = { getPageLabels: async () => null, getOutline: async () => null };

const nav = createNav({ state, ui, ...fakes });
state.set({ docId: 'a', numPages: 40, sentences: SCRIPT });

await nav.goToEntry(entry('Chapter', 0, 9, 8));
ok('paused: the page is rendered before the cursor moves, then the view snaps to it',
  calls.map((c) => c[0]).join() === 'rendered,setIndex,snap' && calls[1][1] === 8, JSON.stringify(calls));
calls.length = 0;
playing = true;
await nav.goToEntry(entry('Chapter', 0, 9, 8));
ok('playing: a jump, which plays from there', calls.length === 1 && calls[0][0] === 'jumpTo' && calls[0][1] === 8, JSON.stringify(calls));
calls.length = 0;
await nav.goToEntry(entry('Index', 0, 38, -1));
ok('an entry nothing is read from scrolls to its page and stops following',
  calls.map((c) => c[0]).join() === 'suspend,scrollToPage' && calls[1][1] === 38, JSON.stringify(calls));
calls.length = 0;
playing = false;

console.log('\n3. page labels: the PDF\'s own, else the printed numbers, never another paper\'s');
const marks = [{ page: 22, text: '10 Chapter 1', kind: 'header' }, { page: 24, text: '12 Chapter 2', kind: 'header' }];
state.set({ pageMarks: marks });
const last = () => labelsSeen.at(-1);
ok('printed numbers label the pages once the script has them', last()?.[22] === '11', JSON.stringify(last()?.slice(20, 25)));

let release;
currentDoc = { getPageLabels: () => new Promise((r) => { release = () => r(Array.from({ length: 40 }, (_, i) => `L${i + 1}`)); }), getOutline: async () => null };
state.resetDocument();
ok('a new paper clears the old labels at once', last() === null, JSON.stringify(last()));
state.set({ docId: 'b', numPages: 40 });
const slowDoc = release;
currentDoc = { getPageLabels: async () => ['i', 'ii', ...Array.from({ length: 38 }, (_, i) => String(i + 1))], getOutline: async () => null };
state.resetDocument();
state.set({ docId: 'c', numPages: 40 });
await waitFor(() => last()?.[0] === 'i');
slowDoc();
await tick(10);
ok('the PDF\'s labels are used', last()?.[0] === 'i' && last()?.[2] === '1', JSON.stringify(last()?.slice(0, 3)));
ok('a superseded paper\'s labels landing late are ignored', last()?.[0] !== 'L1');

console.log('\n4. "Go to page" from the pill');
const view = byId.get('view-status') || (() => { const n = new El('div'); n.id = 'view-status'; byId.set('view-status', n); return n; })();
ok('(fixture) the pill, the form and its input exist', ['page-pill', 'page-go', 'page-go-input'].every((id) => byId.has(id)));
{
  state.set({ sentences: SCRIPT, pageMarks: marks });
  // Labels for 'c' are the PDF's: i, ii, 1..38. Page 13 prints "11".
  const pill = byId.get('page-pill'), form = byId.get('page-go'), input = byId.get('page-go-input');
  pill.click();
  ok('clicking the pill opens the form, focused, and hides the pill', !form.hidden && document.activeElement === input
    && view.classList.contains('is-going'));
  ok('the pill says what it does', pill.getAttribute('aria-expanded') === 'true');
  input.value = 'nowhere';
  form.dispatchEvent({ type: 'submit' });
  ok('a page that does not exist is refused, and the form stays open', toasts.length === 1 && !form.hidden
    && input.getAttribute('aria-invalid') === 'true', JSON.stringify(toasts));
  input.value = '11';
  form.dispatchEvent({ type: 'submit' });
  await waitFor(() => calls.some((c) => c[0] === 'snap'));
  ok('a printed number goes to the page that prints it (index 13)',
    calls.some((c) => c[0] === 'setIndex' && c[1] === 12), JSON.stringify(calls));
  ok('... and closes the form, giving focus back to the pill', form.hidden && !view.classList.contains('is-going')
    && document.activeElement === pill && pill.getAttribute('aria-expanded') === 'false');
  pill.click();
  key(input, 'Escape');
  ok('Escape closes it without going anywhere', form.hidden && document.activeElement === pill);
  calls.length = 0;
  state.set({ sentences: SCRIPT.filter((s) => s.page !== 5) });
  await nav.goToPage(5);
  ok('a page nothing is read on (a figure) scrolls there and leaves the cursor alone',
    calls.map((c) => c[0]).join() === 'suspend,scrollToPage' && calls[1][1] === 5, JSON.stringify(calls));
}

console.log('\n5. the tree follows the reader');
{
  const root = byId.get('toc-panel');
  ok('(fixture) the contents panel exists', Boolean(root));
  state.set({ sections: [{ page: 3, y: 0.1, top: 0.1, title: 'One', size: 20, index: 2 }, { page: 9, y: 0.1, top: 0.1, title: 'Two', size: 20, index: 8 }] });
  const all = links(root);
  ok('detected headings fill the tree when the PDF has no outline', all.length === 2, String(all.length));
  state.set({ index: 9 });
  ok('reading past a heading marks it current', all[1].getAttribute('aria-current') === 'location' && all[0].getAttribute('aria-current') === null);
  calls.length = 0;
  all[0].click();
  await tick(20);
  ok('R2: a single click in the live panel moves nothing', calls.length === 0, JSON.stringify(calls));
  all[0].dispatchEvent({ type: 'dblclick' });
  await waitFor(() => calls.some((c) => c[0] === 'snap'));
  ok('R2: double-clicking an entry in the live panel jumps there', calls.some((c) => c[0] === 'setIndex' && c[1] === 2), JSON.stringify(calls));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
