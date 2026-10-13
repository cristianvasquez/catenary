// Browser scenarios of the panels and canvases: hidden panel reads, Trace metrics, two-canvas selection and bends.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, withFixtureApp } = require('./harness.cjs');
const { iriId } = require('../../packages/model/lib/ids.js');

test('browser: law_hiddenPanelNoRead, law_saveKeepsRevision and law_hiddenCanvasRefreshesOnce: panels and canvases read on show, save keeps content', { timeout: 90000 }, t => withFixtureApp(t, 'panel-reads', async ({ page, cli, workspace, logs }) => {
  cli('rpc', 'setSettings', JSON.stringify({ validation: 'off' }));
  const view = cli('model', 'files').views[0].view;
  const created = cli('exec', JSON.stringify({ kind: 'createInstance', classIri: 'urn:test:Panel', label: 'Panel before', view, at: { x: 200, y: 200 } })).result;
  assert.equal(created.ok, true);
  const select = () => cli('eval', `ctx.selection.set({view: ${JSON.stringify(view)}, ids: [${JSON.stringify(created.id)}]}); return true`);
  select();
  if (!await page.locator('#catenary-properties').isVisible()) await page.locator('#shell-tab-property-view').click();
  await page.locator('#catenary-properties').getByText('Panel before', { exact: true }).first().waitFor();
  cli('run', 'catenary.toggleAppearance');
  await page.locator('#catenary-appearance').waitFor();
  cli('run', 'catenary.toggleLinks');
  await page.locator('#catenary-links').waitFor();
  cli('eval', `ctx.shell.collapsePanel('right'); return true`);
  await page.waitForTimeout(400);
  cli('rpc', 'setTracing', 'true');
  t.after(() => { try { cli('rpc', 'setTracing', 'false'); } catch {} });
  cli('rpc', 'clearTrace');
  cli('exec', JSON.stringify({ kind: 'rename', id: created.id, label: 'Panel after' }));
  select();
  await page.waitForTimeout(500);
  const hidden = cli('rpc', 'trace', '0').result.spans.filter(s => s.kind === 'rpc').map(s => s.name);
  assert.ok(!hidden.some(name => ['properties', 'appearance', 'links', 'view', 'elementRows'].includes(name)), JSON.stringify(hidden));
  await page.locator('#shell-tab-property-view').click();
  await page.locator('#catenary-properties').getByText('Panel after', { exact: true }).first().waitFor();
  cli('run', 'catenary.toggleAppearance');
  await page.locator('#catenary-appearance').getByText('Panel after', { exact: true }).waitFor();
  await page.waitForTimeout(500);
  cli('rpc', 'clearTrace');
  const revision = cli('model', 'revision');
  cli('save');
  await page.waitForTimeout(500);
  assert.equal(cli('model', 'revision'), revision);
  const saved = cli('rpc', 'trace', '0').result.spans.filter(s => s.kind === 'rpc').map(s => s.name);
  assert.ok(!saved.some(name => ['properties', 'appearance', 'links', 'view', 'elementRows'].includes(name)), JSON.stringify(saved));
  // law_hiddenCanvasRefreshesOnce: the canvas tells the server when its tab is hidden (catenarySetVisible). A change while hidden
  // gives no refresh of the canvas; the show gives one, with the change.
  cli('eval', `await ctx.editors.open(${JSON.stringify(view)}); return true`);
  const card = () => page.locator('svg.sprotty-graph:visible g.card').filter({ hasText: /^Panel/ });
  await card().filter({ hasText: 'Panel after' }).waitFor();
  const canvasId = cli('eval', 'ctx.shell.currentWidget.id');
  assert.equal(cli('run', 'catenary.openAs', JSON.stringify(path.join(workspace, 'data.ttl')), '"Source"').status, 'done');
  await page.locator('svg.sprotty-graph:visible').waitFor({ state: 'hidden' });
  await page.waitForTimeout(300);
  cli('rpc', 'clearTrace');
  cli('exec', JSON.stringify({ kind: 'rename', id: created.id, label: 'Panel hidden' }));
  await page.waitForTimeout(500);
  const refreshes = () => cli('rpc', 'trace', '0').result.spans.filter(s => s.kind === 'refresh' && s.name.startsWith('view ')).map(s => s.name);
  assert.deepEqual(refreshes(), [], 'a hidden canvas gets no refresh');
  cli('eval', `await ctx.shell.activateWidget(${JSON.stringify(canvasId)}); return true`);
  await card().filter({ hasText: 'Panel hidden' }).waitFor();
  assert.equal(refreshes().length, 1, 'one refresh when the canvas shows again');
  assert.ok(!logs.some(l => l.includes('Missing handler for action')), logs.filter(l => l.includes('Missing handler')).join('\n'));
  cli('rpc', 'setTracing', 'false');
}));

