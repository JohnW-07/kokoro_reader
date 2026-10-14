// Regression harness for the two reproduced notes-loss bugs.
// Run: node tests/js/notesync.test.mjs

import { createNoteSync, recordPayload } from '../../static/js/notesync.js';
import { createBlock } from '../../static/js/blocks.js';

let passed = 0;
let failed = 0;
function ok(label, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS   ${label}`); }
    else { failed++; console.log(`  FAIL   ${label} ${detail}`); }
}

/** A deterministic stand-in for setTimeout: nothing fires until `run()` is called. */
function fakeClock() {
    const pending = new Map();
    let next = 1;
    return {
        setTimer(fn) { pending.set(next, fn); return next++; },
        clearTimer(id) { pending.delete(id); },
        async run() {
            const fns = [...pending.values()];
            pending.clear();
            for (const fn of fns) await fn();
        },
        get size() { return pending.size; },
    };
}

function harness(initialState) {
    const clock = fakeClock();
    const writes = [];
    const errors = [];
    const statuses = [];
    let state = initialState;
    const sync = createNoteSync({
        write: async (s) => {
            if (s.failWrite) throw new Error('disk full');
            // Exactly what main.js sends: the whole record, built from live state.
            writes.push({ docId: s.docId, highlights: s.highlights, record: recordPayload(s) });
        },
        getState: () => state,
        onError: (e) => errors.push(e),
        onStatus: (kind) => statuses.push(kind),
        debounceMs: 600,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });
    return {
        sync, clock, writes, errors, statuses,
        setState: (patch) => { state = { ...state, ...patch }; },
    };
}

const DOC_A = 'a'.repeat(40);
const DOC_B = 'b'.repeat(40);

// ── 1. The happy path still writes ───────────────────────────────────────────
console.log('\n1. a bound document saves normally');
{
    const h = harness({ docId: DOC_A, highlights: [{ id: 'h1' }] });
    h.sync.bind(DOC_A);
    h.sync.schedule();
    await h.clock.run();
    ok('one write, for the bound document', h.writes.length === 1 && h.writes[0].docId === DOC_A,
        JSON.stringify(h.writes));
    ok('the highlights that were in state', h.writes[0].highlights.length === 1);
}

// ── 2. CRITICAL: a timer armed on doc A must not write onto doc B ────────────
console.log('\n2. a save armed on document A never lands on document B');
{
    const h = harness({ docId: DOC_A, highlights: [{ id: 'h1' }, { id: 'h2' }] });
    h.sync.bind(DOC_A);
    h.sync.schedule();                         // user edits a note...
    h.sync.reset();                            // ...then opens another document
    h.setState({ docId: DOC_B, highlights: [] });
    await h.clock.run();
    ok('no timer survived the document switch', h.clock.size === 0);
    ok('nothing was written', h.writes.length === 0, JSON.stringify(h.writes));
}

// A reset that is *forgotten* must still be caught by the id check.
console.log('\n   ...and the id check catches it even without reset()');
{
    const h = harness({ docId: DOC_A, highlights: [{ id: 'h1' }] });
    h.sync.bind(DOC_A);
    h.sync.schedule();
    h.setState({ docId: DOC_B, highlights: [] });   // no reset() on purpose
    await h.clock.run();
    ok('the stale timer wrote nothing', h.writes.length === 0, JSON.stringify(h.writes));
}

// ── 3. CRITICAL: a failed load must disable saving, not empty the file ───────
console.log('\n3. a document whose notes failed to load is never written');
{
    const h = harness({ docId: DOC_A, highlights: [] });
    // loadNotesFor() threw, so bind() was never reached.
    h.sync.schedule();                         // onIndex(0) -> idx % 5 === 0 -> scheduleSave()
    await h.clock.run();
    ok('nothing bound', h.sync.boundDocId() === null);
    ok('nothing was written', h.writes.length === 0, JSON.stringify(h.writes));
    ok('an immediate flush is refused too', (await h.sync.flush()) === false);
}

// ── 4. flush() semantics ─────────────────────────────────────────────────────
console.log('\n4. flush');
{
    const h = harness({ docId: DOC_A, highlights: [] });
    h.sync.bind(DOC_A);
    ok('returns true when it wrote', (await h.sync.flush()) === true);
    h.sync.schedule();
    await h.sync.flush();
    ok('flush consumes the pending timer (no double write)', h.clock.size === 0);
    await h.clock.run();
    ok('exactly two writes total', h.writes.length === 2, String(h.writes.length));
}

console.log('\n5. a write failure is reported, never swallowed');
{
    const h = harness({ docId: DOC_A, highlights: [], failWrite: true });
    h.sync.bind(DOC_A);
    const wrote = await h.sync.flush();
    ok('flush reports failure', wrote === false);
    ok('onError was called once', h.errors.length === 1, String(h.errors.length));
}

console.log('\n6. missing docId');
{
    const h = harness({ docId: null, highlights: [] });
    h.sync.bind(DOC_A);
    ok('no docId in state -> no write', (await h.sync.flush()) === false);
}

// ── 7. T7: the notes editor and the position save share one record ───────────
// A PUT replaces the whole record. Before `recordPayload`, each writer built its
// own copy of it, so whichever fired last erased the other's field.
console.log('\n7. an editor save and a position save cannot clobber each other');
{
    const note = createBlock({ text: 'the estimator is biased' });
    const h = harness({
        docId: DOC_A, docName: 'paper.pdf', highlights: [], index: 0,
        options: { use_llm: false }, blocks: [note],
    });
    h.sync.bind(DOC_A);

    // The user types a note; playback then advances and asks for a position save
    // before the editor's debounce has fired.
    h.sync.schedule();
    h.setState({ index: 42 });
    h.sync.schedule();
    await h.clock.run();

    const record = h.writes.at(-1)?.record;
    ok('the position save did not erase the note',
        record?.blocks.length === 1 && record.blocks[0].text === 'the estimator is biased',
        JSON.stringify(record?.blocks));
    ok('...and the note save did not erase the position', record?.last_index === 42, String(record?.last_index));

    // The other way round: a highlight arrives while an editor save is pending.
    h.sync.schedule();
    h.setState({ highlights: [{ id: 'h9', page: 3, text: 'quoted' }] });
    h.setState({ blocks: [note, createBlock({ type: 'todo', text: 'reread §4' })] });
    await h.clock.run();

    const second = h.writes.at(-1).record;
    ok('the editor save carried the new highlight', second.highlights.length === 1, JSON.stringify(second.highlights));
    ok('...and both blocks', second.blocks.length === 2 && second.blocks[1].type === 'todo');
    ok('every write is a complete record',
        ['doc_id', 'title', 'highlights', 'last_index', 'options', 'blocks']
            .every((key) => key in second), Object.keys(second).join());
    ok('blocks go out in wire form, not as live objects',
        Object.keys(second.blocks[0]).sort().join() === 'anchor,checked,id,text,type',
        JSON.stringify(second.blocks[0]));
}

console.log('\n8. the save state is reported');
{
    const h = harness({ docId: DOC_A, highlights: [], blocks: [] });
    h.sync.bind(DOC_A);
    h.sync.schedule();
    ok('scheduling says "saving"', h.statuses.join() === 'saving', h.statuses.join());
    await h.clock.run();
    ok('a completed write says "saved"', h.statuses.at(-1) === 'saved', h.statuses.join());

    const broken = harness({ docId: DOC_A, highlights: [], blocks: [], failWrite: true });
    broken.sync.bind(DOC_A);
    await broken.sync.flush();
    ok('a failed write says "error"', broken.statuses.at(-1) === 'error', broken.statuses.join());

    const unbound = harness({ docId: DOC_A, highlights: [], blocks: [] });
    unbound.sync.schedule();
    ok('an unbound document never claims to be saving', unbound.statuses.length === 0, unbound.statuses.join());
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
