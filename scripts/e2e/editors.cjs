// Browser scenarios of the editors: source language, file presentations, file explorer, notes, targets, Links, Find, view URL, open-view,
// layout, CLI layout, Properties and Markdown.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, root, withApp, withFixtureApp, copyFixtures, navigator, navNode } = require('./harness.cjs');
const { iriId } = require('../../packages/model/lib/ids.js');

const failed = Symbol('failed');
/**
 * app.waitUntil, but an error of `observe` ends the wait at once: a CLI connection reset or a refused request is not retried into
 * success. The error names the condition and gives the last observed state.
 */
const strictWait = app => async (description, observe, until = Boolean, options) => {
  let last = '(not observed)';
  const state = await app.waitUntil(description, async () => {
    try { return last = await observe(); } catch (e) { return { [failed]: e }; }
  }, s => Boolean(s?.[failed]) || until(s), options);
  const e = state?.[failed];
  if (e) throw new Error(`Stopped waiting until ${description}: ${e.message}. Last observed state: ${JSON.stringify(last)}`, { cause: e });
  return state;
};

/**
 * E2E_REPLY_DELAY_MS=<n>: every reply of the model service of the window (ctx.model.service) arrives n ms late. A focused run
 * with a delay checks that the scenario waits for states, not for times. Install again after a page load.
 */
/** The connection times of the windows of the CLI bridge. */
const connectedWindows = cli => cli('status').windows.map(w => w.connectedAt);
/** After a page load: wait until the CLI bridge has one window, and it is not one of `before`. The CLI uses the newest window. */
const waitForNewWindow = (waitUntil, cli, before) => waitUntil('the CLI bridge has only the window of the new page', () => connectedWindows(cli),
  now => now.length === 1 && !before.includes(now[0]), { timeout: 15000 });

const replyDelay = Number(process.env.E2E_REPLY_DELAY_MS) || 0;
const delayReplies = cli => {
  if (!replyDelay) return;
  cli('eval', `const service = ctx.model.service, delay = ${replyDelay};
    ctx.model.service = new Proxy(service, { get(t, name) {
      const v = Reflect.get(t, name);
      if (typeof v !== 'function' || name === 'then') return v;
      return (...args) => Promise.resolve(v.apply(t, args)).then(
        r => new Promise(resolve => setTimeout(() => resolve(r), delay)),
        e => new Promise((_, reject) => setTimeout(() => reject(e), delay)));
    } }); return true`);
};