test('browser: Trace performance metrics record model input and stop on pause', { timeout: 90000 }, t => withFixtureApp(t, 'trace-metrics', async ({ page, cli }) => {
  cli('rpc', 'setSettings', JSON.stringify({ validation: 'off' }));
  const view = cli('model', 'files').views[0].view;
  assert.equal(cli('exec', JSON.stringify({ kind: 'createInstance', classIri: 'urn:test:Metric', label: 'Metric card', view, at: { x: 200, y: 200 } })).result.ok, true);
  cli('eval', `await ctx.editors.open(${JSON.stringify(view)}); ctx.selection.set({ids: []}); return true`);
  cli('run', 'catenary.toggleTrace');
  const panel = page.locator('#catenary-trace');
  const table = panel.getByRole('table', { name: 'Performance metrics' });
  const metric = label => table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: label, exact: true }) }).locator('td');
  await table.waitFor();
  await page.waitForTimeout(1200);
  await panel.getByRole('button', { name: 'Clear', exact: true }).click();
  const card = page.locator('svg.sprotty-graph:visible g.card').filter({ hasText: 'Metric card' }).first();
  await card.locator('.card-name').first().click();
  cli('rpc', 'view', JSON.stringify(view));
  await page.waitForTimeout(2200);
  assert.match(await metric('First model update').innerText(), /p50 .*p95 .*samples/);
  assert.match(await metric('Backend event-loop delay').innerText(), /p50 .*p95 .*samples/);
  assert.ok(Number(await metric('RPC count').innerText()) > 0);
  assert.match(await metric('RDF query time').innerText(), /[\d.]+ ms/);
  assert.ok(Number(await metric('Full-view reads').innerText()) >= 1);
  // Stop the poll timer to reproduce Pause before the next poll deterministically.
  cli('eval', `clearInterval(ctx.shell.getWidgetById('catenary-trace').timer); return true`);
  const readsBeforePause = Number(await metric('Full-view reads').innerText());
  cli('rpc', 'view', JSON.stringify(view));
  await panel.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.waitForFunction(previous => {
    const rows = [...document.querySelectorAll('#catenary-trace table[aria-label="Performance metrics"] tr')];
    const row = rows.find(r => r.querySelector('th')?.textContent === 'Full-view reads');
    return Number(row?.querySelector('td')?.textContent) > previous;
  }, readsBeforePause);
  assert.equal(cli('rpc', 'trace', '0').result.on, false);
  await panel.getByRole('button', { name: 'Clear', exact: true }).click();
  assert.equal(await metric('First model update').innerText(), 'No samples');
  assert.equal(await metric('Backend event-loop delay').innerText(), 'No samples');
  assert.equal(await metric('RPC count').innerText(), '0');
}));

