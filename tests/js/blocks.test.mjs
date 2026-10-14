// Harness for the pure notes block model (T7). No DOM: every function here takes
// a block list and returns a new one.
// Run: node tests/js/blocks.test.mjs

import {
  BLOCK_TYPES,
  MAX_BLOCKS,
  MAX_BLOCK_CHARS,
  applyShortcut,
  backspaceAtStart,
  convertBlock,
  createBlock,
  ensureBlocks,
  filterCommands,
  isSlashTrigger,
  highlightQuoteBlocks,
  indexOfBlock,
  isEmptyDoc,
  markdownShortcut,
  parseBlocks,
  removeBlock,
  serializeBlocks,
  setAnchor,
  setText,
  splitBlock,
  stepSelection,
  toggleChecked,
  typeAfter,
} from '../../static/js/blocks.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x}`)); };

const doc = (...specs) => specs.map((s) => createBlock(typeof s === 'string' ? { text: s } : s));
const texts = (blocks) => blocks.map((b) => b.text);
const types = (blocks) => blocks.map((b) => b.type);

console.log('\n1. creation and normalisation');
{
  const block = createBlock();
  ok('a bare block is a paragraph', block.type === 'p' && block.text === '' && block.checked === false);
  ok('ids are unique', createBlock().id !== createBlock().id);
  ok('blocks are frozen', Object.isFrozen(block));
  ok('an unknown type falls back to a paragraph', createBlock({ type: 'marquee' }).type === 'p');
  ok('text is coerced to a string', createBlock({ text: 42 }).text === '');
  ok('text is capped', createBlock({ text: 'x'.repeat(MAX_BLOCK_CHARS + 50) }).text.length === MAX_BLOCK_CHARS);
  ok('checked is a real boolean', createBlock({ type: 'todo', checked: 'yes' }).checked === false);
  ok('every type in BLOCK_TYPES survives createBlock',
    BLOCK_TYPES.every((t) => createBlock({ type: t }).type === t));
  ok('ensureBlocks never hands back an empty document', ensureBlocks([]).length === 1);
}

console.log('\n2. parse / serialise round trip');
{
  const blocks = doc({ type: 'h1', text: 'Title' }, { type: 'todo', text: 'do it', checked: true });
  const wire = serializeBlocks(blocks);
  ok('serialised blocks carry exactly the five wire keys',
    wire.every((b) => Object.keys(b).sort().join() === 'anchor,checked,id,text,type'), JSON.stringify(wire[0]));
  const back = parseBlocks(JSON.parse(JSON.stringify(wire)));
  ok('a round trip preserves ids, types, text and checks',
    JSON.stringify(serializeBlocks(back)) === JSON.stringify(wire));
  ok('junk parses to nothing', parseBlocks(null).length === 0 && parseBlocks('nope').length === 0);
  ok('junk entries are dropped', parseBlocks([null, 5, { type: 'p', text: 'kept' }]).length === 1);
  ok('a stored bad type is repaired', parseBlocks([{ type: 'script', text: 'x' }])[0].type === 'p');
  ok('too many blocks are cut to the cap',
    parseBlocks(Array.from({ length: MAX_BLOCKS + 10 }, () => ({ text: 'x' }))).length === MAX_BLOCKS);
  const duped = parseBlocks([{ id: 'same', text: 'a' }, { id: 'same', text: 'b' }]);
  ok('a duplicate id is re-keyed', duped[0].id !== duped[1].id);
  ok('isEmptyDoc sees through whitespace', isEmptyDoc(doc('   ', '')) === true);
  ok('a divider alone counts as content', isEmptyDoc(doc({ type: 'divider' })) === false);
}

console.log('\n3. edits are immutable');
{
  const before = doc('one', 'two');
  const after = setText(before, before[1].id, 'changed');
  ok('setText returns a new list', after !== before && before[1].text === 'two' && after[1].text === 'changed');
  ok('setText on an unknown id is a no-op', setText(before, 'nope', 'x') === before);
  ok('indexOfBlock finds by id', indexOfBlock(before, before[1].id) === 1);

  const todo = doc({ type: 'todo', text: 't' });
  const checked = toggleChecked(todo, todo[0].id);
  ok('toggleChecked flips a to-do', checked[0].checked === true && todo[0].checked === false);
  ok('toggleChecked ignores a paragraph', toggleChecked(before, before[0].id) === before);

  const heading = convertBlock(before, before[0].id, 'h2');
  ok('convertBlock keeps the text and the id',
    heading[0].type === 'h2' && heading[0].text === 'one' && heading[0].id === before[0].id);
  ok('converting to a divider drops the text', convertBlock(before, before[0].id, 'divider')[0].text === '');
  ok('converting away from a to-do drops the check',
    convertBlock(checked, checked[0].id, 'p')[0].checked === false);
  ok('converting to an unknown type is a no-op', convertBlock(before, before[0].id, 'blink') === before);
  ok('removeBlock removes one', removeBlock(before, before[0].id).length === 1);
  ok('removing the last block leaves an empty paragraph',
    removeBlock(doc('only'), 'x') !== null && removeBlock(doc('only'), doc('only')[0].id).length === 1);
}