test('browser: Turtle and TriG source language detection and token colors', { timeout: 45000 }, t => withFixtureApp(t, 'rdf-source', async ({ page, cli, workspace, logs }) => {
  // withApp waits for the CLI bridge (phase "CLI bridge").
  delayReplies(cli);
  const status = cli('status');
  assert.ok(status.windows.length, 'CLI browser bridge is connected');
  assert.equal(status.build.stale, false);
  assert.equal(status.build.restartNeeded, false);
  assert.ok(status.windows.every(w => w.reloadNeeded === false));
  await navigator(page);
  for (const [file, language] of [['data.ttl', 'turtle'], ['workspace.trig', 'trig']]) {
    // Both files expose Source through the same presentation command.
    assert.equal(cli('run', 'catenary.openAs', JSON.stringify(path.join(workspace, file)), JSON.stringify('Source')).status, 'done');
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
}));

test('browser: file presentations use document panes, focus existing panes and restore splits', { timeout: 90000 }, t => withFixtureApp(t, 'presentations', async app => {
  const { page, cli, dir, workspace } = app;
  const waitUntil = strictWait(app);
  delayReplies(cli);
  const data = path.join(workspace, 'data.ttl'), settings = path.join(workspace, 'workspace.trig');
  const main = '#theia-main-content-panel';
  const modelId = file => 'catenary-file-explorer:' + file;
  const pane = id => page.locator(`[id=${JSON.stringify(id)}]`);
  const current = () => cli('eval', 'ctx.shell.currentWidget.id');
  const open = (file, presentation, beside = false) => {
    assert.equal(cli('run', beside ? 'catenary.openBeside' : 'catenary.openAs', JSON.stringify(file), JSON.stringify(presentation)).status, 'done');
    return current();
  };
  const widgets = () => cli('eval', "ctx.shell.getWidgets('main').map(w => w.id)");
  assert.equal(await page.locator('#catenary-model-explorer').count(), 0);
  assert.equal(cli('commands', 'catenary.toggleModel', '--all').length, 0);
  assert.equal(cli('commands', 'catenary.workspaceSettings', '--all').length, 0);
  await navigator(page);
  // law_modelFileDefaultsToModel
  await navNode(page, 'data.ttl').first().dblclick();
  await pane(modelId(data)).waitFor();
  assert.ok(await page.locator(main).locator(`[id=${JSON.stringify(modelId(data))}]`).count(), 'Model is a main-area document');
  const tree = pane(modelId(data));
  await tree.getByRole('textbox', { name: 'Filter model elements', exact: true }).fill('agent');
  const sourceId = open(data, 'Source', true);
  await pane(sourceId).locator('.monaco-editor').waitFor();
  const before = await tree.boundingBox(), after = await pane(sourceId).boundingBox();
  assert.ok(before && after && after.x >= before.x + before.width - 2, 'Source opens beside Model');
  assert.equal(open(data, 'Model', true), modelId(data));
  assert.equal(await tree.getByRole('textbox', { name: 'Filter model elements', exact: true }).inputValue(), 'agent');
  // law_reopenKeepsDocuments
  const count = widgets().length;
  assert.equal(open(data, 'Source', true), sourceId);
  assert.equal(widgets().length, count, 'reopening Source does not clone it');
  // law_oneChoiceOpensAtOnce: Source's toolbar resolves the same file and leaves out Source. Model is the one choice: it opens with no pick.
  const openAsButton = () => page.locator(`[id=${JSON.stringify('catenary.openAs')}]`).filter({ visible: true }).last();
  await openAsButton().click();
  await waitUntil('Open as from Source makes Model the current pane', current, id => id === modelId(data));
  assert.equal(await page.locator('.quick-input-widget').filter({ visible: true }).count(), 0, 'no quick pick');
  // Ctrl+click opens beside: the Model pane opens in a new split next to Source.
  cli('eval', `await ctx.shell.closeWidget(${JSON.stringify(modelId(data))}); await ctx.shell.activateWidget(${JSON.stringify(sourceId)}); return true`);
  const tabBars = () => page.locator(main).locator('.lm-TabBar').count();
  const barsBefore = await tabBars();
  await openAsButton().click({ modifiers: ['ControlOrMeta'] });
  await pane(modelId(data)).waitFor();
  assert.equal(await tabBars(), barsBefore + 1, 'Ctrl+click opens Model in a split');
  assert.equal(await page.locator('.quick-input-widget').filter({ visible: true }).count(), 0, 'no quick pick');
  // law_workspaceHasSourceAndModel: workspace defaults to Settings; Source and Model remain available without changing metadata storage.
  await navigator(page);
  await navNode(page, 'workspace.trig').first().dblclick();
  await page.locator('.catenary-workspace-settings').waitFor();
  const settingsId = 'catenary-workspace-settings';
  assert.ok(widgets().includes(settingsId));
  open(settings, 'Settings');
  const wsSource = open(settings, 'Source', true);
  assert.equal(open(settings, 'Settings', true), settingsId);
  assert.equal(open(settings, 'Model', true), modelId(settings));
  assert.equal(open(settings, 'Source', true), wsSource);
  // A view file defaults to Canvas. File navigation does not alter the resource selection.
  const viewFile = cli('eval', 'ctx.model.snapshot.files.views[0].path');
  const view = cli('eval', 'ctx.model.snapshot.files.views[0].view');
  const canvasId = open(viewFile, 'Canvas');
  const selection = cli('ui').selection;
  const viewModel = open(viewFile, 'Model', true);
  assert.equal(viewModel, modelId(viewFile));
  assert.equal(open(viewFile, 'Canvas', true), canvasId);
  assert.deepEqual(cli('ui').selection, selection);
  // law_openInSkipsCurrent: Open in… is one action for every pane. It leaves out the current pane, opens one target at once, asks between several.
  assert.equal(cli('exec', JSON.stringify({ kind: 'createNodeShape', label: 'Reveal class', targetClass: 'urn:test:Reveal' })).result.ok, true);
  const instance = cli('exec', JSON.stringify({ kind: 'createInstance', classIri: 'urn:test:Reveal', label: 'Reveal me' })).result;
  assert.equal(instance.ok, true);
  // The Source target has a line when the saved file has the instance.
  const source = await waitUntil('the Source target of the instance has a line',
    () => cli('rpc', 'openTargets', JSON.stringify(instance.id)).result.find(t => t.presentation === 'Source'), s => Boolean(s?.line));
  open(data, 'Model');
  await tree.getByRole('textbox', { name: 'Filter model elements', exact: true }).fill('reveal me');
  const revealRow = tree.locator('.catenary-tree-name').filter({ hasText: /^Reveal me$/ });
  const selectRow = async () => {
    await revealRow.click();
    await tree.locator('.theia-mod-selected .catenary-tree-name').filter({ hasText: /^Reveal me$/ }).waitFor();
  };
  // From its Model pane, before any view places it: Source is the only other pane. A double-click opens it at the statement.
  // law_gestureNoQuietWait: the double-click comes within the quiet time of the row selection.
  await selectRow();
  await revealRow.dblclick();
  await waitUntil('the double-click makes Source the current pane', current, id => id === sourceId);
  assert.deepEqual(cli('eval', 'const c = ctx.shell.currentWidget.editor.cursor; return [c.line, c.character]'), [source.line - 1, source.column - 1]);
  // Placed in a view: Enter in the tree asks between Source and Canvas.
  assert.equal(cli('exec', JSON.stringify({ kind: 'addToView', view, ids: [instance.id], at: { x: 0, y: 0 } })).result.ok, true);
  open(data, 'Model');
  await selectRow();
  await page.keyboard.press('Enter');
  const picks = page.locator('.quick-input-list .monaco-list-row');
  const pickLabels = () => picks.evaluateAll(rows => rows.map(r => r.querySelector('.label-name')?.textContent).sort());
  await picks.first().waitFor();
  assert.deepEqual(await pickLabels(), ['Canvas', 'Source']);
  // law_revealAfterShowUpdate: the canvas was hidden when addToView placed the card; the reveal centers it after the show update.
  await picks.filter({ has: page.locator('.label-name', { hasText: /^Canvas$/ }) }).first().click();
  await page.locator('svg.sprotty-graph:visible g.card').filter({ hasText: 'Reveal me' }).waitFor();
  // On the canvas, F12 on the selected card asks between Source and Model. Model reveals the row.
  assert.equal(current(), canvasId);
  await page.locator('svg.sprotty-graph:visible g.card').filter({ hasText: 'Reveal me' }).locator('.card-name').first().click();
  await page.keyboard.press('F12');
  await picks.first().waitFor();
  assert.deepEqual(await pickLabels(), ['Model', 'Source']);
  await picks.filter({ has: page.locator('.label-name', { hasText: /^Model$/ }) }).first().click();
  await tree.locator('.theia-mod-selected .catenary-tree-name').filter({ hasText: /^Reveal me$/ }).waitFor();
  assert.equal(current(), modelId(data));
  // The ordinary shell layout can move the Model document into a vertical split.
  open(data, 'Source');
  cli('eval', `const all = ctx.shell.getWidgets('main'); const w = all.find(w => w.id === ${JSON.stringify(modelId(data))}); const ref = all.find(w => w.id === ${JSON.stringify(sourceId)}); ctx.shell.addWidget(w, { area: 'main', mode: 'split-bottom', ref }); await ctx.shell.activateWidget(w.id); return true`);
  await tree.waitFor();
  const moved = await tree.boundingBox(), above = await pane(sourceId).boundingBox();
  assert.ok(moved && above && moved.y >= above.y + above.height - 2, 'Model can move into a split below Source');
  assert.equal(open(data, 'Model', true), modelId(data));
  assert.deepEqual(await tree.boundingBox(), moved, 'reopening keeps the arranged pane in place');
  const ids = widgets().sort();
  const splits = cli('eval', 'Array.from(ctx.shell.mainPanel.tabBars()).length');
  // Theia stores the layout in localStorage when the page unloads (FrontendApplication, windowsService.onUnload). Leave the
  // application for a page of the same origin, read the stored layout there, then load the application again.
  const appUrl = page.url(), windowsBefore = connectedWindows(cli);
  await page.goto(new URL('/catenary-e2e-unloaded', appUrl).href, { waitUntil: 'domcontentloaded' });
  const stored = await page.evaluate(() => Object.keys(localStorage).filter(k => k.endsWith(':layout')).map(k => localStorage.getItem(k)));
  assert.equal(stored.length, 1, 'one stored layout');
  assert.ok(stored[0].includes(JSON.stringify(data).slice(1, -1)), 'the stored layout has the Model presentation of data.ttl');
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await pane(modelId(data)).waitFor({ state: 'attached' });
  await waitForNewWindow(waitUntil, cli, windowsBefore);
  delayReplies(cli);
  assert.deepEqual(widgets().sort(), ids, 'all presentations restore through their existing widget factories');
  assert.equal(cli('eval', 'Array.from(ctx.shell.mainPanel.tabBars()).length'), splits);
  // Files of another workspace offer their presentations. Model first opens the workspace that reads the file.
  assert.equal(cli('eval', 'return (await ctx.model.service.save()).ok'), true, 'save before the workspace switch');
  const other = path.join(dir, 'other');
  fs.cpSync(workspace, other, { recursive: true });
  const otherSettings = path.join(other, 'workspace.trig'), otherView = path.join(other, path.relative(workspace, viewFile));
  for (const file of [otherSettings, otherView]) {
    assert.equal(cli('eval', `return ctx.commands.isVisible('catenary.openAs', ${JSON.stringify(file)})`), true, `Open as is available for ${file}`);
  }
  assert.equal(open(otherView, 'Model', true), modelId(otherView));
  assert.equal(cli('eval', 'return ctx.model.snapshot.file'), otherSettings, 'Model opens the workspace that reads the view file');
}));

test('browser: law_typeToFilter: file explorer menu, fuzzy filter, folder placement and source-only file drop', { timeout: 90000 }, t => withFixtureApp(t, 'file-explorer', async ({ page, cli, workspace }) => {
  delayReplies(cli);
  const source = path.join(workspace, 'data.ttl'), destination = path.join(workspace, 'shapes.ttl');
  const exec = command => { const r = cli('exec', JSON.stringify(command)).result; assert.equal(r.ok, true, JSON.stringify(r)); return r; };
  exec({ kind: 'createNodeShape', label: 'Transfer shape', targetClass: 'urn:test:Transfer' });
  const first = exec({ kind: 'createInstance', classIri: 'urn:test:Transfer', label: 'Alpha Beta' }).id;
  const second = exec({ kind: 'createInstance', classIri: 'urn:test:Transfer', label: 'Hidden member' }).id;
  const view = exec({ kind: 'createView', label: 'Drop target' }).id;
  cli('eval', `await ctx.editors.open(${JSON.stringify(view)}); return true`);
  await page.locator('svg.sprotty-graph:visible').waitFor();
  const openTree = async name => {
    await navigator(page);
    await navNode(page, name).first().click({ button: 'right' });
    await page.locator('.lm-Menu .lm-Menu-itemLabel', { hasText: /^Open beside…$/ }).click();
    await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: /^Model$/ }).click();
    const panel = page.locator(`[id=${JSON.stringify('catenary-file-explorer:' + path.join(workspace, name))}]`);
    await panel.getByRole('textbox', { name: 'Filter model elements', exact: true }).waitFor();
    return panel;
  };
  const tree = await openTree('data.ttl');
  const filterOf = panel => panel.getByRole('textbox', { name: 'Filter model elements', exact: true });
  const name = text => page.locator('.catenary-tree-name').filter({ hasText: new RegExp('^' + text + '$') });
  const row = (panel, text) => panel.locator('.catenary-tree-name').filter({ hasText: new RegExp('^' + text + '$') });
  const nodeOf = (panel, text) => panel.locator('.theia-TreeNode').filter({ has: name(text) }).first();
  // The sections of the plugins: the class folder is in Classes. A folder drag places all its instances.
  await nodeOf(tree, 'Classes').locator('.theia-ExpansionToggle.theia-mod-collapsed').click();
  const key = 'rdfs/class:urn:test:Transfer';
  const folderName = cli('rpc', 'explorerChildren', JSON.stringify('rdfs/classes'), JSON.stringify(source)).result.rows.find(r => r.key === key).name;
  const folder = nodeOf(tree, folderName);
  await folder.waitFor();
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await folder.dispatchEvent('dragstart', { dataTransfer: transfer });
  const payload = await transfer.evaluate(d => JSON.parse(d.getData('application/x-catenary-explorer')));
  assert.deepEqual(payload, { file: source, ids: [], folders: [key] });
  assert.equal(await transfer.evaluate(d => d.getData('application/x-catenary-class')), '');
  await page.locator('svg.sprotty-graph:visible').dispatchEvent('drop', { dataTransfer: transfer, clientX: 650, clientY: 350 });
  await page.locator('svg.sprotty-graph:visible g.card').filter({ hasText: 'Hidden member' }).waitFor();
  assert.deepEqual(cli('rpc', 'explorerElements', JSON.stringify(key), JSON.stringify(source)).result.sort(), [first, second].sort());
  // The filter: one flat list of the matching elements of the file.
  await filterOf(tree).fill('albe');
  await row(tree, 'Alpha Beta').waitFor();
  assert.equal(await row(tree, 'Hidden member').count(), 0);
  assert.equal(await row(tree, 'Alpha Beta').locator('mark').count(), 4);
  // Reopening uses the existing widget and retains its filter.
  const reopened = await openTree('data.ttl');
  const filter = filterOf(reopened);
  assert.equal(await filter.inputValue(), 'albe');
  // Without the filter the tree has its folders again. Typing while a row has focus uses the same filter.
  await filter.fill('');
  await nodeOf(reopened, folderName).locator('.theia-ExpansionToggle.theia-mod-collapsed').click();
  await row(reopened, 'Hidden member').waitFor();
  await row(reopened, 'Alpha Beta').click();
  await page.keyboard.type('albe');
  await row(reopened, 'Hidden member').waitFor({ state: 'hidden', timeout: 3000 });
  assert.equal(await filter.inputValue(), 'albe');
  await filter.fill('zzzz-no-such-element');
  await row(reopened, 'Alpha Beta').waitFor({ state: 'hidden' });
  assert.equal(await reopened.locator('.catenary-tree-name').count(), 0);
  await page.keyboard.press('Escape');
  await row(reopened, 'Hidden member').waitFor();
  assert.equal(await filter.inputValue(), '');
  const target = await openTree('shapes.ttl');
  await target.locator('.catenary-file-tree').dispatchEvent('drop', { dataTransfer: transfer });
  await page.getByText(`Move 2 elements from ${source} to ${destination}? Only statements from the source file move.`, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await filterOf(target).fill('albe');
  await row(target, 'Alpha Beta').waitFor();
  assert.deepEqual(cli('rpc', 'explorerElements', JSON.stringify(key), JSON.stringify(source)).result, []);
  assert.deepEqual(cli('rpc', 'explorerElements', JSON.stringify(key), JSON.stringify(destination)).result.sort(), [first, second].sort());
  assert.equal(cli('rpc', 'undo').result.ok, true);
  assert.deepEqual(cli('rpc', 'explorerElements', JSON.stringify(key), JSON.stringify(source)).result.sort(), [first, second].sort());

}));

