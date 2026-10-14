// A case of notes_highlight.mjs (U15), kept apart so that file stays small.
// A note made by highlighting a heading is about that heading. The highlight's top, which
// anchors the note, sits above the heading's baseline, so the Sections view (D2) must file it
// under that heading rather than the one before. Two of GR00T's: one mid-page, one at the
// very top of a page, where the section before it is on an earlier page.

const HEADINGS = ['1. Introduction', '2.3. Training Details'];
const HL_COLOR = 'yellow';
/** Where the reading position is taken (marginnotes.readingAnchor), so it is on the heading's page. */
const READING_LINE = 0.35;
const EDGE_INSET_PX = 3;
const TYPE_DELAY_MS = 12;
const PANEL_MS = 600;

/** The heading's first line of text-layer spans, scrolled to the reading line, as one box. */
const headingBox = (page, title, line) => page.evaluate(async ({ title, line }) => {
  const { state, pdfView } = window.kokoro;
  const s = state.get().sentences.find((x) => x.kind === 'heading' && String(x.raw || x.text || '').trim() === title);
  if (!s) return null;
  pdfView.scrollToPage(s.page, 'instant');
  await pdfView.renderPage(s.page);
  const spans = () => [...(pdfView.textLayerEl(s.page)?.querySelectorAll('span') || [])]
    .filter((el) => s.items.includes(pdfView.itemIndexOf(s.page, el)))
    .map((el) => el.getBoundingClientRect());
  const area = document.getElementById('content-area');
  const first = spans()[0];
  if (!first) return null;
  area.scrollBy({ top: first.top - (area.getBoundingClientRect().top + line * area.clientHeight), behavior: 'instant' });
  await new Promise((r) => setTimeout(r, 300));
  const rects = spans();
  const row = rects.filter((r) => Math.abs(r.top - rects[0].top) < rects[0].height / 2);
  return { page: s.page, left: Math.min(...row.map((r) => r.left)), right: Math.max(...row.map((r) => r.right)),
    y: row[0].top + row[0].height / 2 };
}, { title, line });

/** The Sections-view heading written above the note that says `text`. */
const sectionAbove = (page, text) => page.evaluate((needle) => {
  let el = [...document.querySelectorAll('#notes-column .ne-note')].find((n) => n.textContent.includes(needle));
  while (el && !el.classList.contains('ne-section')) el = el.previousElementSibling;
  return el ? el.textContent : null;
}, text);

/**
 * @param {import('playwright').Page} page
 * @param {{check:Function, drag:Function, settleMs:number}} t  helpers from notes_highlight.mjs
 */
export async function headingNoteCase(page, { check, drag, settleMs }) {
  console.log('\nA note made on a heading is filed under that heading in the Sections view (U15)');
  const made = [];
  for (const title of HEADINGS) {
    const box = await headingBox(page, title, READING_LINE);
    check(`"${title}" is on screen to highlight`, Boolean(box), 'no heading or span');
    if (!box) continue;
    await drag(page, { x: box.left + EDGE_INSET_PX, y: box.y }, { x: box.right - EDGE_INSET_PX, y: box.y });
    const toolbar = Boolean(await page.$('.hl-toolbar.is-open'));
    check(`dragging over "${title}" opens the highlight toolbar`, toolbar, JSON.stringify(box));
    if (!toolbar) continue;
    await page.click(`.hl-toolbar.is-open .hl-swatch[data-color="${HL_COLOR}"]`);
    await page.waitForTimeout(settleMs);

    // A click on the empty column beside the heading opens a row there (margin_notes case 11).
    const column = await page.$eval('#notes-column .ne-doc', (el) => el.getBoundingClientRect().toJSON());
    await page.mouse.click(column.left + column.width / 2, column.top + column.height / 2);
    await page.waitForTimeout(settleMs);
    const note = `about the heading ${title}`;
    await page.keyboard.type(note, { delay: TYPE_DELAY_MS });
    await page.waitForTimeout(settleMs);
    const anchor = await page.evaluate((n) => window.kokoro.state.get().blocks
      .find((b) => String(b.text).includes(n))?.anchor ?? null, note);
    check(`the note about "${title}" is pinned to that highlight, on page ${box.page}`,
      anchor?.page === box.page && Boolean(anchor?.hl), JSON.stringify(anchor));
    made.push({ title, note });
  }

  await page.click('#notes-view [data-view="sections"]');
  await page.waitForTimeout(PANEL_MS);
  for (const { title, note } of made) {
    const above = await sectionAbove(page, note);
    check(`in the Sections view it is under "${title}"`, above === title, `under ${JSON.stringify(above)}`);
  }
  await page.click('#notes-view [data-view="margin"]');
  await page.waitForTimeout(PANEL_MS);
}
