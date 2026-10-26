// Browser scenarios of the panels and canvases: hidden canvas refresh, Trace metrics, two-canvas selection, bends and the reason of a disabled gesture.
// No fixed sleep establishes completion. A check waits for an observed state (app.waitUntil, a locator), or for these completion
// points: the window has processed a revision (its snapshot and the backend answer of its selection), a frame flush of the window,
// a later RPC on the same frontend connection, and an answered read-only GLSP request on the same canvas session.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, withApp, withFixtureApp } = require('./harness.cjs');
const { escapeId, iriId } = require('../../packages/model/lib/ids.js');

/** Completion points of one app (withFixtureApp). */
function seams({ page, cli, waitUntil }) {
  /** The model state of the window: snapshot revision and change, the selection and the state of its backend answer. */
  const windowState = () => cli('eval', `const s = ctx.selection, m = ctx.model.snapshot;
    return { revision: m.revision, change: m.change?.reason, dirty: m.dirty, selection: s.selection, answered: s.answer.revision,
      answerCurrent: s.answer.selection === s.selection, quiet: !!s.quiet, inFlight: !!s.inFlight }`);
  /** Wait until the window has the snapshot of `revision` and the backend answer of its selection for it (no read pending). */
  const processed = (revision, what, also = () => true) => waitUntil(`the window has processed revision ${revision} (${what})`, windowState,
    s => s.revision === revision && s.answered === revision && s.answerCurrent && !s.quiet && !s.inFlight && also(s));
  /**
   * Two animation frames, each followed by a macrotask: Lumino update requests and React renders that the window posted have run.
   * Then one RPC on the frontend connection: the backend has handled the reads that the window sent before it (synchronous reads,
   * handled in arrival order).
   */
  const drain = async () => {
    await page.evaluate(() => new Promise(resolve => {
      const step = n => n ? requestAnimationFrame(() => setTimeout(() => step(n - 1), 0)) : resolve();
      step(2);
    }));
    cli('eval', 'await ctx.model.service.getSnapshot(); return true');
  };
  /**
   * An answered RequestTypeHintsAction on the canvas of `view`: a read that changes no session state. The GLSP server handles the
   * actions of a session in order: the answer comes after the actions that the canvas sent before it.
   */
  const glspAck = view => cli('eval', `const w = ctx.editors.find(${JSON.stringify(view)});
    const r = await w.actionDispatcher.request({ kind: 'requestTypeHints', requestId: 'e2e-ack-' + Math.random().toString(36).slice(2) });
    return r.kind`);
  const revision = () => cli('model', 'revision');
  return { windowState, processed, drain, glspAck, revision };
}

