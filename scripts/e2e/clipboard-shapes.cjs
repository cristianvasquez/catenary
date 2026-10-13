// Browser scenarios of the clipboard (copy, cut, paste) and of the shapes view.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, root, withApp, navigator, navNode, rdfRows } = require('./harness.cjs');

// The custom type of a canvas clip in the asynchronous Clipboard API (modeler clip-transport.ts VIEW_CLIP_WEB_TYPE).
const CLIP_TYPE = 'web application/x-catenary-view-clip';

/**
 * Record the system clipboard calls of the page (diagnostics), and hold `navigator.clipboard.write` while `window.__clipHold` is set:
 * the scenario then controls when a canvas copy completes. Each headless Chromium has its own clipboard, so parallel runs do not
 * share it (checked with two browsers and distinct payloads, kata 812s).
 */
const recordClipboard = page => page.evaluate(() => {
  const c = navigator.clipboard, write = c.write.bind(c), writeText = c.writeText.bind(c), t0 = performance.now();
  const log = window.__clipLog = [], note = m => log.push(`${Math.round(performance.now() - t0)} ${m}`);
  window.__clipHold = undefined;
  window.__clipHeld = 0;
  c.write = async items => {
    note(`write ${items.map(i => i.types.join('+')).join(', ')}`);
    if (window.__clipHold) { window.__clipHeld++; note('write held'); await window.__clipHold; note('write released'); }
    return write(items).then(() => note('write done'), e => { note(`write rejected: ${e}`); throw e; });
  };
  c.writeText = text => {
    note(`writeText ${text.slice(0, 40)}`);
    return writeText(text).then(() => note('writeText done'), e => { note(`writeText rejected: ${e}`); throw e; });
  };
});