test('browser: law_oneSelectionPerWindow: a click selects in its canvas only, the canvas of another view highlights, Ctrl+click adds from it', { timeout: 60000 }, t => withFixtureApp(t, 'one-selection', async ({ page, cli }) => {
  cli('rpc', 'setSettings', JSON.stringify({ validation: 'off' }));
  const exec = command => cli('exec', JSON.stringify(command)).result;
  const left = exec({ kind: 'createView', label: 'Left view' }).id, right = exec({ kind: 'createView', label: 'Right view' }).id;
  const one = exec({ kind: 'createInstance', classIri: 'urn:test:Sel', label: 'Shared one', view: left, at: { x: 100, y: 100 } }).id;
  const two = exec({ kind: 'createInstance', classIri: 'urn:test:Sel', label: 'Shared two', view: left, at: { x: 100, y: 500 } }).id;
  assert.equal(exec({ kind: 'addToView', view: right, ids: [one], at: { x: 100, y: 100 } }).ok, true);
  assert.equal(exec({ kind: 'addToView', view: right, ids: [two], at: { x: 100, y: 500 } }).ok, true);
  // Two canvases side by side. Count the selection events and the SelectActions of each canvas.
  cli('eval', `const a = await ctx.editors.open(${JSON.stringify(left)}); await ctx.editors.open(${JSON.stringify(right)}, 'activate', { widgetOptions: { mode: 'split-right', ref: a } }); return true`);
  const placement = (view, id) => cli('eval', `const w = ctx.editors.find(${JSON.stringify(view)}); return [w.viewerOptions.baseDiv, ctx.editors.placementOf(w, ${JSON.stringify(id)})]`);
  // The visible model only: the hidden model viewer (`<baseDiv>_hidden`) draws the same ids.
  const node = (view, id) => { const [base, p] = placement(view, id); return page.locator(`[id="${base}"] [id="${base}_${p}"]`); };
  await node(left, one).waitFor();
  await node(right, one).waitFor();
  cli('eval', `window.__one = { events: 0, selects: {} };
    ctx.selection.onDidChange(() => window.__one.events++);
    for (const view of ${JSON.stringify([left, right])}) {
      const d = ctx.editors.find(view).actionDispatcher, dispatch = d.dispatch.bind(d);
      d.dispatch = a => { if (a.kind === 'elementSelected') window.__one.selects[view] = (window.__one.selects[view] ?? 0) + 1; return dispatch(a); };
    }
    return true`);
  const counts = () => cli('eval', 'return window.__one');
  const classes = async (view, id) => (await node(view, id).getAttribute('class')).split(/\s+/);
  await node(left, one).locator('.card-name').first().click();
  await page.waitForTimeout(500);
  // One click: one selection event and one SelectAction, in the canvas of the click. The other canvas highlights the element.
  assert.deepEqual(counts(), { events: 1, selects: { [left]: 1 } });
  assert.ok((await classes(left, one)).includes('selected'));
  assert.ok((await classes(right, one)).includes('catenary-highlight'));
  assert.ok(!(await classes(right, one)).includes('selected'));
  // A model change sends no SelectAction to the canvases.
  exec({ kind: 'rename', id: one, label: 'Shared one renamed' });
  await node(right, one).filter({ hasText: 'Shared one renamed' }).waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual(counts().selects, { [left]: 1 });
  // Ctrl+click in the highlighting canvas adds: that canvas becomes the origin, and the first canvas highlights both.
  await node(right, two).locator('.card-name').first().click({ modifiers: ['Control'] });
  await page.waitForTimeout(500);
  const selection = cli('eval', 'return ctx.selection.selection');
  assert.equal(selection.view, right);
  assert.deepEqual(selection.ids.map(id => cli('eval', `return ctx.editors.elementIn(${JSON.stringify(right)}, ${JSON.stringify(id)})`)).sort(), [one, two].sort());
  for (const id of [one, two]) {
    assert.ok((await classes(right, id)).includes('selected'), `${id} selected in the origin`);
    assert.ok((await classes(left, id)).includes('catenary-highlight'), `${id} highlighted in the other canvas`);
    assert.ok(!(await classes(left, id)).includes('selected'), `${id} not selected in the other canvas`);
  }
  // law_highlightKeys: Ctrl+click on a highlighted card removes it; that canvas becomes the origin with the rest of the highlight.
  const elementsOf = s => s.ids.map(id => cli('eval', `return ctx.editors.elementIn(${JSON.stringify(s.view)}, ${JSON.stringify(id)})`));
  await node(left, one).locator('.card-name').first().click({ modifiers: ['Control'] });
  await page.waitForTimeout(500);
  let now = cli('eval', 'return ctx.selection.selection');
  assert.equal(now.view, left);
  assert.deepEqual(elementsOf(now), [two]);
  assert.ok(!(await classes(left, one)).includes('selected'));
  assert.ok((await classes(left, two)).includes('selected'));
  assert.ok(!(await classes(right, one)).includes('catenary-highlight'));
  // Ctrl+click twice on the same card of the other canvas: the first removes it (it is highlighted), the second adds it.
  await node(right, two).locator('.card-name').first().click({ modifiers: ['Control'] });
  await page.waitForTimeout(500);
  now = cli('eval', 'return ctx.selection.selection');
  assert.deepEqual(now, { view: right, ids: [] });
  assert.ok(!(await classes(right, two)).includes('selected'));
  assert.ok(!(await classes(left, two)).includes('catenary-highlight'));
  await node(right, two).locator('.card-name').first().click({ modifiers: ['Control'] });
  await page.waitForTimeout(500);
  now = cli('eval', 'return ctx.selection.selection');
  assert.equal(now.view, right);
  assert.deepEqual(elementsOf(now), [two]);
  assert.ok((await classes(right, two)).includes('selected'));
  // law_highlightKeys: a listing selection and keys in a focused canvas. Del removes nothing (no origin), Ctrl+C copies the
  // highlight (the paste finds it in the view: ui-manifest §5.8), Ctrl+Del deletes the element of the window selection.
  const cards = view => cli('rpc', 'view', JSON.stringify(view)).result.boxes.length;
  const focusRight = () => cli('eval', `const w = ctx.editors.find(${JSON.stringify(right)}); await ctx.shell.activateWidget(w.id); w.node.querySelector('svg.sprotty-graph').focus(); return true`);
  cli('eval', `ctx.selection.set({ ids: [${JSON.stringify(one)}] }); return true`);
  await page.waitForTimeout(300);
  assert.ok((await classes(right, one)).includes('catenary-highlight'));
  focusRight();
  const before = cards(right);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  assert.equal(before, 2);
  assert.equal(cards(right), before, 'Del without an origin removes nothing');
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(300);
  focusRight();
  await page.keyboard.press('Control+v');
  await page.locator('.theia-notification-list-item', { hasText: 'Placed 0. Skipped 1 already in this view.' }).first().waitFor();
  assert.equal(cards(right), before, 'the paste of the copied highlight places the same element: the view shows it');
  cli('eval', `ctx.selection.set({ ids: [${JSON.stringify(one)}] }); return true`);
  await page.waitForTimeout(300);
  focusRight();
  await page.keyboard.press('Control+Delete');
  await page.locator('.dialogBlock .theia-button.main').click();
  for (let i = 0; i < 30 && cli('rpc', 'search').result.some(h => h.id === one); i++) await page.waitForTimeout(100);
  assert.ok(!cli('rpc', 'search').result.some(h => h.id === one), 'Ctrl+Del deletes the element of the listing selection');
}));