console.log('\n4. Enter splits, and lists continue');
{
  const blocks = doc('hello world');
  const split = splitBlock(blocks, blocks[0].id, 5);
  ok('the text is cut at the caret', texts(split.blocks).join('|') === 'hello| world');
  ok('the caret lands at the start of the new block', split.caret === 0 && split.focusId === split.blocks[1].id);
  const heading = doc({ type: 'h1', text: 'T' });
  ok('a heading is followed by a paragraph',
    types(splitBlock(heading, heading[0].id, 1).blocks).join() === 'h1,p' && typeAfter('h1') === 'p');
  for (const type of ['ul', 'ol', 'todo']) {
    const list = doc({ type, text: 'item' });
    const next = splitBlock(list, list[0].id, 4);
    ok(`a ${type} item continues as ${type}`, types(next.blocks).join() === `${type},${type}`);
    ok(`the continued ${type} item starts unchecked`, next.blocks[1].checked === false);
  }
  const emptyItem = doc({ type: 'ul', text: '' });
  const escaped = splitBlock(emptyItem, emptyItem[0].id, 0);
  ok('Enter on an empty list item leaves the list', escaped.blocks.length === 1 && escaped.blocks[0].type === 'p');
  const clamped = splitBlock(blocks, blocks[0].id, 999);
  ok('an out-of-range caret clamps to the end', texts(clamped.blocks).join('|') === 'hello world|');
  ok('splitting an unknown id changes nothing', splitBlock(blocks, 'nope', 0).blocks === blocks);
}

console.log('\n5. Backspace at the start converts, then merges');
{
  const typed = doc({ type: 'h2', text: 'Head' });
  const converted = backspaceAtStart(typed, typed[0].id);
  ok('a typed block becomes a paragraph, keeping its text',
    converted.blocks[0].type === 'p' && converted.blocks[0].text === 'Head' && converted.caret === 0);

  const two = doc('one', 'two');
  const merged = backspaceAtStart(two, two[1].id);
  ok('a paragraph merges into the one above', texts(merged.blocks).join() === 'onetwo');
  ok('the caret sits at the join', merged.caret === 3 && merged.focusId === merged.blocks[0].id);

  const afterRule = [...doc('above'), createBlock({ type: 'divider' }), ...doc('below')];
  const eaten = backspaceAtStart(afterRule, afterRule[2].id);
  ok('a paragraph below a divider eats the divider',
    types(eaten.blocks).join() === 'p,p' && eaten.focusId === afterRule[2].id);

  ok('the first paragraph of the document does nothing', backspaceAtStart(two, two[0].id) === null);
  ok('an unknown id does nothing', backspaceAtStart(two, 'nope') === null);
}

