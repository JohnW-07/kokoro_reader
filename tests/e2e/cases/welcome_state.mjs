// Case 0 of notes_collapse.mjs (U11 / D3), kept apart so that file stays small.
// Before a paper is open the window says one thing: drop a paper here. The transport (and its
// rail twins) and the contents (R2: where the reading queue was) have nothing to act on, so they are not drawn at all — not
// merely disabled — and they come back the moment a paper opens, without shifting what sits
// above them. The notes column's Margin | Sections switch has nothing to lay out either, so it
// waits for the paper too, and the header it sits in keeps its height. Also: no MLX pill; the
// Highlights list heads the notes column instead of being a sidebar tab (R3), without widening
// it; and the audio-ready line in the status field (R4) waits for a script.

const PX_TOLERANCE = 1;
const RAIL_TWINS = ['railPpBtn', 'railPrevBtn', 'railNextBtn', 'railFollowBtn'];

/** What the case asserts, measured from the rendered page. */
const chrome = (page) => page.evaluate((twins) => {
  const byId = (id) => document.getElementById(id);
  const drawn = (el) => Boolean(el) && el.getClientRects().length > 0;
  const top = (el) => el?.getBoundingClientRect().top ?? null;
  return {
    pills: document.querySelectorAll('#app-title .pill').length,
    sidebarText: byId('sidebar').innerText,
    panelTitle: document.querySelector('#notes-panel .nt-head .label')?.textContent ?? null,
    columnName: byId('notes-column').getAttribute('aria-label'),
    highlightsFirst: byId('notes-column').firstElementChild?.id === 'notes-panel',
    columnOverflow: byId('notes-column').scrollWidth - byId('notes-column').clientWidth,
    meterDrawn: drawn(byId('bufferbar')),
    transportDrawn: drawn(byId('transport')),
    transportButtons: [...document.querySelectorAll('#transport .t-btn')].map(drawn),
    twinsHidden: twins.map((id) => byId(id)?.hidden === true),
    contentsDrawn: drawn(byId('toc-section')),
    playEnabled: byId('ppBtn')?.disabled === false,
    voiceTop: top(byId('voiceSelect')),
    speedTop: top(byId('speedSlider')),
    switchDrawn: drawn(byId('notes-view')),
    notesHeadHeight: document.querySelector('#notes-column .ne-head')?.getBoundingClientRect().height ?? null,
  };
}, RAIL_TWINS);

/**
 * @param {import('playwright').Page} page
 * @param {object} t  the helpers notes_collapse.mjs runs every case with
 */
export async function welcomeCase(page, { check, openPaper, baseUrl, shotDir, engine, join }) {
  console.log('\n0. the welcome state, and the chrome a paper brings with it');
  await page.goto(baseUrl);
  await page.waitForFunction(() => Boolean(window.kokoro));
  const welcome = await chrome(page);
  check('there is no MLX pill', welcome.pills === 0 && !welcome.sidebarText.includes('MLX'),
    JSON.stringify({ pills: welcome.pills }));
  const tab = (name) => page.getByRole('tab', { name, exact: true }).count();
  check('the sidebar has no Highlights tab (R3)', (await tab('Highlights')) === 0 && (await tab('Notes')) === 0,
    JSON.stringify({ highlights: await tab('Highlights'), notes: await tab('Notes') }));
  check('... the list heads the notes column, titled "Highlights"', welcome.highlightsFirst && welcome.panelTitle === 'Highlights',
    JSON.stringify({ first: welcome.highlightsFirst, title: welcome.panelTitle }));
  check('with no script the audio-ready line is not drawn (R4)', !welcome.meterDrawn);
  check('the margin notes column is still called "Notes"', welcome.columnName === 'Notes', welcome.columnName);
  check('with no paper the transport is not drawn at all (not merely disabled)',
    !welcome.transportDrawn && welcome.transportButtons.every((d) => !d), JSON.stringify(welcome.transportButtons));
  check('... nor are its rail twins', welcome.twinsHidden.every(Boolean), JSON.stringify(welcome.twinsHidden));
  check('... nor the empty contents', !welcome.contentsDrawn);
  check('... nor the notes column\'s Margin | Sections switch', !welcome.switchDrawn);
  await page.screenshot({ path: join(shotDir, `welcome-${engine}.png`) });

  await openPaper(page);
  const open = await chrome(page);
  check('with a paper open the transport is drawn, and enabled',
    open.transportDrawn && open.transportButtons.every(Boolean) && open.playEnabled,
    JSON.stringify({ drawn: open.transportButtons, play: open.playEnabled }));
  check('... and so are its rail twins', open.twinsHidden.every((h) => !h), JSON.stringify(open.twinsHidden));
  check('... and the contents', open.contentsDrawn);
  check('... and the audio-ready line in the status field', open.meterDrawn);
  check('the Highlights list does not widen the notes column', open.columnOverflow <= 0,
    JSON.stringify({ overflow: open.columnOverflow }));
  check('nothing above the transport moved when it appeared',
    Math.abs(open.voiceTop - welcome.voiceTop) <= PX_TOLERANCE && Math.abs(open.speedTop - welcome.speedTop) <= PX_TOLERANCE,
    JSON.stringify({ voice: [welcome.voiceTop, open.voiceTop], speed: [welcome.speedTop, open.speedTop] }));
  check('with a paper open the switch is drawn', open.switchDrawn);
  check('... and the notes header kept its height', open.notesHeadHeight !== null
    && Math.abs(open.notesHeadHeight - welcome.notesHeadHeight) <= PX_TOLERANCE,
    JSON.stringify({ welcome: welcome.notesHeadHeight, open: open.notesHeadHeight }));
  const view = () => page.evaluate(() => window.kokoro.state.get().notesView);
  await page.getByRole('radio', { name: 'Sections', exact: true }).click();
  const picked = await view();
  await page.getByRole('radio', { name: 'Margin', exact: true }).click();
  check('... and it works: a click on "Sections" switches, and "Margin" switches back',
    picked === 'sections' && (await view()) === 'margin', JSON.stringify({ picked, now: await view() }));
  console.log(`  (measured) notes header ${welcome.notesHeadHeight?.toFixed(1)}px on welcome, ${open.notesHeadHeight?.toFixed(1)}px with a paper`);
  await page.screenshot({ path: join(shotDir, `opened-${engine}.png`) });
}