test('browser: a drag of an edge line adds a bend, a double-click on the bend removes it (UI §7.4)', { timeout: 90000 }, t => withFixtureApp(t, 'bends', async ({ page, cli, workspace }) => {
  cli('rpc', 'open', JSON.stringify(path.join(workspace, 'workspace.trig')));
  const view = iriId('urn:name:Product%20context');
  cli('eval', `await ctx.editors.open(${JSON.stringify(view)}); return true`);
  const canvas = page.locator('svg.sprotty-graph:visible');
  await canvas.waitFor();
  // Theia removes its loading screen after a fade: until then it is on top and takes the presses of the line drag.
  await page.locator('.theia-preload').waitFor({ state: 'detached' });
  const file = path.join(workspace, 'views', 'product-context.view.trig');
  const vertices = () => (fs.readFileSync(file, 'utf8').match(/view:vertices "([^"]*)"/) ?? [])[1];
  const until = async (ok, what) => { for (let i = 0; i < 50; i++) { if (ok()) return; await page.waitForTimeout(100); } assert.fail(what); };
  assert.equal(vertices(), undefined);
  // The whole view in the viewport, then the middle of the line of the first relation edge, on screen. A flat line has an empty
  // bounding box: Playwright calls it hidden, so wait for it attached.
  cli('eval', `const w = ctx.editors.find(${JSON.stringify(view)}); await w.actionDispatcher.dispatch({ kind: 'fit', elementIds: [], padding: 40, maxZoom: 1, animate: false }); return true`);
  await page.waitForTimeout(500);
  // The edge by its id, not by its place: a selected edge is drawn last, so `.first()` names another edge while this one is selected.
  const first = canvas.locator('.catenary-edge:not(.property):not(.arrow-edge)').first();
  await first.waitFor({ state: 'attached' });
  const edge = canvas.locator(`[id="${await first.getAttribute('id')}"]`);
  const line = edge.locator('.line');
  await line.waitFor({ state: 'attached' });
  const middle = () => line.evaluate(el => {
    const m = el.getScreenCTM(), p = el.getPointAtLength(el.getTotalLength() / 2);
    return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
  });
  let at = await middle();
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 30, at.y + 90, { steps: 8 });
  await page.mouse.up();
  await until(() => vertices() !== undefined, 'the view file holds the bend');
  assert.match(vertices(), /^-?\d+,-?\d+$/, 'one bend');
  const saved = vertices();
  // A click on the line selects the edge: its bend handle shows (a selected edge is drawn last: find it by its class).
  at = await middle();
  await page.mouse.click(at.x, at.y);
  const handle = canvas.locator('.catenary-edge.selected .edge-vertex');
  await handle.waitFor();
  assert.equal(await handle.count(), 1);
  const handleCenter = async () => { const b = await handle.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  // The drawn route: the path of the line of the (selected, so last drawn) edge.
  const drawn = () => canvas.locator('.catenary-edge.selected .line').getAttribute('d');
  const drawnBefore = await drawn();
  // A click on the handle without a drag, 3 px off its center, sends no command: the view file and the drawn route stay (UI §7.4
  // law_bendClickSendsNothing).
  let c = await handleCenter();
  await page.mouse.click(c.x + 3, c.y + 3);
  await page.waitForTimeout(500);
  assert.equal(vertices(), saved, 'a click on a bend handle changes nothing in the view file');
  assert.equal(await drawn(), drawnBefore, 'a click on a bend handle keeps the drawn route');
  // The view file is locked: a drag of the handle asks to unlock it; Cancel refuses the edit, and the drawn route goes back to the
  // saved one (law_refusedBendKeepsSaved).
  assert.equal(cli('rpc', 'setImported', JSON.stringify(file), 'true').result.ok, true);
  c = await handleCenter();
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y + 40, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForTimeout(500);
  assert.equal(vertices(), saved, 'a refused bend edit leaves the view file');
  // The dialog can take the selection with it (open.md BEND3): a click on the line selects the edge again.
  at = await middle();
  await page.mouse.click(at.x, at.y);
  await handle.waitFor();
  assert.equal(await drawn(), drawnBefore, 'a refused bend edit restores the drawn route');
  assert.equal(cli('rpc', 'setImported', JSON.stringify(file), 'false').result.ok, true);
  // A double-click on the handle, off its center, removes the bend with one command: one undo restores the saved route.
  c = await handleCenter();
  await page.mouse.dblclick(c.x + 3, c.y + 3);
  await until(() => vertices() === undefined, 'the bend is removed from the view file');
  await handle.waitFor({ state: 'detached' });
  cli('run', 'catenary.undo');
  await until(() => vertices() === saved, 'one undo restores the bend where it was');
}));