console.log('\n6. markdown shortcuts');
{
  const CASES = [
    ['# ', 'h1'], ['## ', 'h2'], ['### ', 'h3'], ['- ', 'ul'], ['* ', 'ul'],
    ['1. ', 'ol'], ['[] ', 'todo'], ['[ ] ', 'todo'], ['- [ ] ', 'todo'],
    ['> ', 'quote'], ['```', 'code'], ['---', 'divider'],
  ];
  for (const [prefix, type] of CASES) {
    const hit = markdownShortcut(`${prefix}rest`);
    ok(`"${prefix}" → ${type}`, hit?.type === type && hit.rest === 'rest', JSON.stringify(hit));
  }
  ok('"#" without a space is not a shortcut', markdownShortcut('#head') === null);
  ok('a prefix in the middle is not a shortcut', markdownShortcut('a # b') === null);
  ok('"## x" is a level-2 heading, not h1 with "# x" left over',
    markdownShortcut('## x')?.type === 'h2' && markdownShortcut('## x').rest === 'x');
  ok('"### x" is a level-3 heading, not h1/h2 with hashes left over',
    markdownShortcut('### x')?.type === 'h3' && markdownShortcut('### x').rest === 'x');
  const h2 = doc('## Method');
  const h3 = doc('### Setup');
  ok('applyShortcut makes "## " an h2 and "### " an h3',
    applyShortcut(h2, h2[0].id, '## Method')?.blocks[0].type === 'h2'
    && applyShortcut(h3, h3[0].id, '### Setup')?.blocks[0].text === 'Setup'
    && applyShortcut(h3, h3[0].id, '### Setup')?.blocks[0].type === 'h3');

  const blocks = doc('# Title');
  const applied = applyShortcut(blocks, blocks[0].id, '# Title');
  ok('applyShortcut converts and strips the prefix',
    applied.blocks[0].type === 'h1' && applied.blocks[0].text === 'Title');
  ok('... and leaves the caret in front of the existing text', applied.caret === 0, String(applied.caret));
  ok('applyShortcut keeps the block id', applied.focusId === blocks[0].id);
  const rule = applyShortcut(blocks, blocks[0].id, '---');
  ok('--- leaves a divider and a fresh paragraph below it',
    types(rule.blocks).join() === 'divider,p' && rule.focusId === rule.blocks[1].id);
  ok('no shortcut in plain text', applyShortcut(blocks, blocks[0].id, 'plain') === null);
  const code = doc({ type: 'code', text: '# not a heading' });
  ok('shortcuts do not fire inside a code block', applyShortcut(code, code[0].id, '# not a heading') === null);
  const already = doc({ type: 'h1', text: '# x' });
  ok('a shortcut for the type it already is does nothing', applyShortcut(already, already[0].id, '# x') === null);
}

console.log('\n7. slash-menu filtering');
{
  ok('an empty query lists every command', filterCommands('').length === 11);
  ok('"h1" finds Heading 1', filterCommands('h1')[0].id === 'h1');
  ok('a leading slash is ignored', filterCommands('/h1')[0].id === 'h1');
  ok('"head" lists the three headings first',
    filterCommands('head').slice(0, 3).map((c) => c.id).join() === 'h1,h2,h3',
    JSON.stringify(filterCommands('head').map((c) => c.id)));
  ok('"todo" finds the to-do', filterCommands('todo')[0].id === 'todo');
  ok('a keyword match works: "checkbox"', filterCommands('checkbox').map((c) => c.id).includes('todo'));
  ok('"highlight" finds the quote-highlight action',
    filterCommands('highlight')[0].action === 'quote-highlight');
  ok('case is ignored', filterCommands('QUOTE')[0].id === 'quote');
  ok('nothing matches gibberish', filterCommands('zzzz').length === 0);
  const firstFor = (query) => filterCommands(query)[0]?.id;
  const syntax = { '#': 'h1', '##': 'h2', '###': 'h3', '-': 'ul', '*': 'ul', '1.': 'ol', '[]': 'todo',
    '[ ]': 'todo', '>': 'quote', '```': 'code', '---': 'divider' };
  ok('the markdown syntax a hint shows finds its command ("/#", "/-", "/>" …)',
    Object.entries(syntax).every(([query, id]) => firstFor(query) === id),
    JSON.stringify(Object.keys(syntax).map((query) => [query, firstFor(query)])));
  ok('a partial syntax still matches: "#" lists all three headings',
    filterCommands('#').map((c) => c.id).join() === 'h1,h2,h3', JSON.stringify(filterCommands('#').map((c) => c.id)));
  ok('a trailing space is ignored: "# " is Heading 1', firstFor('# ') === 'h1');
  ok('"/" and "、" (the / key under Pinyin) open the menu', isSlashTrigger('/') && isSlashTrigger('、'));
  ok('... and other characters do not', !isSlashTrigger('\\') && !isSlashTrigger('') && !isSlashTrigger(undefined));
  ok('stepSelection wraps forwards', stepSelection(2, 1, 3) === 0);
  ok('stepSelection wraps backwards', stepSelection(0, -1, 3) === 2);
  ok('stepSelection is safe on an empty list', stepSelection(0, 1, 0) === 0);
}