test('browser: raw RDF paste, graph consent, Copy as RDF, reference paste, and cut mark', { timeout: 60000 }, t => withApp(t, 'clipboard', {
  fixture: workspace => fs.writeFileSync(path.join(workspace, 'workspace.trig'), `@prefix ws: <https://cristianvasquez.github.io/catenary/vocab/workspace#> .
    <urn:name:workspace> { <urn:name:workspace> a ws:Workspace; ws:placeInstances "data.ttl" . }`),
  page: { viewport: { width: 1600, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] },
  ready: '#theia-main-content-panel'
}, async ({ page, cli, workspace, waitUntil }) => {
  cli('rpc', 'open', JSON.stringify(path.join(workspace, 'workspace.trig')));
  const created = cli('exec', JSON.stringify({ kind: 'createView', label: 'Clipboard' })).result;
  assert.equal(created.ok, true);
  const view = created.id;
  cli('eval', `await ctx.editors.open(${JSON.stringify(view)}); return true`);
  const canvas = page.locator('svg.sprotty-graph:visible');
  await canvas.waitFor();
  await recordClipboard(page);
  const clipLog = () => page.evaluate(() => window.__clipLog.slice(-12)).catch(e => [`(no log: ${e.message})`]);
  const card = name => canvas.locator('g.card').filter({ has: page.locator('.card-name', { hasText: new RegExp('^' + name + '$') }) });
  const boxes = () => cli('rpc', 'view', JSON.stringify(view)).result.boxes;

  // The clipboard as one ClipboardItem: text/plain and the clip token of the same item (null: the type is absent).
  const readClip = () => page.evaluate(async type => {
    const [item] = await navigator.clipboard.read();
    const get = async t => item?.types.includes(t) ? (await item.getType(t)).text() : null;
    return { types: item ? [...item.types] : [], text: await get('text/plain'), token: await get(type) };
  }, CLIP_TYPE);
  const clipWait = async (description, until) => {
    try { return await waitUntil(description, readClip, until); }
    catch (e) { throw new Error(`${e.message}\nClipboard calls: ${(await clipLog()).join(' | ')}`); }
  };
  // A known clipboard before each copy: a later state with a token is the state of that copy.
  let baselines = 0;
  const baseline = async () => {
    const text = `catenary e2e baseline ${++baselines}`;
    await page.evaluate(text => navigator.clipboard.writeText(text), text);
    await clipWait(`the clipboard holds "${text}"`, c => c.text === text && c.token === null);
    return text;
  };
  // A copy or cut of the canvas is complete when the clipboard holds a token that no earlier operation wrote (the system write runs
  // after the clip is stored, diagram-configuration.ts writeSystemClipboard).
  const tokens = new Set();
  const newClip = async what => {
    const clip = await clipWait(`the clipboard holds the Turtle and a new clip token of ${what}`, c => c.token !== null && !tokens.has(c.token));
    tokens.add(clip.token);
    return clip;
  };

  // Notifications of the window (CLI bridge, one entry for each message, also when Theia shows one toast): the acknowledgement of an
  // operation that has no other visible result. `since` is the sequence number before the gesture.
  const lastMessage = () => cli('messages').at(-1)?.seq ?? 0;
  const acknowledged = (since, text) => waitUntil(`a notification "${text}" after message ${since}`,
    () => cli('messages', '--since', String(since)), messages => messages.some(m => m.text === text));
  const notice = text => page.locator('.theia-notification-list-item', { hasText: text }).first().waitFor();

  // Keyboard commands go to the canvas only when the base div of the view editor contains the focus (ViewCopyPasteHandler.hasFocus).
  const canvasFocus = what => waitUntil(`the canvas has the keyboard focus (${what})`,
    () => page.evaluate(() => {
      const a = document.activeElement;
      return a?.closest('.sprotty') ? 'canvas' : `${a?.tagName}#${a?.id}.${a?.className}`;
    }), state => state === 'canvas');
  const select = async name => {
    await card(name).click();
    await card(name).and(canvas.locator('g.card.selected')).waitFor();
    await canvasFocus(`${name} selected`);
  };
  const paste = async text => {
    await canvas.click({ position: { x: 60, y: 70 } });
    await page.evaluate(text => navigator.clipboard.writeText(text), text);
    await canvasFocus('before Ctrl+V');
    await page.keyboard.press('Control+V');
  };

  const ttl = '<urn:clipboard:alice> a <urn:Person>; <http://www.w3.org/2000/01/rdf-schema#label> "Alice" .';
  let since = lastMessage();
  await paste(ttl);
  await card('Alice').waitFor();
  const before = boxes()[0];
  // Copy as RDF: the export replaces the baseline.
  const exportBaseline = await baseline();
  await card('Alice').click({ button: 'right' });
  await page.getByText('Copy as RDF', { exact: true }).last().click();
  const exported = (await clipWait('the clipboard holds the export of Copy as RDF', c => c.text !== null && c.text !== exportBaseline)).text;
  assert.ok(exported.includes('urn:clipboard:alice'), 'selection writes model RDF to the system clipboard');
  assert.ok(!exported.includes('view:') && !exported.includes('rdf:reifies'), 'export excludes placement metadata');
  since = lastMessage();
  await paste(exported);
  await acknowledged(since, 'RDF added; no new figures in this canvas.');
  assert.equal(boxes().length, 1, 'raw RDF preserves resource identity');

  // A paste places the same elements (ui-manifest §5.8): Ctrl+C, Ctrl+V in the same canvas places nothing and says so.
  // The system clipboard of a copy (§5.8 transport): the Turtle in text/plain, the clip token in the custom type, in one item.
  // The system write of the copy is held first: until it completes, the clipboard has no clip token of this copy.
  await baseline();
  await select('Alice');
  await page.evaluate(() => { window.__clipHold = new Promise(resolve => { window.__clipRelease = resolve; }); });
  await page.keyboard.press('Control+C');
  await waitUntil('the system write of the copy waits', () => page.evaluate(() => window.__clipHeld), n => n === 1);
  assert.equal((await readClip()).token, null, 'no clip token before the system write of the copy completes');
  await page.evaluate(() => { window.__clipHold = undefined; window.__clipRelease(); });
  const copied = await newClip('Ctrl+C');
  assert.ok(copied.text?.includes('urn:clipboard:alice') && !copied.text.includes('clipboardId'),
    `text/plain holds the Turtle of the copy: ${JSON.stringify(copied)}; clipboard calls: ${(await clipLog()).join(' | ')}`);
  assert.equal(typeof JSON.parse(copied.token).clipboardId, 'string', 'the custom type holds the clip token');
  since = lastMessage();
  await canvasFocus('before Ctrl+V');
  await page.keyboard.press('Control+V');
  await acknowledged(since, 'Placed 0. Skipped 1 already in this view.');
  await notice('Placed 0. Skipped 1 already in this view.');
  assert.deepEqual(boxes(), [before], 'a copy and paste in the same view changes nothing');
  assert.deepEqual(await readClip(), copied, `the clipboard keeps the copy after the paste; clipboard calls: ${(await clipLog()).join(' | ')}`);

  // Ctrl+X marks and dims the placement and changes nothing. Escape clears the mark.
  await baseline();
  await select('Alice');
  since = lastMessage();
  await page.keyboard.press('Control+X');
  await acknowledged(since, '1 element cut. Paste moves it. Escape cancels.');
  await notice('1 element cut. Paste moves it. Escape cancels.');
  await canvas.locator('.cut-marked').first().waitFor();
  await newClip('the first Ctrl+X');
  assert.deepEqual(boxes(), [before], 'a cut alone changes nothing');
  await canvasFocus('before Escape');
  await page.keyboard.press('Escape');
  await canvas.locator('.cut-marked').first().waitFor({ state: 'detached' });
  // A paste of the cut clip moves the element, here within the view to the pointer, and clears the mark.
  await baseline();
  await select('Alice');
  await page.keyboard.press('Control+X');
  await canvas.locator('.cut-marked').first().waitFor();
  const cut = await newClip('the second Ctrl+X');
  await canvas.click({ position: { x: 500, y: 400 } });
  await canvasFocus('before the paste of the cut');
  since = lastMessage();
  await page.keyboard.press('Control+V');
  await acknowledged(since, 'Placed 1.');
  await notice('Placed 1.');
  await canvas.locator('.cut-marked').first().waitFor({ state: 'detached' });
  const moved = boxes();
  assert.equal(moved.length, 1, 'the move keeps one placement');
  assert.notDeepEqual([moved[0].x, moved[0].y], [before.x, before.y], 'the move places the card at the pointer');
  // A JSON-LD property can match the ID of the live internal clip and still be raw RDF.
  const token = JSON.parse(cut.token);
  const jsonld = JSON.stringify({ '@context': { name: 'http://www.w3.org/2000/01/rdf-schema#label', clipboardId: 'urn:clipboard:identifier' },
    '@id': 'urn:clipboard:jsonld', '@type': 'urn:Person', name: 'JSON-LD', clipboardId: token.clipboardId });
  await paste(jsonld);
  await card('JSON-LD').waitFor();
  assert.equal(boxes().length, 2, 'JSON-LD is parsed even with a live clipboardId property');
  // External clipboard content must replace the internal canvas clip, including Paste from the Edit command.
  const bob = '<urn:clipboard:bob> a <urn:Person>; <http://www.w3.org/2000/01/rdf-schema#label> "Bob" .';
  await page.evaluate(text => navigator.clipboard.writeText(text), bob);
  assert.equal(cli('run', 'core.paste').status, 'done', 'Edit > Paste completes');
  await card('Bob').waitFor();
  const named = '<urn:source:graph> { <urn:clipboard:carol> a <urn:Person>; <http://www.w3.org/2000/01/rdf-schema#label> "Carol" . }';
  const beforeGraph = cli('rpc', 'view', JSON.stringify(view)).result;
  await paste(named);
  await page.getByRole('button', { name: 'Flatten and paste', exact: true }).waitFor();
  assert.deepEqual(cli('rpc', 'view', JSON.stringify(view)).result, beforeGraph, 'confirmation precedes all edits');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Flatten and paste', exact: true }).waitFor({ state: 'detached' });
  assert.deepEqual(cli('rpc', 'view', JSON.stringify(view)).result, beforeGraph, 'Cancel leaves the model unchanged');
  await paste(named);
  await page.getByRole('button', { name: 'Flatten and paste', exact: true }).click();
  await card('Carol').waitFor();
  assert.equal(cli('run', 'catenary.undo').status, 'done', 'Undo completes');
  await card('Carol').waitFor({ state: 'detached' });
  assert.deepEqual(cli('rpc', 'view', JSON.stringify(view)).result, beforeGraph, 'one undo restores the previous canvas');
}));