// The panel rules are unit tests: law_hiddenPanelNoRead (modeler/test/panel-reads.test.ts), law_saveKeepsRevision
// (packages/rdf/test/store.test.ts, modeler/test/panel-reads.test.ts). Their browser scenario stalled on CI after the right panel showed
// again (spec/open.md) and was removed. law_hiddenCanvasRefreshesOnce also has a unit test (modeler/test/view-session.test.ts).
// The canvas tells the server when its tab is hidden (catenarySetVisible): a change while hidden gives no refresh of the canvas.
// The show gives the canvas the change.
test('browser: law_hiddenCanvasRefreshesOnce: a change while the canvas is hidden gives no refresh, the show gives the change', { timeout: 90000 }, t => withFixtureApp(t, 'canvas-hidden', async app => {
  const { page, cli, workspace, logs } = app;
  const { processed, drain, glspAck, revision } = seams(app);
  cli('rpc', 'setSettings', JSON.stringify({ validation: 'off' }));
  const view = cli('model', 'files').views[0].view;
  const created = cli('exec', JSON.stringify({ kind: 'createInstance', classIri: 'urn:test:Panel', label: 'Panel before', view, at: { x: 200, y: 200 } })).result;
  assert.equal(created.ok, true);
  cli('eval', `await ctx.editors.open(${JSON.stringify(view)}); return true`);
  const card = () => page.locator('svg.sprotty-graph:visible g.card').filter({ hasText: /^Panel/ });
  await card().filter({ hasText: 'Panel before' }).waitFor();
  const canvasId = cli('eval', 'ctx.shell.currentWidget.id');
  assert.equal(cli('run', 'catenary.openAs', JSON.stringify(path.join(workspace, 'data.ttl')), '"Source"').status, 'done');
  await page.locator('svg.sprotty-graph:visible').waitFor({ state: 'hidden' });
  // The hide of the canvas is a notification without an answer. An answered request after it: the server has handled the hide.
  glspAck(view);
  cli('rpc', 'setTracing', 'true');
  t.after(() => { try { cli('rpc', 'setTracing', 'false'); } catch {} });
  cli('rpc', 'clearTrace');
  cli('exec', JSON.stringify({ kind: 'rename', id: created.id, label: 'Panel hidden' }));
  await processed(revision(), 'rename while the canvas is hidden');
  await drain();
  glspAck(view);
  const refreshes = () => cli('rpc', 'trace', '0').result.spans.filter(s => s.kind === 'refresh' && s.name.startsWith('view ')).map(s => s.name);
  assert.deepEqual(refreshes(), [], 'a hidden canvas gets no refresh');
  // The show is a request: its answer comes after the refresh of the show (whenShowUpdated).
  cli('eval', `await ctx.shell.activateWidget(${JSON.stringify(canvasId)}); await ctx.editors.find(${JSON.stringify(view)}).whenShowUpdated(); return true`);
  await card().filter({ hasText: 'Panel hidden' }).waitFor();
  assert.ok(!logs.some(l => l.includes('Missing handler for action')), logs.filter(l => l.includes('Missing handler')).join('\n'));
  cli('rpc', 'setTracing', 'false');
}));

