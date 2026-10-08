// Browser wiring smoke test only. Model rules and view reactions belong in `pnpm test`.
// Requires `pnpm build` and Chromium (CHROMIUM overrides /usr/bin/chromium).
// Always use an isolated workspace/config; never edit a running user's model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright-core');
const { iriId } = require('../packages/model/lib/ids.js');

const root = path.resolve(__dirname, '..');

// 45 s: the first browser start of a CI runner takes about 15 s (launch and first page, Chromium 154 on ubuntu-latest).
test('browser: node OR selector stays visible in a narrow Properties form', { timeout: 45000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const bundle = path.join(root, 'node_modules/@ulb-darmstadt/shacl-form/dist/bundle.js');
  await page.route('http://form.test/**', route => route.fulfill(
    new URL(route.request().url()).pathname !== '/'
      ? { contentType: 'text/javascript', body: fs.readFileSync(path.join(path.dirname(bundle), new URL(route.request().url()).pathname)) }
      : { contentType: 'text/html', body: '<div class="catenary-shacl-form" style="width: 320px"></div><script type="module" src="/bundle.js"></script>' }
  ));
  await page.goto('http://form.test/');
  await page.addStyleTag({ path: path.join(root, 'modeler/css/modeler.css') });
  await page.evaluate(async () => {
    await customElements.whenDefined('shacl-form');
    const form = document.createElement('shacl-form');
    form.setAttribute('data-shapes', `
      @prefix sh: <http://www.w3.org/ns/shacl#> .
      @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      <urn:test:Shape> a sh:NodeShape; sh:targetClass <urn:test:Role>; sh:or <urn:test:list1> .
      <urn:test:list1> rdf:first <urn:test:owns>; rdf:rest <urn:test:list2> .
      <urn:test:list2> rdf:first <urn:test:stewards>; rdf:rest rdf:nil .
      <urn:test:owns> a sh:PropertyShape; sh:path <urn:test:owns>; sh:name "owns"; sh:datatype <http://www.w3.org/2001/XMLSchema#string>; sh:minCount 1 .
      <urn:test:stewards> a sh:PropertyShape; sh:path <urn:test:stewards>; sh:name "stewards"; sh:datatype <http://www.w3.org/2001/XMLSchema#string>; sh:minCount 1 .
    `);
    form.setAttribute('data-shape-subject', 'urn:test:Shape');
    form.setAttribute('data-values-subject', 'urn:test:role');
    document.querySelector('.catenary-shacl-form').append(form);
  });
  const selector = page.locator('shacl-form [part="constraint-editor"] rokit-select');
  await selector.waitFor();
  const bounds = await selector.boundingBox();
  const container = await page.locator('.catenary-shacl-form').boundingBox();
  assert.ok(bounds.width > 100, `OR selector has usable width: ${bounds.width}`);
  assert.ok(bounds.x + bounds.width <= container.x + container.width + 1, 'OR selector fits inside the panel');
  await selector.click();
  await selector.getByRole('option', { name: 'owns', exact: true }).click();
  await page.locator('shacl-form label').filter({ hasText: /^owns$/ }).waitFor();
  assert.equal(await selector.count(), 0, 'choosing a branch replaces the selector with its field');
});

/** The agent CLI (scripts/catenary.mjs) on the backend at `url`: `cli(...args)` returns its JSON output. */
const catenaryCli = url => (...args) => JSON.parse(execFileSync(process.execPath,
  [path.join(root, 'scripts/catenary.mjs'), '--port', new URL(url).port, ...args], { encoding: 'utf8', timeout: 15000 }));

/** A row of the Theia file navigator (#files) with the name `name`. */
const navNode = (page, name) => page.locator('#files .theia-TreeNode')
  .filter({ has: page.locator('.theia-TreeNodeSegmentGrow', { hasText: new RegExp(`^${name.replace(/[.]/g, '\\.')}$`) }) });
/** Show the file navigator and expand the folders of `folders`. */
async function navigator(page, ...folders) {
  // A click on the current tab collapses the side panel, a second click shows it again.
  const tab = page.locator('#shell-tab-explorer-view-container');
  if (!await page.locator('#files').isVisible()) await tab.click();
  await page.waitForTimeout(200);
  if (!await page.locator('#files').isVisible()) await tab.click();
  await page.locator('#files').waitFor();
  for (const f of folders) {
    const node = navNode(page, f).first();
    await node.waitFor();
    if (!await node.locator('.theia-ExpansionToggle:not(.theia-mod-collapsed)').count()) await node.locator('.theia-ExpansionToggle').click();
  }
}