console.log('\n8. quoting a highlight');
{
  const quoted = highlightQuoteBlocks({ text: '  spread   over\nlines  ', page: 7 });
  ok('the quote block holds the collapsed text and the page',
    quoted[0].type === 'quote' && quoted[0].text === 'spread over lines\n— p. 7', JSON.stringify(quoted[0]));
  ok('a paragraph follows it to carry on typing in', quoted[1].type === 'p' && quoted[1].text === '');
  ok('a highlight with no page still quotes', highlightQuoteBlocks({ text: 'x' })[0].text === 'x');
  ok('nothing to quote → null', highlightQuoteBlocks({ text: '   ' }) === null && highlightQuoteBlocks(null) === null);
}

console.log('\n9. anchors: where the note this block opens is pinned (U8)');
{
  const anchor = { page: 3, y: 0.25, hl: 'h7' };
  const blocks = doc('one', 'two');
  ok('a block is unanchored until it is pinned', blocks[0].anchor === null);
  const pinned = setAnchor(blocks, blocks[0].id, anchor);
  ok('setAnchor pins one block and returns a new list',
    pinned !== blocks && pinned[0].anchor.page === 3 && blocks[0].anchor === null);
  ok('the anchor is cleaned on the way in',
    setAnchor(blocks, blocks[0].id, { page: 2, y: 9 })[0].anchor.y === 1);
  ok('junk unpins rather than pinning to nowhere',
    setAnchor(pinned, blocks[0].id, null)[0].anchor === null);
  ok('an unknown id changes nothing', setAnchor(blocks, 'nope', anchor) === blocks);

  ok('the wire form carries the anchor',
    JSON.stringify(serializeBlocks(pinned)[0].anchor) === JSON.stringify(anchor));
  ok('... and an unanchored block says so', serializeBlocks(pinned)[1].anchor === null);
  ok('a round trip through the wire keeps the note where it was',
    parseBlocks(serializeBlocks(pinned))[0].anchor.hl === 'h7');

  const id = pinned[0].id;
  ok('re-typing the block keeps the note pinned',
    convertBlock(pinned, id, 'h2')[0].anchor.hl === 'h7');
  ok('... and so does a markdown shortcut', applyShortcut(pinned, id, '## x').blocks[0].anchor.hl === 'h7');
  ok('a divider typed in place keeps it too',
    applyShortcut(pinned, id, '--- ').blocks[0].anchor.hl === 'h7');
  ok('editing the text keeps it', setText(pinned, id, 'edited')[0].anchor.hl === 'h7');
  const split = splitBlock(pinned, id, 1);
  ok('Enter leaves the anchor on the block that opened the note',
    split.blocks[0].anchor.hl === 'h7' && split.blocks[1].anchor === null);
  const merged = backspaceAtStart(split.blocks, split.blocks[1].id);
  ok('Backspace merging back into it keeps one anchored note',
    merged.blocks[0].anchor.hl === 'h7' && merged.blocks.length === pinned.length);
}

console.log('\n10. an anchor outlives the row that carries it (U8)');
{
  const at = (page) => ({ page, y: 0.5, hl: `h${page}` });
  // Two notes: `first` pinned to page 1, `head`+`tail` pinned to page 4.
  const two = [
    createBlock({ text: 'first', anchor: at(1) }),
    createBlock({ text: 'head', anchor: at(4) }),
    createBlock({ text: 'tail' }),
  ];
  const back = backspaceAtStart(two, two[1].id);
  ok('Backspace on a note’s head merges only that row',
    texts(back.blocks).join('|') === 'firsthead|tail', texts(back.blocks).join('|'));
  ok('... and the note it headed stays pinned where it was, on the row below',
    back.blocks[1].anchor?.page === 4, JSON.stringify(back.blocks[1].anchor));
  ok('... and does not take the note above with it', back.blocks[0].anchor.page === 1);

  const alone = [createBlock({ text: 'first' }), createBlock({ text: 'only', anchor: at(4) })];
  const gone = backspaceAtStart(alone, alone[1].id);
  ok('a one-row note merged away leaves no anchor behind',
    gone.blocks.length === 1 && gone.blocks[0].anchor === null);

  const ruled = [
    ...doc('above'),
    createBlock({ type: 'divider', anchor: at(6) }),
    ...doc('below'),
  ];
  const eaten = backspaceAtStart(ruled, ruled[2].id);
  ok('a divider that opened a note hands the anchor on as it is eaten',
    eaten.blocks.length === 2 && eaten.blocks[1].anchor?.page === 6,
    JSON.stringify(eaten.blocks[1].anchor));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