test('browser: Trace performance metrics record model input and stop on pause', { timeout: 90000 }, t => withFixtureApp(t, 'trace-metrics', async app => {
  const { page, cli } = app;
  const { drain } = seams(app);
  cli('rpc', 'setSettings', JSON.stringify({ validation: 'off' }));
  const view = cli('model', 'files').views[0].view;
  assert.equal(cli('exec', JSON.stringify({ kind: 'createInstance', classIri: 'urn:test:Metric', label: 'Metric card', view, at: { x: 200, y: 200 } })).result.ok, true);
  cli('eval', `await ctx.editors.open(${JSON.stringify(view)}); ctx.selection.set({ids: []}); return true`);
  cli('run', 'catenary.toggleTrace');
  const panel = page.locator('#catenary-trace');
  await panel.getByRole('table', { name: 'Performance metrics' }).waitFor();
  /** The rendered metrics: row label (exact) to value text. */
  const metrics = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#catenary-trace table[aria-label="Performance metrics"] tr')]
    .filter(r => r.querySelector('th')).map(r => [r.querySelector('th').textContent, r.querySelector('td')?.textContent ?? ''])));
  /** The recording state of the panel and of the backend, and the rendered metrics. */
  const traceState = async () => ({ ...cli('eval', `const w = ctx.shell.getWidgetById('catenary-trace');
      return { recording: w.recording, backendRecording: w.backendRecording, timer: w.timer !== undefined, polling: w.polling, paused: w.paused, seq: w.seq }`),
    backendOn: cli('rpc', 'trace', '0').result.on, metrics: await metrics() });
  // The start of the panel has ended: the backend records and the poll timer runs.
  await app.waitUntil('the Trace panel records with its poll timer', traceState, s => s.recording && s.backendRecording && s.timer && s.backendOn);
  await panel.getByRole('button', { name: 'Clear', exact: true }).click();
  // The clear sends clearTrace on the frontend connection: a later RPC on it ends after the clear.
  await drain();
  const card = page.locator('svg.sprotty-graph:visible g.card').filter({ hasText: 'Metric card' }).first();
  await card.locator('.card-name').first().click();
  cli('rpc', 'view', JSON.stringify(view));
  const sampled = (await app.waitUntil('the Trace panel shows the samples and the totals of the input', traceState, s => {
    const m = s.metrics;
    return /p50 .*p95 .*samples/.test(m['First model update']) && /p50 .*p95 .*samples/.test(m['Backend event-loop delay'])
      && Number(m['RPC count']) > 0 && /[\d.]+ ms/.test(m['RDF query time']) && Number(m['Full-view reads']) >= 1;
  })).metrics;
  assert.match(sampled['First model update'], /p50 .*p95 .*samples/);
  assert.match(sampled['Backend event-loop delay'], /p50 .*p95 .*samples/);
  assert.ok(Number(sampled['RPC count']) > 0);
  assert.match(sampled['RDF query time'], /[\d.]+ ms/);
  assert.ok(Number(sampled['Full-view reads']) >= 1);
  // Stop the poll timer to reproduce Pause before the next poll deterministically. A poll on the way ends first, and the window
  // renders its result: after that, only the final batch of Pause can change the totals.
  cli('eval', `clearInterval(ctx.shell.getWidgetById('catenary-trace').timer); return true`);
  await app.waitUntil('no poll of the Trace panel is on the way', traceState, s => !s.polling);
  await drain();
  const readsBeforePause = Number((await metrics())['Full-view reads']);
  cli('rpc', 'view', JSON.stringify(view));
  await panel.getByRole('button', { name: 'Pause', exact: true }).click();
  await app.waitUntil(`the final batch of Pause shows more than ${readsBeforePause} full-view reads`, traceState,
    s => s.paused && !s.recording && Number(s.metrics['Full-view reads']) > readsBeforePause);
  assert.equal(cli('rpc', 'trace', '0').result.on, false);
  await panel.getByRole('button', { name: 'Clear', exact: true }).click();
  const cleared = (await app.waitUntil('the Trace panel shows the cleared metrics', traceState, s => s.metrics['First model update'] === 'No samples'
    && s.metrics['Backend event-loop delay'] === 'No samples' && s.metrics['RPC count'] === '0')).metrics;
  assert.equal(cleared['First model update'], 'No samples');
  assert.equal(cleared['Backend event-loop delay'], 'No samples');
  assert.equal(cleared['RPC count'], '0');
}));