test('browser: law_notesSingleEditor: Notes move to native Markdown, autosave and return on close', { timeout: 60000 }, t => withFixtureApp(t, 'view-notes', async app => {
  const { page, cli } = app;
  const waitUntil = strictWait(app);
  delayReplies(cli);
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
  const description = () => cli('rpc', 'properties', JSON.stringify(view)).result.description;
  const documentText = () => cli('eval', 'ctx.shell.currentWidget.editor.document.getText()');
  const dirty = () => cli('eval', 'ctx.shell.currentWidget.editor.document.dirty');
  await waitUntil('typing saves the notes without a button', description, d => d === expected);
  assert.equal(await panel.getByRole('button', { name: 'Save description', exact: true }).count(), 0);
  // Keep a native save in flight while more input arrives. The older completion must not mark the newer text clean.
  // The gate holds each notes save after the backend answered it, until the test releases the gate.
  cli('eval', `const g = globalThis.notesGate = { started: 0, finished: 0, execute: ctx.model.execute };
    g.hold = new Promise(resolve => { g.release = resolve; });
    ctx.model.execute = async c => {
      const r = await g.execute.call(ctx.model, c);
      if (c.kind === 'setViewDescription') { g.started++; await g.hold; g.finished++; }
      return r;
    }; return true`);
  const gate = () => cli('eval', 'const g = globalThis.notesGate; return { started: g.started, finished: g.finished }');
  try {
    await page.keyboard.type(' Slow save.');
    await waitUntil('a notes save starts and the gate holds it', gate, g => g.started >= 1);
    await page.keyboard.type(' New input.');
    expected += ' Slow save. New input.';
    // While the gate holds the saves: the document has the new input, it stays dirty, and no held save has completed.
    await waitUntil('the notes document has the new input', documentText, text => text === expected);
    assert.equal(dirty(), true, 'the document stays dirty while its saves are held');
    assert.equal(gate().finished, 0, 'no held save completes before the release');
  } finally {
    // A failed release must not hide the first failure; the waits below report a release that did not happen.
    try { cli('eval', 'globalThis.notesGate.release(); return true'); } catch (e) { console.error(`view-notes: release of the save gate failed: ${e.message}`); }
  }
  await waitUntil('the saves end with the newest notes', description, d => d === expected);
  await waitUntil('the notes document is clean after the held saves complete', dirty, d => d === false);
  cli('eval', 'ctx.model.execute = globalThis.notesGate.execute; delete globalThis.notesGate; return true');
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

// sh:targetSubjectsOf and sh:targetObjectsOf: the same textarea wiring, one app for both.
test('browser: subject and object targets retain all predicates through Properties edits', { timeout: 60000 }, t => withFixtureApp(t, 'targets', async app => {
  const { page, cli } = app;
  const waitUntil = strictWait(app);
  delayReplies(cli);
  const view = cli('ui').currentView;
  const panel = page.locator('#catenary-properties');
  const targets = id => cli('rpc', 'shapes').result.nodeShapes[id];
  for (const [key, label, words] of [['targetSubjectsOf', 'Subject targets', 'subjects'], ['targetObjectsOf', 'Object targets', 'objects']]) {
    const shape = cli('exec', JSON.stringify({ kind: 'createNodeShape', label, view, at: { x: 0, y: 0 } })).result;
    assert.equal(shape.ok, true);
    cli('exec', JSON.stringify({ kind: 'setNodeShape', id: shape.id, patch: { [key]: ['urn:test:first', 'urn:test:second'] } }));
    cli('eval', `ctx.selection.set({ view: undefined, ids: [${JSON.stringify(shape.id)}] }); return true`);
    cli('eval', `await ctx.shell.revealWidget('property-view'); return true`);
    const field = panel.locator('.catenary-row').filter({ has: page.locator('code', { hasText: new RegExp(`^sh:${key}$`) }) }).locator('textarea');
    await field.waitFor();
    // ui-manifest §8.11: Properties shows its last data until the new answer arrives. The shapes answer of the revision before
    // setNodeShape already lists the shape, without targets: the textarea renders empty for one read, then again with the value.
    const expected = '<urn:test:first>\n<urn:test:second>';
    await waitUntil(`the ${key} textarea shows both targets`, () => field.inputValue(), v => v === expected);
    await field.fill('<urn:test:second>\n<urn:test:third>');
    await field.blur();
    await page.waitForFunction(l => Array.from(document.querySelectorAll('.shape-name')).some(x => x.textContent === l), label);
    await waitUntil(`the shape has the edited ${key}`, () => targets(shape.id)[key],
      v => JSON.stringify(v) === JSON.stringify(['urn:test:second', 'urn:test:third']));
    await page.locator('.shape-class', { hasText: `${words} of second or third` }).first().waitFor();
    await field.fill('');
    await field.blur();
    await waitUntil(`the shape has no ${key}`, () => ({ value: targets(shape.id)[key] }), v => v.value === undefined);
  }
}));

test('browser: Links lists instances of a selected shape outside the current view', { timeout: 45000 }, t => withFixtureApp(t, 'shape-instances', async ({ page, cli }) => {
  delayReplies(cli);
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
  // law_typeRowsShown: the instance shows its class as an outgoing rdf:type row.
  cli('eval', `ctx.selection.set({ view: undefined, ids: [${JSON.stringify(instance.id)}] }); return true`);
  await panel.locator('.catenary-tree-description', { hasText: /^rdf:type$/ }).waitFor();
}));

test('browser: Find Element (F8): Enter adds to the view, Ctrl+Enter adds and stays open, no duplicate (ui-manifest §8.6)', { timeout: 60000 }, t => withFixtureApp(t, 'find-element', async app => {
  const { page, cli } = app;
  const waitUntil = strictWait(app);
  delayReplies(cli);
  const view = cli('exec', JSON.stringify({ kind: 'createView', label: 'Find view' })).result.id;
  for (const label of ['Picked first', 'Picked second']) {
    assert.equal(cli('exec', JSON.stringify({ kind: 'createInstance', classIri: 'urn:test:Picked', label })).result.ok, true);
  }
  // CLI search filter (spec/manifest.hs §11.1): a filter selects the hits; an unknown key fails with exit 1 (law_searchUnknownKeyFails).
  assert.deepEqual(cli('rpc', 'search', JSON.stringify({ type: 'urn:test:Picked', limit: 1 })).result.map(h => h.label), ['Picked first']);
  const unknownKey = spawnSync(process.execPath, [path.join(root, 'scripts/catenary.mjs'), '--port', new URL(app.url).port, 'rpc', 'search', '{"name":"Picked"}'],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(unknownKey.status, 1, unknownKey.stdout + unknownKey.stderr);
  assert.equal(JSON.parse(unknownKey.stderr).error, 'search: unknown filter key "name"; valid keys: text, kind, type, view, limit, skolem');
  cli('eval', `await ctx.editors.open(${JSON.stringify(view)}); return true`);
  const canvas = page.locator('svg.sprotty-graph:visible');
  await canvas.waitFor();
  await canvas.click({ position: { x: 200, y: 200 } });
  const picker = page.locator('.quick-input-widget');
  const idOf = label => cli('rpc', 'search').result.find(h => h.label === label).id;
  const cards = label => { const id = idOf(label); return cli('rpc', 'view', JSON.stringify(view)).result.boxes.filter(b => b.kind === 'card' && b.element === id).length; };
  await page.keyboard.press('F8');
  await picker.waitFor();
  await page.keyboard.type('Picked first');
  await page.getByRole('option', { name: /Picked first/ }).first().waitFor();
  await page.keyboard.press('Control+Enter');
  await waitUntil('Ctrl+Enter adds the element to the view', () => cards('Picked first') === 1);
  assert.equal(await picker.isVisible(), true, 'Ctrl+Enter keeps the picker open');
  await page.locator('.quick-input-box input').fill('Picked second');
  await page.getByRole('option', { name: /Picked second/ }).first().waitFor();
  await page.keyboard.press('Enter');
  await waitUntil('Enter adds the element to the view', () => cards('Picked second') === 1);
  await picker.waitFor({ state: 'hidden' });
  // The selection holds placements: compare the elements that the backend resolved for it.
  const selected = label => { const id = idOf(label); return cli('eval', `return ctx.selection.resolved.elements.includes(${JSON.stringify(id)})`) === true; };
  await waitUntil('the added card is selected', () => selected('Picked second'));
  await page.keyboard.press('F8');
  await picker.waitFor();
  await page.keyboard.type('Picked first');
  await page.getByRole('option', { name: /Picked first/ }).first().waitFor();
  await page.keyboard.press('Enter');
  await picker.waitFor({ state: 'hidden' });
  // The accept ends with the selection (an added card is also selected after its command): then the card count is final.
  await waitUntil('Enter on an element of the view selects it there', () => selected('Picked first'));
  assert.equal(cards('Picked first'), 1, 'Enter on an element of the view adds no second card');
  // Ctrl+Enter on an element of the view: selected there, the picker stays open.
  await page.keyboard.press('F8');
  await picker.waitFor();
  await page.keyboard.type('Picked second');
  await page.getByRole('option', { name: /Picked second/ }).first().waitFor();
  await page.keyboard.press('Control+Enter');
  await waitUntil('Ctrl+Enter on an element of the view selects it there', () => selected('Picked second'));
  assert.equal(await picker.isVisible(), true, 'Ctrl+Enter on an element of the view keeps the picker open');
  assert.equal(cards('Picked second'), 1);
  // A view: a view reference; the second time it is selected, not added again.
  const other = iriId('urn:name:Product%20context');
  const references = () => cli('rpc', 'view', JSON.stringify(view)).result.boxes.filter(b => b.kind === 'reference' && b.target === other);
  await page.locator('.quick-input-box input').fill('Product context');
  await page.getByRole('option', { name: /Product context/ }).first().waitFor();
  await page.keyboard.press('Control+Enter');
  await waitUntil('Enter on a view adds a view reference', () => references().length === 1);
  // The accept ends when the picker marks the row as on this view. Then clear the selection: the next accept must select again.
  const activeRow = page.locator('.quick-input-list .monaco-list-row.focused', { has: page.locator('.label-name', { hasText: /^Product context$/ }) });
  await activeRow.locator('.label-description', { hasText: /(^| · )on this view$/ }).first().waitFor();
  cli('eval', 'ctx.selection.set({ view: undefined, ids: [] }); return true');
  await waitUntil('the selection is empty', () => !cli('ui').selection.ids?.length);
  await page.keyboard.press('Control+Enter');
  await waitUntil('Ctrl+Enter on a view of the view selects its reference', () => cli('ui').selection.ids?.includes(references()[0].id));
  assert.equal(references().length, 1, 'a view reference is added once');
  assert.equal(await picker.isVisible(), true);
}));

test('browser: CLI exec batch: ten edits with IRIs are one undo step and one commit; an invalid command changes nothing (manifest §5.2); rpc canRelate of a refused relation names the shape (§6.2); view --compact gives the card line (§12)', { timeout: 60000 }, t => withApp(t, 'exec-batch', {
  // A repository before the backend opens the workspace: the open finds it.
  fixture: workspace => {
    copyFixtures(workspace);
    for (const args of [['init', '-q'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.org'], ['add', '-A'], ['commit', '-q', '-m', 'start']]) {
      assert.equal(spawnSync('git', args, { cwd: workspace }).status, 0, args.join(' '));
    }
  }
}, async app => {
  const { cli, workspace } = app;
  const waitUntil = strictWait(app);
  const git = (...args) => spawnSync('git', args, { cwd: workspace, encoding: 'utf8' }).stdout.trim();
  assert.equal(cli('rpc', 'setSettings', JSON.stringify({ autoCommit: true })).result.ok, true);
  // A write does not commit (manifest §10.3 law_writeDoesNotCommit): save commits at once.
  assert.equal(cli('rpc', 'save').result.ok, true);
  await waitUntil('the settings are written and committed', () => ({ dirty: cli('status').model.dirty, porcelain: git('status', '--porcelain') }),
    s => !s.dirty && s.porcelain === '');
  const commits = () => Number(git('rev-list', '--count', 'HEAD'));
  const labels = () => cli('rpc', 'search').result.map(h => h.label);
  const view = 'urn:name:Product%20context', dataset = 'http://www.w3.org/ns/dcat#Dataset';
  const edits = [
    { kind: 'createInstance', classIri: dataset, label: 'Batch one' },
    { kind: 'createInstance', classIri: dataset, label: 'Batch two' },
    { kind: 'addToView', view, ids: ['$0', '$1'], at: { x: 0, y: 0 } },
    { kind: 'setBounds', view, bounds: [{ id: '$0', x: 100, y: 100 }] },
    { kind: 'setBounds', view, bounds: [{ id: '$1', x: 400, y: 100 }] },
    { kind: 'createRelation', subject: '$0', predicate: 'osg://vocab/data-product-draft#exposedThrough', object: 'urn:name:Query%20service' },
    { kind: 'rename', id: '$1', label: 'Batch two renamed' },
    { kind: 'createNote', view, text: 'Batch note', at: { x: 0, y: 400 } },
    { kind: 'createInstance', classIri: dataset, label: 'Batch three' },
    { kind: 'addToView', view, ids: ['$8'], at: { x: 700, y: 100 } }
  ];
  const exec = input => spawnSync(process.execPath, [path.join(root, 'scripts/catenary.mjs'), '--port', new URL(app.url).port, 'exec', '-'],
    { input, encoding: 'utf8', timeout: 15000 });
  // law_refusalNamesShapes: rpc canRelate of a refused relation names the node shape of the subject, and exits 1.
  const canRelate = spawnSync(process.execPath, [path.join(root, 'scripts/catenary.mjs'), '--port', new URL(app.url).port, 'rpc', 'canRelate',
    JSON.stringify('urn:name:Query%20service'), JSON.stringify('osg://vocab/data-product-draft#exposedThrough'), JSON.stringify('urn:name:Metrics%20API')],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(canRelate.status, 1, canRelate.stdout + canRelate.stderr);
  const can = JSON.parse(canRelate.stdout).result;
  assert.equal(can.ok, false);
  assert.deepEqual(can.shapes.map(s => s.label), ['Data Service']);
  assert.match(can.error, / Shapes of the subject: "Data Service"\. /);
  // law_batchRejectionRollsBack: an unknown IRI in command 7. Exit 1, the index, and no change.
  const before = { labels: labels(), commits: commits(), revision: cli('status').model.revision };
  const invalid = [...edits];
  invalid.splice(7, 0, { kind: 'rename', id: 'urn:name:Nothing%20here', label: 'X' });
  const refused = exec(invalid.map(c => JSON.stringify(c)).join('\n'));
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).result.index, 7);
  assert.deepEqual(labels(), before.labels);
  assert.equal(cli('status').model.revision, before.revision);
  // law_batchOneStep: ten edits from NDJSON are one commit and one undo step.
  const done = exec(edits.map(c => JSON.stringify(c)).join('\n'));
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(JSON.parse(done.stdout).result.results[0].iri, 'urn:name:Batch%20one');
  assert.equal(cli('rpc', 'save').result.ok, true);
  await waitUntil('the batch is written and committed', () => ({ dirty: cli('status').model.dirty, porcelain: git('status', '--porcelain'), commits: commits() }),
    s => !s.dirty && s.porcelain === '' && s.commits > before.commits);
  assert.equal(commits(), before.commits + 1);
  assert.match(git('log', '-1', '--format=%s'), /^Catenary: createInstance ×3, addToView ×2, setBounds ×2, createNote, createRelation, … \(Product context\)$/);
  for (const label of ['Batch one', 'Batch two renamed', 'Batch three']) assert.ok(labels().includes(label), label);
  cli('undo');
  assert.deepEqual(labels(), before.labels);
  // law_compactLinesCoverBoxes: view --compact after createView and addToView prints the view line and the card line, exit 0.
  const compactView = cli('exec', JSON.stringify({ kind: 'createView', label: 'Compact view' })).result.id;
  assert.equal(cli('exec', JSON.stringify({ kind: 'addToView', view: compactView, ids: ['urn:name:Query%20service'], at: { x: 40, y: 60 } })).result.ok, true);
  const compact = spawnSync(process.execPath, [path.join(root, 'scripts/catenary.mjs'), '--port', new URL(app.url).port, 'view', compactView, '--compact'],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(compact.status, 0, compact.stdout + compact.stderr);
  const lines = compact.stdout.trimEnd().split('\n');
  assert.match(lines[0], /^view "Compact view" /);
  assert.ok(lines.some(l => /^card "Query service" dcat:DataService urn:name:Query%20service -?\d+ -?\d+ \d+ \d+$/.test(l)), compact.stdout);
  const unknown = spawnSync(process.execPath, [path.join(root, 'scripts/catenary.mjs'), '--port', new URL(app.url).port, 'view', 'urn:name:No%20view', '--compact'],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(unknown.status, 1, unknown.stdout + unknown.stderr);
}));

test('browser: view URL overrides restored tabs and rejects unknown views', { timeout: 60000 }, t => withFixtureApp(t, 'view-url', async app => {
  const { page, cli } = app;
  const waitUntil = strictWait(app);
  delayReplies(cli);
  const created = cli('exec', JSON.stringify({ kind: 'createView', label: 'Linked view' }));
  assert.equal(created.result.ok, true);
  const view = created.result.id;
  const url = new URL(page.url());
  url.searchParams.set('view', view);
  const windowsBefore = connectedWindows(cli);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#shell-tab-explorer-view-container'));
  await waitForNewWindow(waitUntil, cli, windowsBefore);
  // The state of the window for a failure: current view, active and current pane, page URL, pending CLI command.
  // A CLI error (for example ECONNRESET) stops the wait at once with this state and the URL; it is not retried.
  const windowState = () => {
    let ui;
    try { ui = cli('ui'); } catch (e) { throw new Error(`${e.message}; URL ${page.url()}`, { cause: e }); }
    return { currentView: ui.currentView, activePane: ui.activeWidget?.id, currentPane: ui.currentWidget?.id, url: page.url(), pendingCommand: ui.pendingCommand ?? null };
  };
  await waitUntil(`the view of the URL (${view}) is the current view`, windowState, s => s.currentView === view, { timeout: 15000 });
  url.searchParams.set('view', 'missing-view');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.getByText('The requested view is not in the current workspace.', { exact: true }).first().waitFor();
  assert.equal(cli('status').model.views, 2, 'an invalid link creates no view');
}));

test('browser: CLI open-view opens a view in the running window and rejects unknown views', { timeout: 45000 }, t => withFixtureApp(t, 'open-view', async app => {
  const { cli, url, errors } = app;
  delayReplies(cli);
  // law_openViewChecksAsUrl. The CLI process itself: the exit status and the output of each case (catenaryCli throws on exit 1).
  const openView = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/catenary.mjs'), '--port', new URL(url).port, 'open-view', ...args],
    { encoding: 'utf8', timeout: 15000 });
  const created = cli('exec', JSON.stringify({ kind: 'createView', label: 'Agent view' }));
  assert.equal(created.result.ok, true);
  const view = created.result.id;
  assert.notEqual(cli('ui').currentView, view);
  const opened = openView(view, '--fit');
  assert.equal(opened.status, 0, opened.stdout + opened.stderr);
  assert.equal(JSON.parse(opened.stdout).currentView, view);
  assert.equal(cli('ui').currentView, view);
  const unknown = openView('nope');
  assert.equal(unknown.status, 1, unknown.stdout + unknown.stderr);
  const result = JSON.parse(unknown.stdout);
  assert.equal(result.error, 'The requested view is not in the current workspace.');
  assert.equal(result.currentView, view, 'an unknown id keeps the current view');
  assert.deepEqual(errors, []);
}));

test('browser: Apply Layout fits the viewport to the new layout; no zoom-out limit', { timeout: 45000 }, t => withFixtureApp(t, 'layout-fit', async app => {
  const { page, cli } = app;
  const waitUntil = strictWait(app);
  delayReplies(cli);
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
    // The client model has the new viewport. A zoom-out limit shows as a zoom other than 0.02 in the timeout message.
    return waitUntil('the viewport is at zoom 0.02, away from the cards', state, s => Math.abs(s.zoom - 0.02) < 1e-9 && s.cards > 0 && s.inside === 0);
  };
  const before = await away();
  assert.ok(Math.abs(before.zoom - 0.02) < 1e-9, `zoom 0.02 is kept (got ${before.zoom})`);
  assert.ok(before.cards > 0 && before.inside === 0, `no card in the viewport before the layout: ${JSON.stringify(before)}`);
  for (const algorithm of ['force', 'layered']) {
    assert.equal(cli('run', 'catenary.layoutView', 'null', JSON.stringify(algorithm)).status, 'done');
    const after = await waitUntil(`${algorithm}: every card is in the viewport after the layout`, state, s => s.cards > 0 && s.inside === s.cards);
    assert.equal(after.inside, after.cards, `${algorithm}: every card is in the viewport after the layout: ${JSON.stringify(after)}`);
    console.log(`layout fit: ${algorithm} → ${after.inside}/${after.cards} cards in the viewport, zoom ${after.zoom.toFixed(3)}`);
    await away();
  }
}));

test('browser: law_cliLayoutOneStep: CLI layout by view IRI leaves no overlapping cards; one undo restores the bounds', { timeout: 45000 }, t => withFixtureApp(t, 'cli-layout', async app => {
  const { cli, url, errors } = app;
  const layout = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/catenary.mjs'), '--port', new URL(url).port, 'layout', ...args],
    { encoding: 'utf8', timeout: 15000 });
  const iri = 'urn:name:Product%20context', view = iriId(iri);
  const cards = () => cli('rpc', 'view', JSON.stringify(view)).result.boxes.filter(b => b.kind === 'card').map(({ id, x, y, width, height }) => ({ id, x, y, width, height }));
  const overlaps = list => list.flatMap((a, i) => list.slice(i + 1).filter(b => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).map(b => `${a.id} ${b.id}`));
  const before = cards();
  assert.ok(before.length > 1, 'the view has cards');
  for (const mode of ['force', 'layered']) {
    const r = layout(iri, '--mode', mode);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.result.ok, true);
    assert.equal(out.changed, true);
    assert.deepEqual(overlaps(cards()), [], `${mode}: no two cards overlap`);
    assert.equal(cli('rpc', 'undo').result.ok, true);
    assert.deepEqual(cards(), before, `${mode}: one undo restores the old bounds`);
  }
  const unknown = layout('urn:name:noView');
  assert.equal(unknown.status, 1, unknown.stdout + unknown.stderr);
  assert.equal(JSON.parse(unknown.stdout).error, 'No view with the id or IRI "urn:name:noView".');
  const badMode = layout(iri, '--mode', 'grid');
  assert.equal(badMode.status, 2, badMode.stdout + badMode.stderr);
  assert.deepEqual(errors, []);
}));

test('browser: Properties keeps its content during a model change; the SHACL form is replaced when the new one is ready', { timeout: 90000 }, t => withFixtureApp(t, 'properties-stable', async app => {
  const { page, cli } = app;
  const waitUntil = strictWait(app);
  delayReplies(cli);
  // An instance with a SHACL form: its properties list a node shape or a plugin form (formSections, properties-widget.tsx).
  const hits = cli('rpc', 'search').result.filter(h => h.kind === 'instance');
  const target = hits.find(h => {
    const p = cli('rpc', 'properties', JSON.stringify(h.id)).result;
    return p?.kind === 'instance' && p.shapes.length + (p.pluginForms?.length ?? 0) > 0;
  });
  assert.ok(target, 'an instance of the fixtures has a SHACL form');
  cli('eval', `ctx.selection.set({ view: undefined, ids: [${JSON.stringify(target.id)}] }); return true`);
  cli('eval', `await ctx.shell.revealWidget('property-view'); return true`);
  await page.locator('#catenary-properties .catenary-props shacl-form').first().waitFor();
  // The gate: while it is closed, the answers of ctx.model.service.properties wait for the release. The render wrapper records
  // the request (file, revision, element) of the data that the panel rendered last.
  const installed = cli('eval', `const w = ctx.shell.getWidgetById('property-view')?.contentWidget;
    if (w?.id !== 'catenary-properties') return 'the Properties content widget is ' + w?.id;
    const g = globalThis.propertiesGate = { widget: w, model: ctx.model, service: ctx.model.service, render: w.render, open: true, held: [], rendered: undefined };
    ctx.model.service = new Proxy(g.service, { get(t, name) {
      const v = Reflect.get(t, name);
      if (name !== 'properties') return v;
      return (...args) => {
        const call = Promise.resolve(v.apply(t, args));
        if (g.open) return call;
        call.catch(() => {});
        return new Promise((resolve, reject) => g.held.push(() => call.then(resolve, reject)));
      };
    } });
    w.render = function () { const r = g.render.call(this); g.rendered = this.data?.request; return r; };
    w.update();
    return true`);
  assert.equal(installed, true, String(installed));
  const release = () => page.evaluate(() => { const g = globalThis.propertiesGate; g.open = true; for (const h of g.held.splice(0)) h(); });
  try {
    /** The panel: data and render for the current revision, open requests, held answers, forms, and whether the shown form has `label`. */
    const panelState = label => page.evaluate(label => {
      const g = globalThis.propertiesGate, w = g.widget, { file, revision } = g.model.snapshot, current = `${file}\n${revision}\n`;
      const forms = [...document.querySelectorAll('#catenary-properties .catenary-props shacl-form')];
      const shown = forms.filter(f => f.style.visibility !== 'hidden');
      const values = [];
      const walk = n => { if (n.shadowRoot) walk(n.shadowRoot); for (const c of n.children ?? []) { if (typeof c.value === 'string' && c.value) values.push(c.value); walk(c); } };
      if (shown.length === 1) walk(shown[0]);
      return { revision, data: w.data?.request?.startsWith(current) ?? false, rendered: g.rendered?.startsWith(current) ?? false,
        asking: w.dataRequest !== undefined, formRequest: w.formRequest !== undefined, held: g.held.length, forms: forms.length,
        shown: shown.length, toolbar: !!document.querySelector('#catenary-properties .catenary-props .catenary-toolbar'),
        label: label === undefined || values.includes(label) };
    }, label);
    const settled = s => s.data && s.rendered && !s.asking && !s.formRequest && !s.held && s.forms === 1 && s.shown === 1 && s.label;
    // The first form shows at once, before its initialization: wait until its fields have the values (the label of the instance).
    await waitUntil('Properties shows the filled form of the instance for the current revision', () => panelState(target.label), settled);
    // Each animation frame, from before the change until the end of the request: the smallest panel and form heights, the
    // shown forms, and whether a frame had no action toolbar.
    const record = () => page.evaluate(() => {
      const p = document.querySelector('#catenary-properties .catenary-props');
      const log = window.__rec = { minPanel: Infinity, minForm: Infinity, visibleForms: new Set(), maxForms: 0, emptyActions: false, stop: false };
      log.sample = () => {
        const forms = [...p.querySelectorAll('shacl-form')], shown = forms.find(f => f.style.visibility !== 'hidden');
        log.maxForms = Math.max(log.maxForms, forms.length);
        log.minPanel = Math.min(log.minPanel, p.scrollHeight);
        log.minForm = Math.min(log.minForm, shown ? shown.getBoundingClientRect().height : 0);
        if (shown) log.visibleForms.add(shown);
        if (!p.querySelector('.catenary-toolbar')) log.emptyActions = true;
      };
      const tick = () => { log.sample(); if (!log.stop) requestAnimationFrame(tick); };
      const before = { panel: p.scrollHeight, form: p.querySelector('shacl-form').getBoundingClientRect().height };
      requestAnimationFrame(tick);
      return before;
    });
    const recorded = (stop = false) => page.evaluate(stop => {
      const r = window.__rec;
      r.sample();
      if (stop) r.stop = true;
      return { minPanel: r.minPanel, minForm: r.minForm, visibleForms: r.visibleForms.size, maxForms: r.maxForms, emptyActions: r.emptyActions };
    }, stop);
    /**
     * Record the panel, close the gate, apply `change`, and wait until Properties asks for the new revision. While the gate holds
     * that answer, the panel keeps its last data: the same form, the toolbar, no shorter panel or form. Then release the gate
     * and wait until the panel shows the answer (with `label` in the form).
     */
    const throughHeldRequest = async (what, change, label) => {
      const before = await record();
      await page.evaluate(() => { globalThis.propertiesGate.open = false; });
      try {
        change();
        const held = await waitUntil(`${what}: Properties asks for the new revision and the gate holds the answer`, () => panelState(), s => s.held > 0);
        assert.ok(held.asking && held.forms === 1 && held.shown === 1 && held.toolbar, `${what}: while the answer is held, the panel keeps its form and toolbar: ${JSON.stringify(held)}`);
        const r = await recorded();
        assert.equal(r.minPanel, before.panel, `${what}: while the answer is held, the panel keeps its height: ${JSON.stringify(r)}`);
        assert.equal(r.visibleForms, 1, `${what}: while the answer is held, the same form stays`);
        assert.ok(r.minForm >= before.form - 1, `${what}: while the answer is held, the form keeps its height: ${JSON.stringify(r)} ${JSON.stringify(before)}`);
        assert.equal(r.emptyActions, false, `${what}: while the answer is held, the action toolbar stays`);
      } finally {
        await release();
      }
      await waitUntil(`${what}: Properties shows the answer for the new revision`, () => panelState(label), settled);
      return { before, r: await recorded(true) };
    };
    // A change of another instance: nothing in the panel changes size, the form stays.
    const other = hits.find(h => h.id !== target.id);
    let { before, r } = await throughHeldRequest('other instance',
      () => assert.equal(cli('exec', JSON.stringify({ kind: 'rename', id: other.id, label: 'Renamed other' })).result.ok, true));
    assert.equal(r.minPanel, before.panel, `other instance: the panel keeps its height: ${JSON.stringify(r)}`);
    assert.equal(r.visibleForms, 1, 'other instance: the same form stays');
    assert.equal(r.emptyActions, false, 'other instance: the action toolbar stays');
    // A change of the selected instance: the form is replaced, without a frame with an empty or short form.
    ({ before, r } = await throughHeldRequest('selected instance',
      () => assert.equal(cli('exec', JSON.stringify({ kind: 'rename', id: target.id, label: 'Renamed target' })).result.ok, true), 'Renamed target'));
    assert.equal(r.visibleForms, 2, `selected instance: a new form replaces the shown one: ${JSON.stringify(r)}`);
    assert.ok(r.minForm >= before.form - 1, `selected instance: the shown form never gets shorter: ${JSON.stringify(r)} ${JSON.stringify(before)}`);
    assert.equal(r.emptyActions, false, 'selected instance: the action toolbar stays');
    assert.equal(await page.locator('#catenary-properties .catenary-props shacl-form').count(), 1, 'one form after the swap');
    console.log(`properties: form replaced once, min form height ${Math.round(r.minForm)} of ${Math.round(before.form)} px, panel never shorter`);
  } finally {
    await release().catch(e => console.error(`properties-stable: release of the gate failed: ${e.message}`));
  }
}));

test('browser: Insert View writes the view IRI at the cursor; Export Markdown of a folder renders each view once as SVG; a selection of a file and a folder exports under their common folder', { timeout: 90000 }, t => withFixtureApp(t, 'markdown', async app => {
  const { page, cli, url, dir, workspace } = app;
  const waitUntil = strictWait(app);
  delayReplies(cli);
  // The CLI exits with 3 while a prompt waits: read its output anyway.
  const cliRaw = (...args) => {
    const r = require('node:child_process').spawnSync(process.execPath, [path.join(root, 'scripts/catenary.mjs'), '--port', new URL(url).port, ...args], { encoding: 'utf8', timeout: 60000 });
    return JSON.parse(r.stdout);
  };
  const second = cli('exec', JSON.stringify({ kind: 'createView', label: 'Second view' })).result;
  assert.equal(second.ok, true);
  const labels = cli('rpc', 'viewLabels').result;
  const iriOf = label => require('../../packages/model/lib/ids.js').idIri(Object.keys(labels).find(id => labels[id] === label));
  const context = iriOf('Product context'), secondIri = iriOf('Second view');
  const docs = path.join(workspace, 'docs');
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, 'Architecture.md'), '# Architecture\n\nThe system separates storage from presentation.\n\n');
  fs.writeFileSync(path.join(docs, 'Data model.md'), `# Data model\n\n![](${context})\n\nBack to [Architecture](Architecture.md).\n`);

  // Insert View: the picker shows labels; the embed holds the IRI, at the cursor.
  await navigator(page, 'docs');
  await navNode(page, 'Architecture.md').first().dblclick();
  const editor = page.locator('#theia-main-content-panel .monaco-editor:visible');
  await editor.waitFor();
  await editor.click();
  await page.keyboard.press('Control+End');
  let run = cliRaw('run', 'catenary.insertView');
  assert.equal(run.status, 'waiting');
  assert.deepEqual(run.prompt.items.map(i => i.label).sort(), ['Product context', 'Second view']);
  assert.equal(cliRaw('answer', '--pick', 'Product context').status, 'done');
  // A suggestion widget takes an Enter key as its accept key (CI run 38486141375 lost one newline): no suggestions in this editor.
  cli('eval', 'ctx.shell.currentWidget.editor.getControl().updateOptions({ quickSuggestions: false, suggestOnTriggerCharacters: false, wordBasedSuggestions: "off" }); return true');
  await page.keyboard.type('\n\n## Components\n\n');
  // Typing is asynchronous: insert only after the last key is in the document.
  await waitUntil('the document has the typed heading', () => cli('eval', 'ctx.shell.currentWidget.editor.document.getText()'), t => t.endsWith('## Components\n\n'));
  run = cliRaw('run', 'catenary.insertView');
  assert.equal(cliRaw('answer', '--pick', 'Second view').status, 'done');
  const text = cli('eval', 'ctx.shell.currentWidget.editor.document.getText()');
  assert.equal(text, `# Architecture\n\nThe system separates storage from presentation.\n\n![Product context](${context})\n\n## Components\n\n![Second view](${secondIri})`);
  cli('eval', 'await ctx.shell.currentWidget.editor.document.save(); return true');
  await waitUntil('Architecture.md on disk has the saved text', () => fs.readFileSync(path.join(docs, 'Architecture.md'), 'utf8'), t => t === text);

  // The menu of a folder and of a Markdown file in the navigator has Export Markdown; the menu of another file does not.
  const menuItem = label => page.locator('.lm-Menu .lm-Menu-itemLabel', { hasText: new RegExp(`^${label}$`) });
  await navNode(page, 'docs').first().click({ button: 'right' });
  await menuItem('Export Markdown…').waitFor();
  await page.keyboard.press('Escape');
  await navNode(page, 'Architecture.md').first().click({ button: 'right' });
  await menuItem('Open').first().waitFor();
  assert.equal(await menuItem('Export Markdown…').count(), 1);
  await page.keyboard.press('Escape');
  await navNode(page, 'workspace.trig').first().click({ button: 'right' });
  await menuItem('Open').first().waitFor();
  assert.equal(await menuItem('Export Markdown…').count(), 0);
  await page.keyboard.press('Escape');

  // Without arguments: the navigator selection, and the confirmation dialog with a checkbox per document. The export writes the
  // checked documents only. The destination comes from the real Theia folder dialog ("Choose…"): its path input works headless.
  await navNode(page, 'Architecture.md').first().click();
  await navNode(page, 'Data model.md').first().click({ modifiers: ['Control'] });
  run = cliRaw('run', 'catenary.exportMarkdown');
  assert.equal(run.status, 'waiting', JSON.stringify(run));
  assert.equal(run.prompt.kind, 'dialog');
  assert.equal(run.prompt.title, 'Export Markdown');
  for (const part of ['Architecture.md', 'Data model.md', 'No folder selected', '2 documents, 2 views']) assert.ok(run.prompt.text.includes(part), `${part}: ${run.prompt.text}`);
  assert.deepEqual(run.prompt.buttons, ['Cancel', 'Export']);
  const exportDialog = page.locator('.dialogOverlay', { has: page.locator('.catenary-export-dialog') });
  assert.equal(await exportDialog.locator('.dialogControl button.main').isDisabled(), true, 'no destination: Export is disabled');
  const exportRow = label => exportDialog.locator('.catenary-export-tree .catenary-export-row', { has: page.locator('.catenary-export-label', { hasText: new RegExp(`^${label.replace(/[.]/g, '\\.')}$`) }) });
  await exportRow('Data model.md').locator('input[type=checkbox]').uncheck();
  assert.ok(cliRaw('prompt').text.includes('1 document, 2 views'), 'the summary counts the checked documents');
  // Choose… opens the Theia folder dialog: go to `dir` with its path input, select the folder `name`, accept.
  const chooseDestination = async name => {
    fs.mkdirSync(path.join(dir, name));
    await exportDialog.getByRole('button', { name: 'Choose…', exact: true }).click();
    const folderDialog = page.locator('.dialogOverlay', { has: page.locator('.theia-LocationInputToggle') });
    await folderDialog.locator('.theia-LocationInputToggle').click();
    await folderDialog.locator('.theia-LocationTextInput').fill(dir);
    await folderDialog.locator('.theia-LocationTextInput').press('Enter');
    await folderDialog.locator('.theia-TreeNode', { has: page.locator('.theia-TreeNodeSegmentGrow', { hasText: new RegExp(`^${name}$`) }) }).click();
    await folderDialog.locator('.dialogControl button.main').click();
    await exportDialog.locator('.catenary-export-path', { hasText: path.join(dir, name) }).waitFor();
  };
  // The export command that `run` started ends after the dialog: the CLI bridge then has no pending command.
  const exportEnds = () => waitUntil('Export Markdown ends', () => ({ pending: cli('ui').pendingCommand ?? null }), s => s.pending === null, { timeout: 60000 });
  const outDialog = path.join(dir, 'out-dialog');
  await chooseDestination('out-dialog');
  await exportDialog.locator('.dialogControl button.main:not([disabled])').click();
  await exportEnds();
  assert.ok(fs.readFileSync(path.join(outDialog, 'Architecture.md'), 'utf8').includes('](_resources/'), 'the checked document is exported');
  assert.equal(fs.existsSync(path.join(outDialog, 'Data model.md')), false, 'an unchecked document is not exported');
  // Run Last Markdown Export repeats it without a dialog: same destination, the unchecked document stays out.
  fs.rmSync(path.join(outDialog, 'Architecture.md'));
  run = cliRaw('--timeout', '60000', 'run', 'catenary.runLastMarkdownExport');
  assert.equal(run.status, 'done', JSON.stringify(run));
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  assert.ok(fs.readFileSync(path.join(outDialog, 'Architecture.md'), 'utf8').includes('](_resources/'), 'the last export writes again');
  assert.equal(fs.existsSync(path.join(outDialog, 'Data model.md')), false, 'the last export keeps the unchecked document out');

  // A view behind another tab gets the changes of that time when it shows (law_hiddenCanvasRefreshesOnce): the export shows it first (roborev 186).
  const placed = cli('exec', JSON.stringify({ kind: 'createInstance', classIri: 'urn:test:Item', label: 'Before hide', view: second.id, at: { x: 100, y: 100 } })).result;
  assert.equal(placed.ok, true, JSON.stringify(placed));
  // An instance with violations (a Data Product without its required values): the canvas shows its badge and red border (§9.2 law_exportShowsNoValidation).
  const unfinished = cli('exec', JSON.stringify({ kind: 'createInstance', classIri: 'https://ekgf.github.io/dprod/DataProduct', label: 'Unfinished product', view: second.id, at: { x: 500, y: 100 } })).result;
  assert.equal(unfinished.ok, true, JSON.stringify(unfinished));
  cli('eval', `await ctx.editors.open(${JSON.stringify(second.id)}, 'reveal'); return true`);
  await page.locator('svg.sprotty-graph:visible g.card', { hasText: 'Before hide' }).waitFor();
  await page.locator('svg.sprotty-graph:visible g.catenary-card.invalid', { hasText: 'Unfinished product' }).locator('g.badge').waitFor();
  assert.equal(await page.locator('svg.sprotty-graph:visible g.catenary-card.unknown', { hasText: 'Before hide' }).count(), 1, 'the canvas marks the card without a known class');
  const danger = await page.evaluate(() => {
    const e = document.body.appendChild(document.createElement('span'));
    e.style.color = 'var(--catenary-danger)';
    const color = getComputedStyle(e).color;
    e.remove();
    return color;
  });
  await navNode(page, 'Architecture.md').first().dblclick();
  await page.locator('svg.sprotty-graph:visible').waitFor({ state: 'hidden' });
  assert.equal(cli('exec', JSON.stringify({ kind: 'rename', id: placed.id, label: 'Renamed while hidden' })).result.ok, true);

  // A label change does not break an embed: the export resolves by IRI.
  assert.equal(cli('exec', JSON.stringify({ kind: 'rename', id: second.id, label: 'Renamed view' })).result.ok, true);
  const out = path.join(dir, 'out');
  const before = fs.readdirSync(docs).map(f => [f, fs.readFileSync(path.join(docs, f), 'utf8')]);
  run = cliRaw('--timeout', '60000', 'run', 'catenary.exportMarkdown', JSON.stringify(docs), JSON.stringify(out));
  assert.equal(run.status, 'done', JSON.stringify(run));
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  const resources = fs.readdirSync(path.join(out, '_resources')).filter(f => f.endsWith('.svg'));
  assert.equal(resources.length, 2, 'two views, one SVG each');
  const arch = fs.readFileSync(path.join(out, 'Architecture.md'), 'utf8');
  const links = [...arch.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(links.map(l => l[0]), ['Product context', 'Second view']);
  assert.ok(links.every(l => /^_resources\/[a-z0-9-]+\.svg$/.test(l[1])), JSON.stringify(links));
  assert.ok(fs.readFileSync(path.join(out, 'Data model.md'), 'utf8').includes(`![](${links[0][1]})`.replace('![]', '![Product context]')), 'the same view uses the same SVG');
  assert.ok(fs.readFileSync(path.join(out, 'Data model.md'), 'utf8').includes('[Architecture](Architecture.md)'));
  for (const [, link] of links) {
    const svg = fs.readFileSync(path.join(out, link), 'utf8');
    assert.match(svg, /^<svg[^>]*\swidth="\d+"[^>]*>/);
    assert.ok(svg.includes('<g'), 'the SVG has the diagram');
    assert.ok(!svg.includes('<foreignObject'), 'the exported SVG uses SVG text, not HTML that only browsers draw');
    assert.ok(!/>\+ (attribute|member|concept|target)</.test(svg), 'no text of edit controls in the SVG');
    assert.ok(!svg.includes('color(srgb'), 'the exported SVG uses portable colors');
    assert.match(svg, /<rect[^>]*\sfill="rgb\(30, 30, 30\)"/, 'the exported SVG has an explicit background');
    for (const control of ['catenary-halo', 'sprotty-resize-handle', 'catenary-resize-handle', 'shape-add-row', 'selected']) {
      assert.ok(!new RegExp(`class="[^"]*\\b${control}\\b`).test(svg), `no ${control} in the SVG`);
    }
  }
  const secondSvg = fs.readFileSync(path.join(out, links[1][1]), 'utf8');
  assert.ok(secondSvg.includes('>Renamed while hidden</text>') && !secondSvg.includes('Before hide'), 'a hidden view exports its current content');
  // No validation results in the SVG: no badge, no invalid or unknown class, no stroke in the danger color (law_exportShowsNoValidation).
  assert.ok(secondSvg.includes('>Unfinished product</text>'), 'the SVG has the instance with violations');
  for (const mark of ['badge', 'invalid', 'unknown']) assert.ok(!new RegExp(`class="[^"]*\\b${mark}\\b`).test(secondSvg), `no ${mark} in the SVG`);
  assert.ok(!secondSvg.includes(danger), `no ${danger} (danger color) in the SVG`);
  assert.ok(cli('eval', `return ctx.editors.find(${JSON.stringify(second.id)}).node.querySelectorAll('.catenary-card.invalid').length`) > 0, 'the canvas keeps its marks after the export');
  assert.ok(links.some(([, link]) => /<text[^>]*\stextLength="[\d.]+"[^>]*>[^<]+<\/text>/.test(fs.readFileSync(path.join(out, link), 'utf8'))), 'card text is measured SVG text');
  assert.deepEqual(fs.readdirSync(docs).map(f => [f, fs.readFileSync(path.join(docs, f), 'utf8')]), before, 'the source documents do not change');

  // Sizes that are constant on screen use the canvas zoom of the view, the geometry zoom 1 (§9.2 law_exportSizesUseCanvasZoom, kata rerz).
  const contextId = Object.keys(labels).find(id => labels[id] === 'Product context');
  const canvasLabel = cli('eval', `const w = await ctx.editors.open(${JSON.stringify(contextId)}, 'reveal'); await w.actionDispatcher.onceModelInitialized();
    const root = w.editorContext.modelRoot;
    await w.actionDispatcher.dispatch({ kind: 'viewport', elementId: root.id, newViewport: { scroll: root.scroll, zoom: 0.4 }, animate: false });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const l = w.node.querySelector('svg.sprotty-graph .edge-label');
    return { zoom: w.editorContext.modelRoot.zoom, size: l ? parseFloat(getComputedStyle(l).fontSize) : null }`);
  assert.deepEqual(canvasLabel, { zoom: 0.4, size: 27.5 }, 'the canvas label at zoom 0.4 is max(18, 11 / 0.4)');
  run = cliRaw('--timeout', '60000', 'run', 'catenary.exportMarkdown', JSON.stringify(docs), JSON.stringify(out));
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  const labelSizes = [...fs.readFileSync(path.join(out, links[0][1]), 'utf8').matchAll(/<text[^>]*class="edge-label[^"]*"[^>]*style="font-size: ([\d.]+)px; stroke-width: ([\d.]+)px/g)].map(m => [Number(m[1]), Number(m[2])]);
  assert.ok(labelSizes.length > 0, 'the view has edge labels');
  assert.deepEqual([...new Set(labelSizes.map(String))], ['27.5,11'], 'the SVG label and its halo have the canvas sizes at zoom 0.4');

  // A view IRI that names no view: an error with the file, the line and the IRI; nothing is written.
  fs.writeFileSync(path.join(docs, 'Broken.md'), 'Text\n\n![](urn:name:No%20such%20view)\n');
  run = cliRaw('--timeout', '60000', 'run', 'catenary.exportMarkdown', JSON.stringify(docs), JSON.stringify(out));
  assert.equal(run.result.ok, false);
  assert.deepEqual(run.result.unresolved, [{ file: 'Broken.md', line: 3, iri: 'urn:name:No%20such%20view' }]);
  assert.ok(run.messages.some(m => m.text?.includes('Broken.md:3: urn:name:No%20such%20view')), JSON.stringify(run.messages));
  assert.equal(fs.existsSync(path.join(out, 'Broken.md')), false);

  // The dialog opens also when a selected document has an unresolved embed: it lists the embed, and the user unchecks the document.
  // It starts with the remembered destination of the root: `out`, of the last export of docs/.
  await navigator(page, 'docs');
  await navNode(page, 'Broken.md').first().waitFor();
  await navNode(page, 'Broken.md').first().click();
  await navNode(page, 'Architecture.md').first().click({ modifiers: ['Control'] });
  run = cliRaw('run', 'catenary.exportMarkdown');
  assert.equal(run.status, 'waiting', JSON.stringify(run));
  assert.equal(run.prompt.title, 'Export Markdown');
  for (const part of ['Broken.md:3: urn:name:No%20such%20view', '2 documents, 2 views', out]) assert.ok(run.prompt.text.includes(part), `${part}: ${run.prompt.text}`);
  await exportRow('Broken.md').locator('input[type=checkbox]').uncheck();
  const outBroken = path.join(dir, 'out-broken');
  await chooseDestination('out-broken');
  await exportDialog.locator('.dialogControl button.main:not([disabled])').click();
  await exportEnds();
  assert.ok(fs.existsSync(path.join(outBroken, 'Architecture.md')), 'the checked document is exported');
  assert.equal(fs.existsSync(path.join(outBroken, 'Broken.md')), false, 'the unchecked document with the unresolved embed is not exported');

  // A selection of a file and a folder: the root is their common folder (the workspace folder); the paths keep the folder names.
  const notes = path.join(workspace, 'notes');
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, 'Meeting.md'), '# Meeting\n');
  const out2 = path.join(dir, 'out2');
  run = cliRaw('--timeout', '60000', 'run', 'catenary.exportMarkdown', JSON.stringify([path.join(docs, 'Architecture.md'), notes]), JSON.stringify(out2));
  assert.equal(run.status, 'done', JSON.stringify(run));
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  assert.equal(fs.readFileSync(path.join(out2, 'notes', 'Meeting.md'), 'utf8'), '# Meeting\n');
  assert.ok(fs.readFileSync(path.join(out2, 'docs', 'Architecture.md'), 'utf8').includes('](../_resources/'), 'the SVG links are relative to the root');
  assert.equal(fs.existsSync(path.join(out2, 'docs', 'Data model.md')), false, 'a document outside the selection is not exported');
}));