test('browser: shapes view → rows, + attribute, value picker, SKOS scheme and concepts, rows as edges, logical constraint, data migration → save', { timeout: 90000 }, t => withApp(t, 'shapes', {
  fixture: workspace => {
    const fixtures = path.join(root, 'packages/rdf/test/fixtures');
    for (const [from, to] of [['dcat-workspace.trig', 'workspace.trig'], ['dcat-data.ttl', 'data.ttl'], ['dcat-shapes.ttl', 'shapes.ttl']]) {
      fs.copyFileSync(path.join(fixtures, from), path.join(workspace, to));
    }
    fs.cpSync(path.join(fixtures, 'dcat-views'), path.join(workspace, 'dcat-views'), { recursive: true });
  },
  page: { viewport: { width: 1700, height: 1000 } },
  defaultTimeout: 8000,
  gotoTimeout: 15000,
  ready: null
}, async ({ page, cli, dir, workspace, logs, errors, waitUntil }) => {
  const main = page.locator('#theia-main-content-panel');
  // An edit is applied when the window has a model revision after the revision before its gesture (ModelFrontend snapshot).
  const revision = () => cli('eval', 'return ctx.model.snapshot.revision');
  const applied = (from, what) => waitUntil(`${what}: the window has a model revision after ${from}`, revision, r => r > from);
  // Keyboard commands go to the canvas when the view editor of the main area contains the focus.
  const canvasFocus = what => waitUntil(`the canvas has the keyboard focus (${what})`, () => page.evaluate(() => {
    const a = document.activeElement;
    return a?.closest('#theia-main-content-panel .sprotty') ? 'canvas' : `${a?.tagName}#${a?.id}.${a?.className}`;
  }), state => state === 'canvas');
  const center = async loc => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const card = name => main.locator('.shape-card:visible').filter({ has: page.locator('.shape-name', { hasText: name }) });
  const edge = text => main.locator('.catenary-edge.property:visible').filter({ has: page.locator('.edge-label', { hasText: text }) });
  const row = (cardName, text) => card(cardName).locator('.shape-row').filter({ has: page.locator('.row-path', { hasText: text }) });
  const valueSet = name => main.locator('.valueset-card:visible').filter({ has: page.locator('.vs-name', { hasText: name }) });

  await navigator(page, 'dcat-views');
  const viewNode = navNode(page, 'catalog-shapes.view.trig').first();
  await viewNode.waitFor({ timeout: 20000 });
  await viewNode.dblclick();
  await card('Data asset').waitFor({ timeout: 15000 });
  // Properties are rows, as members of a collection (a scheme target too). Lines: the two members of sh:or, drawn by its hub
  // placement (ADR 0014). The palette is the GLSP palette bar of the data views: no floating palette.
  assert.equal(await card('Data asset').locator('.shape-row').count(), 7);
  assert.equal(await main.locator('.catenary-edge.property:visible').count(), 2);
  assert.equal(await main.locator('.catenary-logic:visible').count(), 1);
  assert.equal(await page.locator('.shape-palette').count(), 0);
  await main.locator('.tool-palette .tool-button', { hasText: /^[A-Z]?Scheme$/ }).waitFor();
  const g = await center(main.locator('.sprotty-graph'));
  const viewport = () => main.locator('.sprotty-graph:visible > g').first().getAttribute('transform');
  const unscrolled = await viewport();
  await page.mouse.move(g.x, g.y);
  await page.mouse.wheel(0, 60);
  await waitUntil('the wheel changes the canvas viewport', viewport, t => t !== unscrolled);
  const inline = page.locator('.catenary-embedded-input, .catenary-inline-input');
  const type = async (text, key = 'Enter') => {
    await inline.waitFor();
    await inline.fill(text);
    await inline.press(key);
  };
  const picker = page.locator('.catenary-popup-picker');

  // Double-click on the node shape name: the name is typed in the card. The GLSP redraw after the double-click must not close the input.
  let r = revision();
  await card('Catalogue').locator('.shape-name').dblclick();
  await page.locator('input.catenary-name-input').fill('Catalogue shape');
  await page.locator('input.catenary-name-input').press('Enter');
  await main.locator('.shape-card:visible .shape-name', { hasText: /^Catalogue shape$/ }).waitFor();
  await page.locator('input.catenary-name-input').waitFor({ state: 'hidden' });
  await applied(r, 'rename of the node shape');

  // Link button of a node shape dragged to empty canvas: "+ New node shape" creates "unnamed shape 1" and the edge "unnamed property 1";
  // no path is asked. One undo step removes both.
  await card('Software agent').locator('.shape-name').click();
  const link = main.locator('.catenary-halo .halo-action[data-action="link"]:visible');
  await link.waitFor();
  const from = await center(link);
  const empty = await page.evaluate(({ x, y }) => {
    // A point of the canvas background (the graph svg itself), with no element within 40 px.
    const bare = (px, py) => [[0, 0], [40, 0], [-40, 0], [0, 40], [0, -40]].every(([a, b]) => document.elementFromPoint(px + a, py + b)?.matches('svg.sprotty-graph'));
    for (let dy = -300; dy <= 300; dy += 50) for (const dx of [-250, -400, -150, 250, 400]) {
      if (bare(x + dx, y + dy)) return { x: x + dx, y: y + dy };
    }
    return undefined;
  }, from);
  assert.ok(empty, 'An empty canvas point near the link button');
  r = revision();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(empty.x, empty.y, { steps: 10 });
  await page.mouse.up();
  await picker.locator('.list > .item').filter({ hasText: /^\+ New node shape$/ }).click();
  await card('unnamed shape 1').waitFor();
  await edge('unnamed property 1').waitFor();
  await applied(r, 'link drag to a new node shape');
  assert.equal(await inline.count(), 0, 'No path input after the link drag');
  await page.locator('#theia-main-content-panel .lm-TabBar-tab', { hasText: 'Catalog shapes' }).click();
  await canvasFocus('before Ctrl+Z');
  r = revision();
  await page.keyboard.press('Control+z');
  await card('unnamed shape 1').waitFor({ state: 'detached' });
  await applied(r, 'undo of the link drag');
  assert.equal(await edge('unnamed property 1').count(), 0);

  // Click on a cardinality of a row: 1..* -> 0..*.
  r = revision();
  await row('Catalogue', 'dataset').locator('.row-card').click();
  await row('Catalogue', 'dataset').locator('.row-card', { hasText: '0..*' }).waitFor();
  await applied(r, 'cardinality click');

  // A property shape is one selection in the canvas and the Model explorer: Open in… → Model on a row selects its tree row; a click on
  // the tree row shows it in Properties.
  const menuItem = label => page.locator('.lm-Menu .lm-Menu-itemLabel', { hasText: label }).first();
  const propsTitle = text => page.locator('.catenary-props .catenary-head .title:visible', { hasText: new RegExp(`^${text}$`) });
  const fileModel = 'catenary-file-explorer:' + path.join(workspace, 'shapes.ttl');
  const modelTab = page.locator(`[id=${JSON.stringify('shell-tab-' + fileModel)}]`);
  const canvasTab = main.locator('.lm-TabBar-tab').filter({ hasText: /^Catalog shapes$/ });
  const treeRow = name => page.locator(`[id=${JSON.stringify(fileModel)}] .theia-TreeNode`)
    .filter({ has: page.locator('.catenary-tree-name', { hasText: new RegExp(`^${name}$`) }) });
  await row('Catalogue', 'dataset').locator('.row-path').click();
  await row('Catalogue', 'dataset').locator('.row-path').click({ button: 'right' });
  await menuItem('Open in…').click();
  // Source and Model (the canvas is the current pane). The property shape has one row: under its node shape in Shapes. One path, no picker.
  await page.locator('.quick-input-list .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: /^Model$/ }) }).click();
  await treeRow('dcat:dataset').and(page.locator('.theia-mod-selected')).waitFor();
  await canvasTab.click();
  await card('Software agent').locator('.shape-name').click();
  await propsTitle('Software agent').waitFor();
  await modelTab.click();
  await treeRow('dcat:dataset').locator('.catenary-tree-name').click();
  await propsTitle('dcat:dataset').waitFor();
  assert.equal(await page.locator('.theia-property-view-widget', { hasText: 'No properties available' }).count(), 0);

  // A row is a property shape: a click selects it (Properties), also with the focus in the Model explorer (the step above): the click
  // gives the focus to the canvas. Double-click on its path: typed in place.
  await canvasTab.click();
  await row('Data asset', 'issued').locator('.row-path').click();
  await page.locator('.catenary-props .catenary-head .title', { hasText: 'dct:issued' }).waitFor();
  await row('Data asset', 'issued').locator('.row-path').dblclick();
  r = revision();
  await type('dct:created');
  await row('Data asset', 'created').waitFor();
  await applied(r, 'path typed in place');

  // "+ attribute": Enter adds xsd:string and opens the next one; Tab picks the value.
  r = revision();
  await card('Software agent').locator('.shape-add-row').click();
  await type('foaf:name');
  await row('Software agent', 'name').locator('.row-range', { hasText: 'xsd:string' }).waitFor();
  await type('foaf:mbox', 'Tab');
  await picker.waitFor();
  await picker.locator('input').fill('anyURI');
  await picker.locator('input').press('Enter');
  await row('Software agent', 'mbox').locator('.row-range', { hasText: 'xsd:anyURI' }).waitFor();
  await applied(r, '+ attribute');

  // The value picker creates a concept scheme from typed text: its card joins the view, the property stays a row. Concepts: "+ concept", rename.
  r = revision();
  await card('Linguistic system').locator('.shape-add-row').click();
  await type('dct:subject', 'Tab');
  await picker.waitFor();
  await picker.locator('input').fill('Topics');
  await picker.locator('.list > *', { hasText: 'New concept scheme "Topics"' }).click();
  await valueSet('Topics').waitFor();
  await row('Linguistic system', 'subject').locator('.row-range', { hasText: /^→ Topics$/ }).waitFor();
  await applied(r, 'new concept scheme from the value picker');
  r = revision();
  await valueSet('Topics').locator('.member-add').click();
  await type('Economy');
  await valueSet('Topics').locator('.member-row', { hasText: 'Economy' }).waitFor();
  await type('Health');
  await valueSet('Topics').locator('.member-row', { hasText: 'Health' }).waitFor();
  await inline.press('Escape');
  await valueSet('Topics').locator('.member-row', { hasText: 'Health' }).dblclick();
  await type('Public health');
  await valueSet('Topics').locator('.member-row', { hasText: 'Public health' }).waitFor();
  await applied(r, 'concepts added and renamed');

  // A concept drag adds skos:broader without moving the value set card.
  const child = valueSet('Topics').locator('.member-row', { hasText: 'Public health' });
  const parent = valueSet('Topics').locator('.member-row', { hasText: 'Economy' });
  const childAt = await center(child), parentAt = await center(parent);
  await page.mouse.move(childAt.x, childAt.y);
  await page.mouse.down();
  await page.mouse.move(parentAt.x, parentAt.y, { steps: 10 });
  await page.mouse.up();
  await child.and(page.locator('[title*="Broader: Economy"]')).waitFor();

  // Properties: a successful add clears the field; a later blur must not add it again.
  const setAt = await center(valueSet('Topics').locator('.vs-kind'));
  await page.mouse.click(setAt.x, setAt.y);
  const addConcept = page.locator('.catenary-props input[placeholder="+ concept"]');
  await addConcept.fill('Environment');
  await addConcept.press('Enter');
  await valueSet('Topics').locator('.member-row', { hasText: 'Environment' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.catenary-props input[placeholder="+ concept"]')?.value === '');
  await addConcept.focus();
  await addConcept.press('Tab');
  assert.equal(await valueSet('Topics').locator('.member-row', { hasText: 'Environment' }).count(), 1);

  // ⇥ ejects a property; its return arrow restores the row (also for edges to visible cards).
  r = revision();
  await row('Data asset', 'language').hover();
  await row('Data asset', 'language').locator('.row-out').click();
  await edge('language').waitFor();
  assert.equal(await row('Data asset', 'language').count(), 0);
  await edge('language').locator('.row-in').click();
  await row('Data asset', 'language').waitFor();
  await row('Data asset', 'language').locator('.row-out').click();
  await edge('language').waitFor();
  // A member line of a hub has a return arrow too: it returns the hub unit (the members become a row group).
  assert.equal(await edge('keyword').locator('.row-in').count(), 1, 'A hub member line has a return arrow');
  // A scheme target: ⇥ shows the scheme card with its concepts, once; the return arrow restores the row. The theme stays an edge.
  await row('Data asset', 'theme').locator('.row-out').click();
  await edge('theme').waitFor();
  assert.equal(await valueSet('Product domain').count(), 1, 'One scheme card');
  assert.ok(await valueSet('Product domain').locator('.member-row').count() > 0, 'The scheme card lists its concepts');
  await edge('theme').locator('.row-in').click();
  await row('Data asset', 'theme').waitFor();
  await row('Data asset', 'theme').locator('.row-out').click();
  await edge('theme').waitFor();
  await applied(r, 'eject and return of rows');
  // A row dragged out of its card: a line, its end box at the drop point when the view does not show it (ADR 0014: the box that a line
  // brings leaves with its last line). The datatype row stays a row: a datatype end is private, it shows only in a hub.
  for (const selector of ['.row-path', '.row-range']) {
    const source = row('Catalogue', 'dataset');
    const from = await center(source.locator(selector));
    const drop = { x: from.x, y: from.y + 250 };
    r = revision();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(drop.x, drop.y, { steps: 10 });
    await page.mouse.up();
    await edge('dataset').waitFor();
    await applied(r, `drag of the row ${selector} out of its card`);
    assert.equal(await picker.count(), 0, 'Dragging the value does not open its picker');
    r = revision();
    if (selector === '.row-path') await edge('dataset').locator('.row-in').click();
    else {
      await edge('dataset').locator('.edge-label').click();
      await page.keyboard.press('Delete');
    }
    await row('Catalogue', 'dataset').waitFor();
    await applied(r, `return of the row after the ${selector} drag`);
  }
  await row('Catalogue', 'title').locator('.row-out').click();
  await page.locator('.theia-notification-list-item', { hasText: 'datatype' }).first().waitFor();
  assert.equal(await edge('title').count(), 0, 'A datatype row stays a row');
  await row('Catalogue', 'title').waitFor();

  // Logic handle of a selected edge dragged to another edge of the same shape: a second sh:or.
  r = revision();
  await edge('language').locator('.edge-label').click();
  const handle = edge('language').locator('.logic-handle');
  await handle.waitFor();
  const h = await center(handle), target = await center(edge('theme').locator('.edge-label'));
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y + 2, { steps: 8 });
  await page.mouse.up();
  await main.locator('.catenary-logic:visible').nth(1).waitFor();
  await applied(r, 'second sh:or from the logic handle');

  // "+ target" handle of a selected edge dragged to a card: one more target, the edge goes to a "one of" box.
  const orCards = await main.locator('.catenary-one-of').count();
  r = revision();
  await row('Catalogue', 'dataset').locator('.row-out').click();
  await edge('dataset').waitFor();
  await edge('dataset').locator('.edge-label').click();
  const plus = edge('dataset').locator('.target-handle');
  await plus.waitFor();
  const p0 = await center(plus), dropOn = await center(card('Software agent').locator('.shape-name'));
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  await page.mouse.move(dropOn.x, dropOn.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(n => document.querySelectorAll('#theia-main-content-panel .catenary-one-of').length > n, orCards);
  await applied(r, '"+ target" drag to a card');
  // The "one of" box is a member-list box: the alternative whose card is shown is a line from the box; selected, it has eight
  // resize handles and the remove button of its halo.
  await main.locator('.catenary-alternative').first().waitFor();
  await main.locator('.catenary-one-of > .body').first().click({ position: { x: 6, y: 6 } });
  await page.waitForFunction(() => document.querySelectorAll('#theia-main-content-panel .catenary-one-of .catenary-resize-handle').length === 8);
  assert.equal(await main.locator('.catenary-halo .halo-action').count(), 1, 'One-of halo: Remove only');
  // Undo: one step; the "one of" box goes, the later steps keep their layout.
  await main.locator('.sprotty-graph').click({ position: { x: 20, y: 600 } });
  await canvasFocus('before Ctrl+Z of the "one of" box');
  r = revision();
  await page.keyboard.press('Control+z');
  await page.waitForFunction(n => document.querySelectorAll('#theia-main-content-panel .catenary-one-of').length === n, orCards);
  await applied(r, 'undo of the "+ target" drag');
  r = revision();
  await edge('dataset').locator('.row-in').click();
  await row('Catalogue', 'dataset').waitFor();
  await applied(r, 'return of the dataset row');

  // Path rename in Properties: the data migration is offered and applied.
  await row('Data asset', 'title').locator('.row-path').click();
  await page.locator('.catenary-props .catenary-head .title', { hasText: 'dct:title' }).waitFor();
  const pathInput = page.locator('.catenary-props .catenary-row', { hasText: 'Path' }).locator('input');
  r = revision();
  await pathInput.fill('dct:alternative');
  await pathInput.press('Enter');
  await page.locator('.theia-notification-list-item button', { hasText: 'Apply to data' }).first().click();
  await page.locator('.theia-notification-list-item', { hasText: 'Data changed' }).first().waitFor();
  await applied(r, 'path rename with data migration');

  // Palette creations open the name editor without F2.
  let paletteY = 100;
  for (const [tool, label, created] of [['Scheme', 'Palette scheme', valueSet], ['Shape', 'Palette shape', card]]) {
    // Text: the key shortcut (one letter), then the label.
    await main.locator('.tool-palette .tool-button').filter({ hasText: new RegExp(`^[A-Z]?${tool}$`) }).click();
    await main.locator('.sprotty-graph').click({ position: { x: 250, y: paletteY } });
    paletteY += 100;
    const nameEditor = main.locator('.catenary-name-input:visible');
    logs.push(`Waiting for palette name: ${tool}`);
    await nameEditor.waitFor();
    assert.ok(await nameEditor.evaluate(el => el === document.activeElement), 'New name has focus');
    await nameEditor.fill(label);
    await nameEditor.press('Enter');
    await created(label).waitFor();
    await nameEditor.waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
  }

  await main.locator('.sprotty-graph').click({ position: { x: 20, y: 600 } });
  await canvasFocus('before Ctrl+S');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !document.querySelector('#theia-main-content-panel .lm-TabBar-tab.lm-mod-current.theia-mod-dirty'), null, { timeout: 5000 });
  // The backend is clean only after the writes of the save (saver.ts: a written file sets its saved state).
  await waitUntil('the backend reports no unsaved change', () => cli('model', 'dirty'), dirty => dirty === false);
  const shapesFile = path.join(workspace, 'shapes.ttl'), dataFile = path.join(workspace, 'data.ttl');
  fs.copyFileSync(shapesFile, path.join(dir, 'shapes-saved.ttl'));
  const prefixes = `PREFIX sh: <http://www.w3.org/ns/shacl#> PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    PREFIX dct: <http://purl.org/dc/terms/> PREFIX ex: <http://example.org/shapes#> PREFIX foaf: <http://xmlns.com/foaf/0.1/>`;
  const saved = pattern => rdfRows(shapesFile, `${prefixes} SELECT * WHERE { ${pattern} }`);
  assert.equal(saved('ex:SoftwareAgent-name sh:path foaf:name . ex:SoftwareAgent-mbox sh:path foaf:mbox').length, 1, 'Property IRIs named after their node shape');
  assert.equal(saved('?s sh:path dct:created').length, 1);
  assert.equal(saved('?s sh:path dct:issued').length, 0);
  assert.equal(saved('?s sh:path dct:alternative').length, 1);
  // Concepts are data: the scheme and its concepts are in the data file; the scheme shape (sh:node target) is in the shapes file.
  assert.equal(rdfRows(dataFile, `${prefixes} SELECT * WHERE { ?s a skos:ConceptScheme; skos:prefLabel "Topics" . ?c skos:inScheme ?s; skos:prefLabel "Public health"; skos:broader ?p . ?p skos:prefLabel "Economy" }`).length, 1, 'Concept hierarchy saved in the data file');
  assert.equal(saved('?s skos:prefLabel "Topics"').length, 0, 'No concept scheme in the shapes file');
  assert.equal(saved('?h sh:property ?x . ?x sh:path skos:inScheme; sh:hasValue ?s').length >= 1, true, 'Scheme shape in the shapes file');
  // No blank nodes (AGENTS.md): the lists keep their IRIs; new property shapes have IRIs (above).
  assert.equal(saved('ex:Dataset sh:or ?list').length, 2, 'Both sh:or constraints saved');
  assert.equal(rdfRows(dataFile, `${prefixes} SELECT ?s WHERE { ?s dct:alternative "Application events" }`).length, 1, 'Data migrated');
  assert.equal(rdfRows(dataFile, `${prefixes} SELECT ?s WHERE { ?s dct:title "Open data" }`).length, 1, 'Catalogue keeps dct:title');
  assert.deepEqual(errors, [], 'Browser raised an uncaught error');
  assert.deepEqual(logs.join('').split('\n').filter(l => l.includes('[catenary]') && /written (as a whole|by triplify)/.test(l)), [], 'Every write is a text patch (no whole-file fallback)');
}));