test('browser: law_oneSelectionPerWindow: a click selects in its canvas only, the canvas of another view highlights, Ctrl+click adds from it', { timeout: 60000 }, t => withFixtureApp(t, 'one-selection', async app => {
  const { page, cli } = app;
  const { windowState, processed, drain, glspAck, revision } = seams(app);
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
  const names = { [left]: 'left', [right]: 'right', [one]: 'one', [two]: 'two' };
  const elementsOf = s => s.ids.map(id => cli('eval', `return ctx.editors.elementIn(${JSON.stringify(s.view)}, ${JSON.stringify(id)})`));
  /** The selection (view and elements), the counts and the classes of both cards in both canvases. Names: left, right, one, two. */
  const observed = async () => {
    const s = windowState();
    const state = { revision: s.revision, view: names[s.selection.view] ?? s.selection.view ?? null, elements: elementsOf(s.selection).map(id => names[id] ?? id).sort(), counts: counts() };
    for (const v of [left, right]) for (const id of [one, two]) {
      const c = await classes(v, id);
      state[`${names[v]} ${names[id]}`] = ['selected', 'catenary-highlight'].filter(k => c.includes(k)).join(' ') || '-';
    }
    return state;
  };
  const settled = async (description, until) => { const s = await app.waitUntil(description, observed, until); await drain(); return s; };
  await node(left, one).locator('.card-name').first().click();
  await settled('the click selects one in left and right highlights it', s => s.view === 'left' && s.elements.join() === 'one'
    && s['left one'] === 'selected' && s['right one'] === 'catenary-highlight');
  // One click: one selection event and one SelectAction, in the canvas of the click. The other canvas highlights the element.
  assert.deepEqual(counts(), { events: 1, selects: { [left]: 1 } });
  assert.ok((await classes(left, one)).includes('selected'));
  assert.ok((await classes(right, one)).includes('catenary-highlight'));
  assert.ok(!(await classes(right, one)).includes('selected'));
  // A model change sends no SelectAction to the canvases.
  exec({ kind: 'rename', id: one, label: 'Shared one renamed' });
  await node(right, one).filter({ hasText: 'Shared one renamed' }).waitFor();
  await processed(revision(), 'rename of one');
  await drain();
  for (const v of [left, right]) glspAck(v);
  assert.deepEqual(counts().selects, { [left]: 1 });
  // Ctrl+click in the highlighting canvas adds: that canvas becomes the origin, and the first canvas highlights both.
  await node(right, two).locator('.card-name').first().click({ modifiers: ['Control'] });
  await settled('Ctrl+click adds two from right', s => s.view === 'right' && s.elements.join() === 'one,two'
    && s['right one'] === 'selected' && s['right two'] === 'selected' && s['left one'] === 'catenary-highlight' && s['left two'] === 'catenary-highlight');
  const selection = cli('eval', 'return ctx.selection.selection');
  assert.equal(selection.view, right);
  assert.deepEqual(selection.ids.map(id => cli('eval', `return ctx.editors.elementIn(${JSON.stringify(right)}, ${JSON.stringify(id)})`)).sort(), [one, two].sort());
  for (const id of [one, two]) {
    assert.ok((await classes(right, id)).includes('selected'), `${id} selected in the origin`);
    assert.ok((await classes(left, id)).includes('catenary-highlight'), `${id} highlighted in the other canvas`);
    assert.ok(!(await classes(left, id)).includes('selected'), `${id} not selected in the other canvas`);
  }
  // law_highlightKeys: Ctrl+click on a highlighted card removes it; that canvas becomes the origin with the rest of the highlight.
  await node(left, one).locator('.card-name').first().click({ modifiers: ['Control'] });
  await settled('Ctrl+click on the highlighted one in left removes it', s => s.view === 'left' && s.elements.join() === 'two'
    && s['left one'] === '-' && s['left two'] === 'selected' && s['right one'] === '-');
  let now = cli('eval', 'return ctx.selection.selection');
  assert.equal(now.view, left);
  assert.deepEqual(elementsOf(now), [two]);
  assert.ok(!(await classes(left, one)).includes('selected'));
  assert.ok((await classes(left, two)).includes('selected'));
  assert.ok(!(await classes(right, one)).includes('catenary-highlight'));
  // Ctrl+click twice on the same card of the other canvas: the first removes it (it is highlighted), the second adds it.
  await node(right, two).locator('.card-name').first().click({ modifiers: ['Control'] });
  await settled('Ctrl+click on the highlighted two in right removes it', s => s.view === 'right' && s.elements.length === 0
    && s['right two'] === '-' && s['left two'] === '-');
  now = cli('eval', 'return ctx.selection.selection');
  assert.deepEqual(now, { view: right, ids: [] });
  assert.ok(!(await classes(right, two)).includes('selected'));
  assert.ok(!(await classes(left, two)).includes('catenary-highlight'));
  await node(right, two).locator('.card-name').first().click({ modifiers: ['Control'] });
  await settled('the second Ctrl+click on two in right adds it', s => s.view === 'right' && s.elements.join() === 'two' && s['right two'] === 'selected');
  now = cli('eval', 'return ctx.selection.selection');
  assert.equal(now.view, right);
  assert.deepEqual(elementsOf(now), [two]);
  assert.ok((await classes(right, two)).includes('selected'));
  // law_highlightKeys: a listing selection and keys in a focused canvas. Del removes nothing (no origin), Ctrl+C copies the
  // highlight (the paste finds it in the view: ui-manifest §5.8), Ctrl+Del deletes the element of the window selection.
  const cards = view => cli('rpc', 'view', JSON.stringify(view)).result.boxes.length;
  const focusRight = () => cli('eval', `const w = ctx.editors.find(${JSON.stringify(right)}); await ctx.shell.activateWidget(w.id); w.node.querySelector('svg.sprotty-graph').focus(); return true`);
  cli('eval', `ctx.selection.set({ ids: [${JSON.stringify(one)}] }); return true`);
  await settled('the listing selection of one highlights it in right', s => s.view === null && s.elements.join() === 'one' && s['right one'] === 'catenary-highlight');
  assert.ok((await classes(right, one)).includes('catenary-highlight'));
  focusRight();
  const before = cards(right), revisionBefore = revision();
  await page.keyboard.press('Delete');
  // Del sends nothing: flush the window, the frontend connection and the session of the canvas, then compare.
  await drain();
  glspAck(right);
  assert.equal(before, 2);
  assert.equal(revision(), revisionBefore, 'Del without an origin runs no command');
  assert.equal(cards(right), before, 'Del without an origin removes nothing');
  // The copy writes its clip in the copy event of the key press. The paste notification below is the completion of the pair.
  await page.keyboard.press('Control+c');
  await drain();
  focusRight();
  await page.keyboard.press('Control+v');
  await page.locator('.theia-notification-list-item', { hasText: 'Placed 0. Skipped 1 already in this view.' }).first().waitFor();
  assert.equal(cards(right), before, 'the paste of the copied highlight places the same element: the view shows it');
  cli('eval', `ctx.selection.set({ ids: [${JSON.stringify(one)}] }); return true`);
  await settled('the listing selection of one before Ctrl+Del', s => s.view === null && s.elements.join() === 'one' && s['right one'] === 'catenary-highlight');
  focusRight();
  await page.keyboard.press('Control+Delete');
  await page.locator('.dialogBlock .theia-button.main').click();
  await app.waitUntil('Ctrl+Del has deleted one', () => cli('rpc', 'search').result.map(h => h.id), ids => !ids.includes(one));
}));

