// Case 11 of notes_collapse.mjs (U11 / D3), kept apart so that file stays small.
// The notes column is laid out in the margin or by section. The control that picks it is a
// two-option switch, "Margin | Sections", that shows the current view instead of naming the
// one it would go to: a radiogroup, one tab stop, arrows (or Space/Enter on an option) to
// switch, persisted, inert with the column put away, and no bigger than the header it sits in.

const PX_TOLERANCE = 1;
const MAX_TABS = 4;              // from the notes handle, the switch is the next stop or close to it
const SHOT_PAD_PX = 8;
// Window widths from the app's minimum up: the column sits at its 15rem floor to ~1090px.
const FIT_WIDTHS = [960, 1024, 1100, 1200, 1440];
const SHOT_WIDTHS = new Set([960, 1024]);
// The save readout's states as noteseditor.js's setStatus writes them (text, data-state).
const STATUSES = [['idle', ''], ['saving', 'Saving…'], ['saved', 'Saved'], ['error', 'Not saved']];

/** The switch, as the page and its accessibility tree describe it. */
const read = (page) => page.evaluate(() => {
  const group = document.getElementById('notes-view');
  const radios = group ? [...group.querySelectorAll('[role="radio"]')] : [];
  const active = document.activeElement;
  return {
    role: group?.getAttribute('role') ?? null,
    label: group?.getAttribute('aria-label') ?? null,
    radios: radios.map((r) => ({
      view: r.dataset.view, text: r.textContent, checked: r.getAttribute('aria-checked'), tab: r.tabIndex,
      bg: getComputedStyle(r).backgroundColor,
    })),
    focused: group?.contains(active) ? active.dataset.view : null,
    state: window.kokoro.state.get().notesView,
    sections: document.querySelector('#notes-column .ne-panel')?.classList.contains('is-sections') === true,
    index: window.kokoro.state.get().index,
    playing: document.getElementById('ppBtn').classList.contains('is-playing'),
  };
});

const current = (s) => s.radios.find((r) => r.checked === 'true')?.view ?? null;
/** Page, state, markup and accessibility tree all agree that `view` is the one shown. */
async function shows(page, view) {
  const s = await read(page);
  const checked = await page.getByRole('radio', { name: view === 'margin' ? 'Margin' : 'Sections', exact: true }).isChecked();
  return { ok: current(s) === view && s.state === view && s.sections === (view === 'sections') && checked
    && s.radios.filter((r) => r.checked === 'true').length === 1, s };
}

/** Header geometry: its height with and without the switch, and whether all of it fits on one row. */
const headShape = (page) => page.evaluate(() => {
  const head = document.querySelector('#notes-column .ne-head');
  const group = document.getElementById('notes-view');
  const title = head.querySelector('.ne-heading');
  const withIt = head.getBoundingClientRect().height;
  group.style.display = 'none';
  const without = head.getBoundingClientRect().height;
  group.style.display = '';
  const h = head.getBoundingClientRect();
  const g = group.getBoundingClientRect();
  const t = title.getBoundingClientRect();
  const padRight = parseFloat(getComputedStyle(head).paddingRight);
  return { withIt, without, fits: g.right <= h.right - padRight + 1 && g.top >= h.top && g.bottom <= h.bottom
    && g.top < t.bottom && g.bottom > t.top, head: h.toJSON(), group: g.toJSON() };
});

async function headShot(page, path) {
  const box = await page.$eval('#notes-column .ne-head', (el) => el.getBoundingClientRect().toJSON());
  await page.screenshot({ path, clip: {
    x: Math.max(0, box.x - SHOT_PAD_PX), y: 0, width: box.width + SHOT_PAD_PX, height: box.bottom + SHOT_PAD_PX,
  } });
}

/**
 * @param {import('playwright').Page} page
 * @param {object} t  the helpers notes_collapse.mjs runs every case with
 */