// Inspect saved RDF as a dataset, not Turtle text (prefixes and serialization order are not stable).
const rdfRows = (file, query) => require('./rdf-query.cjs').rows(file, query);

function startBackend(workspace, config, onLog) {
  const entry = path.join(root, 'app/lib/backend/main.js');
  assert.ok(fs.existsSync(entry), 'Run pnpm build before pnpm e2e.');
  // Theia reports its listening address through IPC. Port 0 avoids collisions with other runs.
  // With the git extension (Source Control view), as scripts/desktop.sh starts it.
  const proc = fork(entry, [workspace, '--hostname', '127.0.0.1', '--port', '0', '--plugins=local-dir:plugins'], {
    cwd: path.join(root, 'app'),
    env: { ...process.env, THEIA_CONFIG_DIR: config },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  proc.stdout.on('data', onLog);
  proc.stderr.on('data', onLog);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend did not listen within 20 seconds')), 20000);
    proc.once('error', e => { clearTimeout(timer); reject(e); });
    proc.once('exit', code => { clearTimeout(timer); reject(new Error(`Backend exited before readiness (${code})`)); });
    proc.once('message', address => {
      clearTimeout(timer);
      if (!address?.port) reject(new Error(`Invalid backend address: ${JSON.stringify(address)}`));
      else resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return { proc, ready };
}

async function stopBackend(proc) {
  if (!proc?.pid) return;
  // Include Theia's helper processes, not just the parent process.
  const kill = signal => {
    try { process.kill(-proc.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  };
  let timer;
  try {
    const exited = new Promise(resolve => proc.once('exit', resolve));
    kill('SIGTERM');
    if (proc.exitCode === null && proc.signalCode === null) {
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
    }
  } finally {
    clearTimeout(timer);
    kill('SIGKILL');
  }
}

test('browser: shapes view → rows, + attribute, value picker, SKOS scheme and concepts, rows as edges, logical constraint, data migration → save', { timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catenary-shapes-'));
  const workspace = path.join(dir, 'workspace'), config = path.join(dir, 'config');
  fs.mkdirSync(workspace);
  fs.mkdirSync(config);
  const fixtures = path.join(root, 'packages/rdf/test/fixtures');
  for (const [from, to] of [['dcat-workspace.trig', 'workspace.trig'], ['dcat-data.ttl', 'data.ttl'], ['dcat-shapes.ttl', 'shapes.ttl']]) {
    fs.copyFileSync(path.join(fixtures, from), path.join(workspace, to));
  }
  fs.cpSync(path.join(fixtures, 'dcat-views'), path.join(workspace, 'dcat-views'), { recursive: true });
  let backend, browser, page, passed = false;
  const logs = [];
  t.after(async () => {
    try { await browser?.close(); } finally {
      await stopBackend(backend);
      if (passed) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  try {
    const started = startBackend(workspace, config, data => logs.push(String(data)));
    backend = started.proc;
    const url = await started.ready;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', timeout: 10000 });
    page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
    page.setDefaultTimeout(8000);
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warn') logs.push(m.text()); });
    const errors = [];
    page.on('pageerror', e => { errors.push(e.message); logs.push(e.stack); });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const main = page.locator('#theia-main-content-panel');
    const settle = () => page.waitForTimeout(800);
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
    await page.mouse.move(g.x, g.y);
    await page.mouse.wheel(0, 60);
    await settle();
    const inline = page.locator('.catenary-embedded-input, .catenary-inline-input');
    const type = async (text, key = 'Enter') => {
      await inline.waitFor();
      await inline.fill(text);
      await inline.press(key);
    };
    const picker = page.locator('.catenary-popup-picker');

    // Double-click on the node shape name: the name is typed in the card. The GLSP redraw after the double-click must not close the input.
    await card('Catalogue').locator('.shape-name').dblclick();
    await page.locator('input.catenary-name-input').fill('Catalogue shape');
    await page.locator('input.catenary-name-input').press('Enter');
    await main.locator('.shape-card:visible .shape-name', { hasText: /^Catalogue shape$/ }).waitFor();
    await settle();

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
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(empty.x, empty.y, { steps: 10 });
    await page.mouse.up();
    await picker.locator('.list > .item').filter({ hasText: /^\+ New node shape$/ }).click();
    await card('unnamed shape 1').waitFor();
    await edge('unnamed property 1').waitFor();
    assert.equal(await inline.count(), 0, 'No path input after the link drag');
    await settle();
    await page.locator('#theia-main-content-panel .lm-TabBar-tab', { hasText: 'Catalog shapes' }).click();
    await page.keyboard.press('Control+z');
    await card('unnamed shape 1').waitFor({ state: 'detached' });
    assert.equal(await edge('unnamed property 1').count(), 0);
    await settle();

    // Click on a cardinality of a row: 1..* -> 0..*.
    await row('Catalogue', 'dataset').locator('.row-card').click();
    await row('Catalogue', 'dataset').locator('.row-card', { hasText: '0..*' }).waitFor();
    await settle();

    // A property shape is one selection in the canvas and the Model explorer: Reveal in Explorer on a row selects its tree row; a click on
    // the tree row shows it in Properties.
    const menuItem = label => page.locator('.lm-Menu .lm-Menu-itemLabel', { hasText: label }).first();
    const propsTitle = text => page.locator('.catenary-props .catenary-head .title:visible', { hasText: new RegExp(`^${text}$`) });
    const treeRow = name => page.locator('#catenary-model-explorer .theia-TreeNode')
      .filter({ has: page.locator('.catenary-tree-name', { hasText: new RegExp(`^${name}$`) }) });
    await row('Catalogue', 'dataset').locator('.row-path').click();
    await row('Catalogue', 'dataset').locator('.row-path').click({ button: 'right' });
    await menuItem('Reveal in Explorer').click();
    // The node shape is under sh:NodeShape only (spec/ui-manifest.hs: target shapes are not under their target class): one path, no picker.
    await treeRow('dcat:dataset').and(page.locator('.theia-mod-selected')).waitFor();
    await card('Software agent').locator('.shape-name').click();
    await propsTitle('Software agent').waitFor();
    await treeRow('dcat:dataset').locator('.catenary-tree-name').click();
    await propsTitle('dcat:dataset').waitFor();
    assert.equal(await page.locator('.theia-property-view-widget', { hasText: 'No properties available' }).count(), 0);

    // A row is a property shape: a click selects it (Properties), also with the focus in the Model explorer (the step above): the click
    // gives the focus to the canvas. Double-click on its path: typed in place.
    await row('Data asset', 'issued').locator('.row-path').click();
    await page.locator('.catenary-props .catenary-head .title', { hasText: 'dct:issued' }).waitFor();
    await row('Data asset', 'issued').locator('.row-path').dblclick();
    await type('dct:created');
    await row('Data asset', 'created').waitFor();
    await settle();

    // "+ attribute": Enter adds xsd:string and opens the next one; Tab picks the value.
    await card('Software agent').locator('.shape-add-row').click();
    await type('foaf:name');
    await row('Software agent', 'name').locator('.row-range', { hasText: 'xsd:string' }).waitFor();
    await type('foaf:mbox', 'Tab');
    await picker.waitFor();
    await picker.locator('input').fill('anyURI');
    await picker.locator('input').press('Enter');
    await row('Software agent', 'mbox').locator('.row-range', { hasText: 'xsd:anyURI' }).waitFor();
    await settle();

    // The value picker creates a concept scheme from typed text: its card joins the view, the property stays a row. Concepts: "+ concept", rename.
    await card('Linguistic system').locator('.shape-add-row').click();
    await type('dct:subject', 'Tab');
    await picker.waitFor();
    await picker.locator('input').fill('Topics');
    await picker.locator('.list > *', { hasText: 'New concept scheme "Topics"' }).click();
    await valueSet('Topics').waitFor();
    await row('Linguistic system', 'subject').locator('.row-range', { hasText: /^→ Topics$/ }).waitFor();
    await settle();
    await valueSet('Topics').locator('.member-add').click();
    await type('Economy');
    await valueSet('Topics').locator('.member-row', { hasText: 'Economy' }).waitFor();
    await type('Health');
    await valueSet('Topics').locator('.member-row', { hasText: 'Health' }).waitFor();
    await inline.press('Escape');
    await valueSet('Topics').locator('.member-row', { hasText: 'Health' }).dblclick();
    await type('Public health');
    await valueSet('Topics').locator('.member-row', { hasText: 'Public health' }).waitFor();
    await settle();

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
    await settle();
    // A row dragged out of its card: a line, its end box at the drop point when the view does not show it (ADR 0014: the box that a line
    // brings leaves with its last line). The datatype row stays a row: a datatype end is private, it shows only in a hub.
    for (const selector of ['.row-path', '.row-range']) {
      const source = row('Catalogue', 'dataset');
      const from = await center(source.locator(selector));
      const drop = { x: from.x, y: from.y + 250 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(drop.x, drop.y, { steps: 10 });
      await page.mouse.up();
      await edge('dataset').waitFor();
      await settle();
      assert.equal(await picker.count(), 0, 'Dragging the value does not open its picker');
      if (selector === '.row-path') await edge('dataset').locator('.row-in').click();
      else {
        await edge('dataset').locator('.edge-label').click();
        await page.keyboard.press('Delete');
      }
      await row('Catalogue', 'dataset').waitFor();
      await settle();
    }
    await row('Catalogue', 'title').locator('.row-out').click();
    await page.locator('.theia-notification-list-item', { hasText: 'datatype' }).first().waitFor();
    assert.equal(await edge('title').count(), 0, 'A datatype row stays a row');
    await row('Catalogue', 'title').waitFor();
    await settle();

    // Logic handle of a selected edge dragged to another edge of the same shape: a second sh:or.
    await edge('language').locator('.edge-label').click();
    const handle = edge('language').locator('.logic-handle');
    await handle.waitFor();
    const h = await center(handle), target = await center(edge('theme').locator('.edge-label'));
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y + 2, { steps: 8 });
    await page.mouse.up();
    await main.locator('.catenary-logic:visible').nth(1).waitFor();
    await settle();

    // "+ target" handle of a selected edge dragged to a card: one more target, the edge goes to a "one of" card.
    const orCards = await main.locator('.leaf-or').count();
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
    await page.waitForFunction(n => document.querySelectorAll('#theia-main-content-panel .leaf-or').length > n, orCards);
    await settle();
    // Undo: one step; the "one of" card goes, the later steps keep their layout.
    await main.locator('.sprotty-graph').click({ position: { x: 20, y: 600 } });
    await page.keyboard.press('Control+z');
    await page.waitForFunction(n => document.querySelectorAll('#theia-main-content-panel .leaf-or').length === n, orCards);
    await edge('dataset').locator('.row-in').click();
    await row('Catalogue', 'dataset').waitFor();
    await settle();

    // Path rename in Properties: the data migration is offered and applied.
    await row('Data asset', 'title').locator('.row-path').click();
    await page.locator('.catenary-props .catenary-head .title', { hasText: 'dct:title' }).waitFor();
    const pathInput = page.locator('.catenary-props .catenary-row', { hasText: 'Path' }).locator('input');
    await pathInput.fill('dct:alternative');
    await pathInput.press('Enter');
    await page.locator('.theia-notification-list-item button', { hasText: 'Apply to data' }).first().click();
    await page.locator('.theia-notification-list-item', { hasText: 'Data changed' }).first().waitFor();
    await settle();

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
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !document.querySelector('#theia-main-content-panel .lm-TabBar-tab.lm-mod-current.theia-mod-dirty'), null, { timeout: 5000 });
    await page.waitForTimeout(800);
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
    passed = true;
  } catch (e) {
    fs.writeFileSync(path.join(dir, 'backend-browser.log'), logs.join('\n'));
    await page?.screenshot({ path: path.join(dir, 'failure.png'), timeout: 3000 }).catch(() => {});
    if (page) fs.writeFileSync(path.join(dir, 'page.html'), await page.content().catch(() => ''));
    console.error(`Shapes view failure artifacts: ${dir}`);
    throw e;
  }
});

test('browser: Turtle and TriG source language detection and token colors', { timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catenary-rdf-source-'));
  const workspace = path.join(dir, 'workspace'), config = path.join(dir, 'config');
  fs.mkdirSync(workspace);
  fs.mkdirSync(config);
  for (const file of ['workspace.trig', 'data.ttl', 'shapes.ttl']) {
    fs.copyFileSync(path.join(root, 'packages/rdf/test/fixtures', file), path.join(workspace, file));
  }
  fs.cpSync(path.join(root, 'packages/rdf/test/fixtures/views'), path.join(workspace, 'views'), { recursive: true });
  let backend, browser, page, passed = false;
  const logs = [];
  t.after(async () => {
    try { await browser?.close(); } finally {
      await stopBackend(backend);
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(config, { recursive: true, force: true });
      if (passed) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  try {
    const started = startBackend(workspace, config, data => logs.push(String(data)));
    backend = started.proc;
    const url = await started.ready;
    const cli = catenaryCli(url);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', timeout: 10000 });
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(10000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('#shell-tab-explorer-view-container').waitFor();
    let status;
    for (let i = 0; i < 50; i++) {
      status = cli('status');
      if (status.windows.length) break;
      await page.waitForTimeout(100);
    }
    assert.ok(status.windows.length, 'CLI browser bridge is connected');
    assert.equal(status.build.stale, false);
    assert.equal(status.build.restartNeeded, false);
    assert.ok(status.windows.every(w => w.reloadNeeded === false));
    await navigator(page);
    for (const [file, language] of [['data.ttl', 'turtle'], ['workspace.trig', 'trig']]) {
      // A Turtle file opens as text on a double-click; the workspace file as text through "Open Workspace File as Text".
      if (file === 'data.ttl') await navNode(page, file).first().dblclick();
      else assert.equal(cli('run', 'catenary.showTrig').status, 'done');
      await page.locator('.monaco-editor:visible .view-line').first().waitFor();
      assert.equal(cli('eval', 'ctx.shell.currentWidget.editor.getControl().getModel().getLanguageId()'), language);
      // Rendered token colors, not just a registered language name. Do not inspect RDF serialization here.
      await page.waitForFunction(() => {
        const spans = [...document.querySelectorAll('.monaco-editor .view-line span')]
          .filter(n => n.getClientRects().length && n.textContent.trim() && /mtk\d+/.test(n.className));
        return new Set(spans.map(n => getComputedStyle(n).color)).size >= 3;
      });
      console.log(`source highlighting: ${file} → ${language}, at least 3 rendered token colors`);
    }
    assert.deepEqual(logs.join('').split('\n').filter(l => l.includes('[catenary]') && /written (as a whole|by triplify)/.test(l)), [], 'Every write is a text patch (no whole-file fallback)');
    passed = true;
  } catch (e) {
    fs.writeFileSync(path.join(dir, 'backend-browser.log'), logs.join('\n'));
    await page?.screenshot({ path: path.join(dir, 'failure.png'), timeout: 3000 }).catch(() => {});
    console.error(`RDF source failure artifacts: ${dir}`);
    throw e;
  }
});

/**
 * A backend on a copy of the test fixtures, a browser page with the CLI bridge connected, and the cleanup. `run(app)` gets
 * { page, cli }. On a failure: the backend log and a screenshot stay in the temporary folder.
 */
async function withFixtureApp(t, name, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `catenary-${name}-`));
  const workspace = path.join(dir, 'workspace'), config = path.join(dir, 'config');
  fs.mkdirSync(workspace);
  fs.mkdirSync(config);
  for (const file of ['workspace.trig', 'data.ttl', 'shapes.ttl']) {
    fs.copyFileSync(path.join(root, 'packages/rdf/test/fixtures', file), path.join(workspace, file));
  }
  fs.cpSync(path.join(root, 'packages/rdf/test/fixtures/views'), path.join(workspace, 'views'), { recursive: true });
  let backend, browser, page, passed = false;
  const logs = [];
  t.after(async () => {
    try { await browser?.close(); } finally {
      await stopBackend(backend);
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(config, { recursive: true, force: true });
      if (passed) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  try {
    const started = startBackend(workspace, config, data => logs.push(String(data)));
    backend = started.proc;
    const url = await started.ready;
    const cli = catenaryCli(url);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', timeout: 10000 });
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(10000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('#shell-tab-explorer-view-container').waitFor();
    for (let i = 0; i < 50 && !cli('status').windows.length; i++) await page.waitForTimeout(100);
    await run({ page, cli });
    passed = true;
  } catch (e) {
    fs.writeFileSync(path.join(dir, 'backend-browser.log'), logs.join('\n'));
    await page?.screenshot({ path: path.join(dir, 'failure.png'), timeout: 3000 }).catch(() => {});
    console.error(`${name} failure artifacts: ${dir}`);
    throw e;
  }
}

test('browser: law_notesSingleEditor: Notes move to native Markdown, autosave and return on close', { timeout: 60000 }, t => withFixtureApp(t, 'view-notes', async ({ page, cli }) => {
  const status = cli('status');
  assert.equal(status.build.stale, false);
  assert.equal(status.build.restartNeeded, false);
  assert.ok(status.windows.every(w => !w.reloadNeeded));
  await page.locator('.card-name').getByText('Product usage data', { exact: true }).click();
  const created = cli('exec', JSON.stringify({ kind: 'createView', label: 'Explained view' })).result;
  assert.equal(created.ok, true);
  const view = created.id;
  cli('eval', `await ctx.editors.open(${JSON.stringify(view)}); ctx.selection.set({ view: undefined, ids: [${JSON.stringify(view)}] }); await ctx.shell.revealWidget('property-view'); return true`);
  cli('eval', `ctx.selection.set({ view: undefined, ids: [${JSON.stringify(view)}] }); return true`);
  const panel = page.locator('#catenary-properties');
  const field = panel.getByRole('textbox', { name: 'View notes (Markdown)', exact: true });
  await panel.getByRole('heading', { name: 'Notes', exact: true }).waitFor();
  await field.fill('# Purpose\n\nAn explanation.');
  await panel.getByRole('button', { name: 'Open notes in editor', exact: true }).click();
  const editor = page.locator('.catenary-view-notes-editor');
  await editor.locator('.monaco-editor').waitFor();
  assert.equal(await field.count(), 0, 'Properties removes the textarea while Monaco is open');
  assert.equal(cli('eval', 'ctx.shell.currentWidget.editor.getControl().getModel().getLanguageId()'), 'markdown');
  assert.equal(cli('eval', 'ctx.shell.currentWidget.editor.document.getText()'), '# Purpose\n\nAn explanation.');
  assert.equal(cli('ui').currentView, view, 'the diagram stays open beside the editor');
  const canvasBounds = await page.locator('.sprotty-graph:visible').boundingBox();
  const editorBounds = await editor.boundingBox();
  assert.ok(canvasBounds && editorBounds && editorBounds.x >= canvasBounds.x + canvasBounds.width - 2, 'editor is beside the visible diagram');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' More notes.');
  let expected = '# Purpose\n\nAn explanation. More notes.';
  for (let i = 0; i < 50 && cli('rpc', 'properties', JSON.stringify(view)).result.description !== expected; i++) await page.waitForTimeout(100);
  assert.equal(cli('rpc', 'properties', JSON.stringify(view)).result.description, expected, 'typing saves without a button');
  assert.equal(await panel.getByRole('button', { name: 'Save description', exact: true }).count(), 0);
  // Keep a native save in flight while more input arrives. The older completion must not mark the newer text clean.
  cli('eval', `globalThis.notesExecute = ctx.model.execute.bind(ctx.model); globalThis.notesSaving = false; ctx.model.execute = async c => { const r = await globalThis.notesExecute(c); if (c.kind === 'setViewDescription') { globalThis.notesSaving = true; await new Promise(resolve => setTimeout(resolve, 500)); } return r; }; return true`);
  await page.keyboard.type(' Slow save.');
  await page.waitForFunction(() => globalThis.notesSaving);
  await page.keyboard.type(' New input.');
  expected += ' Slow save. New input.';
  for (let i = 0; i < 50 && cli('rpc', 'properties', JSON.stringify(view)).result.description !== expected; i++) await page.waitForTimeout(100);
  assert.equal(cli('rpc', 'properties', JSON.stringify(view)).result.description, expected);
  for (let i = 0; i < 50 && cli('eval', 'ctx.shell.currentWidget.editor.document.dirty'); i++) await page.waitForTimeout(100);
  assert.equal(cli('eval', 'ctx.shell.currentWidget.editor.document.dirty'), false);
  cli('eval', 'ctx.model.execute = globalThis.notesExecute; delete globalThis.notesExecute; delete globalThis.notesSaving; return true');
  // Edit and close in one browser turn: the 300 ms idle save cannot have run yet.
  cli('eval', `const w = ctx.shell.currentWidget; w.editor.getControl().trigger('test', 'type', {text: ' Last words.'}); await w.closeWithSaving(); return true`);
  await editor.waitFor({ state: 'detached' });
  await field.waitFor();
  assert.equal(await field.inputValue(), expected + ' Last words.');
  assert.equal(cli('rpc', 'properties', JSON.stringify(view)).result.description, expected + ' Last words.');
  assert.equal(await page.getByRole('dialog').count(), 0, 'closing notes has no save prompt');
  await panel.getByRole('button', { name: 'Open notes in editor', exact: true }).click();
  await editor.locator('.monaco-editor').waitFor();
  assert.equal(await field.count(), 0);
  assert.equal(cli('eval', 'ctx.shell.currentWidget.editor.document.getText()'), expected + ' Last words.');
  // A concurrent edit must not make close discard the local buffer.
  cli('eval', `const w = ctx.shell.currentWidget; w.editor.getControl().trigger('test', 'type', {text: 'Local edit'}); await ctx.model.execute({kind: 'setViewDescription', view: ${JSON.stringify(view)}, text: 'Other window'}); await w.closeWithSaving(); return true`);
  await page.getByText('These notes changed elsewhere. Copy your text before reloading the editor.', { exact: true }).first().waitFor();
  assert.equal(await editor.count(), 1, 'failed save leaves the editor open');
  assert.equal(await field.count(), 0, 'failed save does not restore a second editor');
  assert.equal(cli('rpc', 'properties', JSON.stringify(view)).result.description, 'Other window');
  assert.ok(cli('eval', 'ctx.shell.currentWidget.editor.document.getText()').includes('Local edit'));
}));

test('browser: Links lists instances of a selected shape outside the current view', { timeout: 45000 }, t => withFixtureApp(t, 'shape-instances', async ({ page, cli }) => {
  const shape = cli('exec', JSON.stringify({ kind: 'createNodeShape', label: 'Instance list shape', targetClass: 'urn:test:InstanceList' })).result;
  assert.equal(shape.ok, true);
  const instance = cli('exec', JSON.stringify({ kind: 'createInstance', classIri: 'urn:test:InstanceList', label: 'Unplaced list instance' })).result;
  assert.equal(instance.ok, true);
  cli('eval', `ctx.selection.set({ view: undefined, ids: [${JSON.stringify(shape.id)}] }); return true`);
  cli('run', 'catenary.toggleLinks');
  const panel = page.locator('#catenary-links');
  await panel.getByText(/^Instances\s*1$/).waitFor();
  await panel.getByText('Unplaced list instance', { exact: true }).waitFor();
  assert.equal(await panel.getByText('Unplaced list instance', { exact: true }).count(), 1);
}));

test('browser: view URL overrides restored tabs and rejects unknown views', { timeout: 60000 }, t => withFixtureApp(t, 'view-url', async ({ page, cli }) => {
  const created = cli('exec', JSON.stringify({ kind: 'createView', label: 'Linked view' }));
  assert.equal(created.result.ok, true);
  const view = created.result.id;
  const url = new URL(page.url());
  url.searchParams.set('view', view);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#shell-tab-explorer-view-container'));
  await page.waitForTimeout(1000);
  for (let i = 0; i < 50; i++) {
    if (cli('ui').currentView === view) break;
    await page.waitForTimeout(100);
  }
  assert.equal(cli('ui').currentView, view);
  url.searchParams.set('view', 'missing-view');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.getByText('The requested view is not in the current workspace.', { exact: true }).first().waitFor();
  assert.equal(cli('status').model.views, 2, 'an invalid link creates no view');
}));

test('browser: Apply Layout fits the viewport to the new layout; no zoom-out limit', { timeout: 45000 }, t => withFixtureApp(t, 'layout-fit', async ({ page, cli }) => {
  const view = iriId('urn:name:Product%20context');
  cli('eval', `await ctx.editors.open(${JSON.stringify(view)}); return true`);
  await page.locator('svg.sprotty-graph:visible g.card').first().waitFor();
  /**
   * Zoom of the view editor, and its cards: total and inside the visible model area. From the client model, not the DOM: the canvas
   * does not draw an element outside the viewport.
   */
  const state = () => cli('eval', `const root = ctx.editors.find(${JSON.stringify(view)}).editorContext.modelRoot;
    const { scroll, zoom, canvasBounds: c } = root, area = { x: scroll.x, y: scroll.y, X: scroll.x + c.width / zoom, Y: scroll.y + c.height / zoom };
    const abs = e => { let x = e.position.x, y = e.position.y; for (let p = e.parent; p && p !== root; p = p.parent) { x += p.position?.x ?? 0; y += p.position?.y ?? 0; } return { x, y, X: x + e.size.width, Y: y + e.size.height }; };
    const cards = [...root.index.all()].filter(e => e.type === 'node:card').map(abs);
    return { zoom, cards: cards.length, inside: cards.filter(b => b.x >= area.x - 1 && b.X <= area.X + 1 && b.y >= area.y - 1 && b.Y <= area.Y + 1).length }`);
  // Below the GLSP zoom-out limit (0.1), and far from the content: no card in the viewport.
  const away = async () => {
    cli('eval', `const w = ctx.editors.find(${JSON.stringify(view)}); const root = w.editorContext.modelRoot;
      await w.actionDispatcher.dispatch({ kind: 'viewport', elementId: root.id, newViewport: { scroll: { x: 200000, y: 200000 }, zoom: 0.02 }, animate: false }); return true`);
    await page.waitForTimeout(300);
  };
  await away();
  const before = state();
  assert.ok(Math.abs(before.zoom - 0.02) < 1e-9, `zoom 0.02 is kept (got ${before.zoom})`);
  assert.ok(before.cards > 0 && before.inside === 0, `no card in the viewport before the layout: ${JSON.stringify(before)}`);
  for (const algorithm of ['force', 'layered']) {
    assert.equal(cli('run', 'catenary.layoutView', 'null', JSON.stringify(algorithm)).status, 'done');
    let after;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(150);
      after = state();
      if (after.cards > 0 && after.inside === after.cards) break;
    }
    assert.equal(after.inside, after.cards, `${algorithm}: every card is in the viewport after the layout: ${JSON.stringify(after)}`);
    console.log(`layout fit: ${algorithm} → ${after.inside}/${after.cards} cards in the viewport, zoom ${after.zoom.toFixed(3)}`);
    await away();
  }
}));

test('browser: Properties keeps its content during a model change; the SHACL form is replaced when the new one is ready', { timeout: 45000 }, t => withFixtureApp(t, 'properties-stable', async ({ page, cli }) => {
  // An instance with a SHACL form.
  const hits = cli('rpc', 'search', '{}', '50').result.hits.filter(h => h.kind === 'instance');
  let target;
  for (const h of hits) {
    cli('eval', `ctx.selection.set({ view: undefined, ids: [${JSON.stringify(h.id)}] }); return true`);
    if (!await page.locator('#catenary-properties .catenary-props').isVisible()) await page.locator('#shell-tab-property-view').click();
    if (await page.locator('#catenary-properties .catenary-props shacl-form').first().waitFor({ timeout: 3000 }).then(() => true, () => false)) { target = h; break; }
  }
  assert.ok(target, 'an instance of the fixtures has a SHACL form');
  await page.waitForTimeout(1500);
  const record = () => page.evaluate(() => {
    const p = document.querySelector('#catenary-properties .catenary-props');
    const log = window.__rec = { minPanel: Infinity, minForm: Infinity, visibleForms: new Set(), maxForms: 0, emptyActions: false };
    const t0 = performance.now();
    const tick = () => {
      const forms = [...p.querySelectorAll('shacl-form')], shown = forms.find(f => f.style.visibility !== 'hidden');
      log.maxForms = Math.max(log.maxForms, forms.length);
      log.minPanel = Math.min(log.minPanel, p.scrollHeight);
      log.minForm = Math.min(log.minForm, shown ? shown.getBoundingClientRect().height : 0);
      if (shown) log.visibleForms.add(shown);
      if (!p.querySelector('.catenary-toolbar')) log.emptyActions = true;
      if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
    };
    const before = { panel: p.scrollHeight, form: p.querySelector('shacl-form').getBoundingClientRect().height };
    requestAnimationFrame(tick);
    return before;
  });
  const result = async () => {
    await page.waitForTimeout(4200);
    return page.evaluate(() => { const r = window.__rec; return { ...r, visibleForms: r.visibleForms.size }; });
  };
  // A change of another instance: nothing in the panel changes size, the form stays.
  const other = hits.find(h => h.id !== target.id);
  let before = await record();
  assert.equal(cli('exec', JSON.stringify({ kind: 'rename', id: other.id, label: 'Renamed other' })).result.ok, true);
  let r = await result();
  assert.equal(r.minPanel, before.panel, `other instance: the panel keeps its height: ${JSON.stringify(r)}`);
  assert.equal(r.visibleForms, 1, 'other instance: the same form stays');
  assert.equal(r.emptyActions, false, 'other instance: the action toolbar stays');
  // A change of the selected instance: the form is replaced, without a frame with an empty or short form.
  before = await record();
  assert.equal(cli('exec', JSON.stringify({ kind: 'rename', id: target.id, label: 'Renamed target' })).result.ok, true);
  r = await result();
  assert.equal(r.visibleForms, 2, `selected instance: a new form replaces the shown one: ${JSON.stringify(r)}`);
  assert.ok(r.minForm >= before.form - 1, `selected instance: the shown form never gets shorter: ${JSON.stringify(r)} ${JSON.stringify(before)}`);
  assert.equal(r.emptyActions, false, 'selected instance: the action toolbar stays');
  assert.equal(await page.locator('#catenary-properties .catenary-props shacl-form').count(), 1, 'one form after the swap');
  const values = await page.evaluate(() => {
    const out = [];
    const walk = n => { if (n.shadowRoot) walk(n.shadowRoot); for (const c of n.children ?? []) { if (typeof c.value === 'string' && c.value) out.push(c.value); walk(c); } };
    walk(document.querySelector('#catenary-properties .catenary-props shacl-form'));
    return out;
  });
  assert.ok(values.includes('Renamed target'), `the new form shows the new label: ${values.slice(0, 10)}`);
  console.log(`properties: form replaced once, min form height ${Math.round(r.minForm)} of ${Math.round(before.form)} px, panel never shorter`);
}));