test('browser: a drag of an edge line adds a bend, a double-click on the bend removes it (UI §7.4)', { timeout: 90000 }, t => withFixtureApp(t, 'bends', async app => {
  const { page, cli, workspace } = app;
  const { drain, glspAck, revision } = seams(app);
  cli('rpc', 'open', JSON.stringify(path.join(workspace, 'workspace.trig')));
  const view = iriId('urn:name:Product%20context');
  cli('eval', `await ctx.editors.open(${JSON.stringify(view)}); return true`);
  const canvas = page.locator('svg.sprotty-graph:visible');
  await canvas.waitFor();
  // Theia removes its loading screen after a fade: until then it is on top and takes the presses of the line drag.
  await page.locator('.theia-preload').waitFor({ state: 'detached' });
  const file = path.join(workspace, 'views', 'product-context.view.trig');
  const vertices = () => (fs.readFileSync(file, 'utf8').match(/view:vertices "([^"]*)"/) ?? [])[1];
  assert.equal(vertices(), undefined);
  // The whole view in the viewport, then the middle of the line of the first relation edge, on screen. A flat line has an empty
  // bounding box: Playwright calls it hidden, so wait for it attached. The fit is not animated: its dispatch ends with the new
  // viewport, and the frame flush draws it.
  cli('eval', `const w = ctx.editors.find(${JSON.stringify(view)}); await w.actionDispatcher.dispatch({ kind: 'fit', elementIds: [], padding: 40, maxZoom: 1, animate: false }); return true`);
  await drain();
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
  /** The saved bend, the backend revision and the drawn route of the edge. */
  const bendState = async () => ({ vertices: vertices() ?? null, revision: revision(), route: await line.getAttribute('d') });
  const straight = await line.getAttribute('d');
  let at = await middle();
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 30, at.y + 90, { steps: 8 });
  await page.mouse.up();
  // The bend is saved in the view file and drawn on the canvas.
  await app.waitUntil('the view file holds the bend and the canvas draws it', bendState, s => s.vertices !== null && s.route !== straight);
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
  // law_bendClickSendsNothing). Completion: the window and the canvas session are flushed, and the revision is the same.
  let revisionBefore = revision();
  let c = await handleCenter();
  await page.mouse.click(c.x + 3, c.y + 3);
  await drain();
  glspAck(view);
  assert.equal(revision(), revisionBefore, 'a click on a bend handle runs no command');
  assert.equal(vertices(), saved, 'a click on a bend handle changes nothing in the view file');
  assert.equal(await drawn(), drawnBefore, 'a click on a bend handle keeps the drawn route');
  // The view file is locked: a drag of the handle asks to unlock it; Cancel refuses the edit, and the drawn route goes back to the
  // saved one (law_refusedBendKeepsSaved).
  assert.equal(cli('rpc', 'setImported', JSON.stringify(file), 'true').result.ok, true);
  revisionBefore = revision();
  c = await handleCenter();
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y + 40, { steps: 6 });
  await page.mouse.up();
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await cancel.click();
  await cancel.waitFor({ state: 'detached' });
  await drain();
  glspAck(view);
  assert.equal(revision(), revisionBefore, 'a refused bend edit runs no command');
  assert.equal(vertices(), saved, 'a refused bend edit leaves the view file');
  // The dialog can take the selection with it (open.md BEND3): a click on the line selects the edge again.
  at = await middle();
  await page.mouse.click(at.x, at.y);
  await handle.waitFor();
  await app.waitUntil('the canvas draws the saved route after the refused edit', async () => ({ ...await bendState(), drawn: await drawn() }), s => s.drawn === drawnBefore);
  assert.equal(await drawn(), drawnBefore, 'a refused bend edit restores the drawn route');
  assert.equal(cli('rpc', 'setImported', JSON.stringify(file), 'false').result.ok, true);
  // A double-click on the handle, off its center, removes the bend with one command: one undo restores the saved route.
  c = await handleCenter();
  await page.mouse.dblclick(c.x + 3, c.y + 3);
  await app.waitUntil('the bend is removed from the view file', bendState, s => s.vertices === null);
  await handle.waitFor({ state: 'detached' });
  cli('run', 'catenary.undo');
  await app.waitUntil('one undo restores the bend where it was', bendState, s => s.vertices === saved);
}));