export async function viewSwitchCase(page, { check, openPaper, toggle, prefs, viewport, settleMs, shotDir, engine, join }) {
  console.log('\n11. the Margin | Sections switch shows the view it is in');
  const must = (name, cond, detail) => { check(name, cond, detail); if (!cond) throw new Error(`precondition failed: ${name}`); };
  const start = await read(page);
  must('it is a radiogroup of two options, "Margin" and "Sections"', start.role === 'radiogroup'
    && start.radios.map((r) => r.text).join('|') === 'Margin|Sections', JSON.stringify(start));
  check('it has a name of its own', Boolean(start.label), JSON.stringify(start.label));
  check('the margin view is shown as the current one', (await shows(page, 'margin')).ok, JSON.stringify(start));
  check('the current option looks selected: its fill differs from the other one',
    start.radios[0].bg !== start.radios[1].bg, JSON.stringify(start.radios.map((r) => r.bg)));
  check('one tab stop: the current option', start.radios.map((r) => r.tab).join(',') === '0,-1',
    JSON.stringify(start.radios.map((r) => r.tab)));
  const shape = await headShape(page);
  console.log(`  (measured) header ${shape.withIt.toFixed(1)}px with the switch, ${shape.without.toFixed(1)}px without; switch ${shape.group.width.toFixed(1)}×${shape.group.height.toFixed(1)}px`);
  check('the switch costs the header no height', Math.abs(shape.withIt - shape.without) <= PX_TOLERANCE, JSON.stringify(shape));
  check('... and sits on the heading\'s row, inside the header', shape.fits, JSON.stringify(shape));
  await headShot(page, join(shotDir, `notes-head-${engine}.png`));

  await page.getByRole('radio', { name: 'Sections', exact: true }).click();
  await page.waitForTimeout(settleMs);
  check('a click on "Sections" switches to it, and says so', (await shows(page, 'sections')).ok, JSON.stringify(await read(page)));
  check('... and the choice is saved', (await prefs(page)).notesView === 'sections');
  await headShot(page, join(shotDir, `notes-head-sections-${engine}.png`));
  await page.getByRole('radio', { name: 'Margin', exact: true }).click();
  await page.waitForTimeout(settleMs);
  check('a click on "Margin" switches back', (await shows(page, 'margin')).ok, JSON.stringify(await read(page)));

  // The keyboard. Arrows and Space are also the player's keys: here they belong to the switch.
  // R3: the Highlights section sits above the notes in the same column, so its stops come first.
  const highlightStops = await page.$$eval('#notes-panel :is(button, input, select, textarea, a[href], [tabindex="0"])',
    (els) => els.filter((el) => !el.disabled && el.getClientRects().length > 0).length);
  await page.focus('#notesToggleBtn');
  let tabs = 0;
  while (tabs < MAX_TABS + highlightStops && (await read(page)).focused === null) {
    await page.keyboard.press('Tab');
    tabs += 1;
  }
  const reached = await read(page);
  check(`Tab reaches the switch, on its current option (${tabs} Tab from the notes handle, ${highlightStops} in Highlights)`,
    reached.focused === 'margin', JSON.stringify({ tabs, focused: reached.focused }));
  for (const [key, view] of [['ArrowRight', 'sections'], ['ArrowLeft', 'margin'], ['ArrowDown', 'sections'], ['ArrowUp', 'margin']]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(settleMs);
    const { ok, s } = await shows(page, view);
    check(`${key} switches to ${view}, and focus follows`, ok && s.focused === view, JSON.stringify({ view: current(s), focused: s.focused }));
  }
  const player = await read(page);
  check('... without the arrows reaching the player', player.index === start.index && !player.playing,
    JSON.stringify({ index: [start.index, player.index], playing: player.playing }));
  for (const [key, view] of [['Space', 'sections'], ['Enter', 'margin']]) {
    await page.focus(`#notes-view [data-view="${view}"]`);
    await page.keyboard.press(key);
    await page.waitForTimeout(settleMs);
    const { ok, s } = await shows(page, view);
    check(`${key} on the other option switches to it`, ok, JSON.stringify({ view: current(s) }));
  }
  check('... and Space did not start the reading', !(await read(page)).playing);

  // It persists, and comes back shown as current.
  await page.getByRole('radio', { name: 'Sections', exact: true }).click();
  await page.waitForTimeout(settleMs);
  await openPaper(page);
  check('after a reload the switch still shows "Sections" as current', (await shows(page, 'sections')).ok,
    JSON.stringify(await read(page)));
  check('... and its tab stop moved with it', (await read(page)).radios.map((r) => r.tab).join(',') === '-1,0');
  await page.getByRole('radio', { name: 'Margin', exact: true }).click();
  await page.waitForTimeout(settleMs);

  // Put away with the column: out of reach, and just as it was when the column returns.
  await toggle(page);
  const away = await page.evaluate(() => ({ inert: document.getElementById('notes-column').inert,
    insideInert: document.getElementById('notes-view')?.closest('[inert]') !== null }));
  check('with the column collapsed the switch is inert, out of the tab order', away.inert && away.insideInert, JSON.stringify(away));
  await page.focus('#notesToggleBtn');
  await page.keyboard.press('Tab');
  check('... Tab from the handle does not land on it', (await read(page)).focused === null);
  await toggle(page);
  check('expanded again, it still shows "Margin"', (await shows(page, 'margin')).ok);

  // Every width from the app's minimum, with every save state showing: the header fits on one
  // row, the switch holds still while the state changes, and the state is still on screen.
  for (const width of FIT_WIDTHS) {
    await page.setViewportSize({ width, height: viewport.height });
    await page.waitForTimeout(settleMs);
    const rows = [];
    for (const [kind, text] of STATUSES) {
      rows.push({ kind, ...(await statusFit(page, kind, text)) });
      if (!SHOT_WIDTHS.has(width)) continue;
      await page.waitForTimeout(settleMs);   // the state's colour eases in
      await headShot(page, join(shotDir, `notes-head-${width}-${kind}-${engine}.png`));
    }
    const xs = rows.map((r) => r.switchX);
    console.log(`  (measured) ${width}px: head ${rows[0].client}px; ${rows.map((r) => `${r.kind} scroll ${r.scroll} x ${r.switchX.toFixed(1)} h ${r.height.toFixed(1)} mark ${r.markW.toFixed(1)}`).join('; ')}`);
    check(`at ${width}px no save state makes the header overflow or clip the switch`,
      rows.every((r) => r.scroll <= r.client && r.fits), JSON.stringify(rows));
    check(`... the switch does not move as the state changes (x ${Math.min(...xs).toFixed(1)}–${Math.max(...xs).toFixed(1)})`,
      Math.max(...xs) - Math.min(...xs) <= PX_TOLERANCE);
    check('... nothing wraps: the header keeps its idle height',
      rows.every((r) => Math.abs(r.height - rows[0].height) <= PX_TOLERANCE), JSON.stringify(rows.map((r) => r.height)));
    check('... and each state is drawn, and says what it is to a screen reader',
      rows.every((r) => r.kind === 'idle' || (r.markW > 0 && r.word === STATUSES.find(([k]) => k === r.kind)[1])),
      JSON.stringify(rows.map((r) => [r.kind, r.markW, r.word])));
  }
  await statusFit(page, 'idle', '');
  await page.setViewportSize(viewport);
  await page.waitForTimeout(settleMs);
}

/** Show a save state the way setStatus does, and measure the header with it showing. */
const statusFit = (page, kind, text) => page.evaluate(([k, t]) => {
  const status = document.getElementById('notes-save-state');
  status.textContent = t;
  status.dataset.state = t ? k : 'idle';
  const head = document.querySelector('#notes-column .ne-head');
  const h = head.getBoundingClientRect();
  const g = document.getElementById('notes-view').getBoundingClientRect();
  const padRight = parseFloat(getComputedStyle(head).paddingRight);
  return { scroll: head.scrollWidth, client: head.clientWidth, height: h.height, switchX: g.x,
    fits: g.right <= h.right - padRight + 1 && g.bottom <= h.bottom,
    markW: status.getBoundingClientRect().width, word: status.textContent };
}, [kind, text]);