test('browser: law_disabledGestureShowsReason: a click on a predicate that no file declares, and F12, show the reason each time; law_gatheredRowPerStatement: a card line with other names has a tooltip and drags the card', { timeout: 60000 }, t => withApp(t, 'disabled-gesture', {
  fixture: workspace => {
    fs.writeFileSync(path.join(workspace, 'workspace.trig'), `@prefix ws: <https://cristianvasquez.github.io/catenary/vocab/workspace#> .
    <urn:name:workspace> { <urn:name:workspace> a ws:Workspace; ws:placeInstances "data.ttl" . }`);
    fs.writeFileSync(path.join(workspace, 'data.ttl'), `<urn:x:a> a <urn:x:Thing> ; <http://www.w3.org/2000/01/rdf-schema#label> "A" ; <urn:x:undeclared> <urn:x:b> .
<urn:x:b> a <urn:x:Thing> ; <http://www.w3.org/2000/01/rdf-schema#label> "B" .
<urn:x:a> <urn:x:p> "v" .\n`);
    // Two node shapes with the path urn:x:p and different names: one card line "first: v" with the tooltip of the other name.
    fs.writeFileSync(path.join(workspace, 'shapes.ttl'), `@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:x:S1> a sh:NodeShape ; sh:targetClass <urn:x:Thing> ; sh:property [ sh:path <urn:x:p> ; sh:name "first" ] .
<urn:x:S2> a sh:NodeShape ; sh:targetClass <urn:x:Thing> ; sh:property [ sh:path <urn:x:p> ; sh:name "second" ] .\n`);
  },
  ready: '#theia-main-content-panel'
}, async ({ page, cli, workspace, errors, waitUntil }) => {
  cli('rpc', 'open', JSON.stringify(path.join(workspace, 'workspace.trig')));
  const REASON = 'No file and no view has the element.';
  const predicate = 'urn:x:undeclared', pid = iriId(predicate);
  const rid = `r-${escapeId('urn:x:a')}-${escapeId(predicate)}-${escapeId('urn:x:b')}`;
  const lastSeq = () => cli('messages').at(-1)?.seq ?? 0;
  const shown = since => waitUntil(`the message "${REASON}" after message ${since}`, () => cli('messages', '--since', String(since)),
    messages => messages.some(m => m.text === REASON));
  // The answer for a target is cached as disabled: the command registry reports Open in… disabled.
  const cachedDisabled = arg => waitUntil('the cached answer: Open in… disabled', () => cli('eval', `return ctx.commands.isEnabled('catenary.openIn'${arg ? `, ${JSON.stringify(arg)}` : ''})`), enabled => enabled === false);

  // The relation on a canvas: the canvas selection is the Theia selection that the Properties panel shows.
  const exec = command => cli('exec', JSON.stringify(command)).result;
  const view = exec({ kind: 'createView', label: 'Gesture' }).id;
  assert.equal(exec({ kind: 'addToView', view, ids: [iriId('urn:x:a'), iriId('urn:x:b')], at: { x: 100, y: 100 } }).ok, true);
  cli('eval', `await ctx.editors.open(${JSON.stringify(view)}); return true`);
  await page.locator('svg.sprotty-graph:visible').waitFor();
  cli('eval', `ctx.selection.set({ view: ${JSON.stringify(view)}, ids: [${JSON.stringify(rid)}] }); await ctx.shell.revealWidget('property-view'); return true`);
  const link = page.locator('#catenary-properties a.catenary-link[title="urn:x:undeclared"]');
  await link.waitFor();
  // First click: no answer yet, or a cached one. Second click: the answer is cached as disabled (Theia does not run the command).
  let since = lastSeq();
  await link.click();
  await shown(since);
  await cachedDisabled({ ids: [pid] });
  since = lastSeq();
  await link.click();
  await shown(since);
  // F12 on a window selection whose cached answer is disabled: the key shows the reason.
  cli('eval', `ctx.selection.set({ ids: [${JSON.stringify(pid)}] }); return true`);
  await cachedDisabled();
  since = lastSeq();
  await page.keyboard.press('F12');
  await shown(since);
  // law_gatheredRowPerStatement: one card line for the statement, its tooltip names the other sh:name, and the line takes the hover.
  await page.locator('.theia-preload').waitFor({ state: 'detached' });
  const lines = page.locator('svg.sprotty-graph:visible .catenary-card .card-line');
  await waitUntil('the card of A shows one line for urn:x:p', () => lines.allTextContents(), texts => texts.filter(s => s === 'first: v').length === 1);
  assert.deepEqual((await lines.allTextContents()).filter(s => s.endsWith(': v')), ['first: v']);
  const titled = page.locator('svg.sprotty-graph:visible .catenary-card .card-line[title]');
  assert.equal(await titled.count(), 1);
  assert.equal(await titled.getAttribute('title'), 'Also named: second');
  const center = async () => { const b = await titled.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const at = await center();
  assert.equal(await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e?.classList.contains('card-line') ? e.getAttribute('title') : e?.outerHTML.slice(0, 120); }, at),
    'Also named: second', 'the titled line is the hit target at its center');
  // A drag that starts on the titled line moves the card.
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 80, at.y + 60, { steps: 8 });
  await page.mouse.up();
  await waitUntil('the card moved with the drag from its titled line', center, c => Math.abs(c.x - at.x - 80) < 4 && Math.abs(c.y - at.y - 60) < 4);
  assert.deepEqual(errors, []);
}));
