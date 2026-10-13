// Repro: expand a card from another (halo expandOut), drag the new card at once, watch whether it jumps back.
const { fork, execFileSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
// CATENARY_ROOT: the checkout whose build runs (default: the repository of this script).
const root = path.resolve(process.env.CATENARY_ROOT || path.join(__dirname, '../..'));
const { chromium } = require(path.join(root, 'node_modules/playwright-core'));
const { iriId } = require(path.join(root, 'packages/model/lib/ids.js'));
const scratch = process.env.SCRATCH || require('node:os').tmpdir();
const DRAG_DELAY = Number(process.env.DRAG_DELAY ?? 0);
// GIT=1: the copy is a git repository with one commit. AUTO_COMMIT=1: ws:autoCommit on (each write commits). VALIDATION=1: the
// books get a publication year of the wrong datatype, the shop shape does not validate them, and the validation mode is "views": the
// expand puts a book with a violation on the view, and the validation run that follows changes the violations of the view.
// FAST=1: no CLI call, screenshot or DOM probe between the new card and the drop (the drop comes about 100 ms after the card).
const FAST = process.env.FAST === '1';
const GIT = process.env.GIT === '1', AUTO_COMMIT = process.env.AUTO_COMMIT === '1', VALIDATION = process.env.VALIDATION === '1';
const load = () => os.loadavg().map(n => n.toFixed(2)).join(' ');
console.log('root', root, 'GIT', GIT, 'AUTO_COMMIT', AUTO_COMMIT, 'VALIDATION', VALIDATION, 'DRAG_DELAY', DRAG_DELAY, 'FAST', FAST, 'load', load());

const dir = fs.mkdtempSync(path.join(scratch, process.env.PREFIX || 'repro-'));
const workspace = path.join(dir, 'workspace'), config = path.join(dir, 'config');
fs.cpSync(path.join(root, 'examples/bookshop'), workspace, { recursive: true });
fs.mkdirSync(config);
if (process.env.VALIDATION_DATA === '1') {
  // A publication year as a string: each book violates sh:datatype xsd:integer.
  const data = path.join(workspace, 'data.ttl');
  fs.writeFileSync(data, fs.readFileSync(data, 'utf8').replace(/(publicationYear> )(\d+)/g, '$1"$2"'));
  // No sh:node from the shop to the books: a book is validated only when it is on the view, so the expand adds its violation.
  const shapes = path.join(workspace, 'workspace.shapes.ttl');
  fs.writeFileSync(shapes, fs.readFileSync(shapes, 'utf8').replace(/\n\s*sh:node <urn:name:Book%20shape> ;/, ''));
}
if (GIT) {
  const git = (...a) => execFileSync('git', a, { cwd: workspace, stdio: 'pipe' });
  // A local identity: the auto-commits of the backend (plain `git commit`) also work without a global one.
  git('init', '-q'); git('config', 'user.name', 'repro'); git('config', 'user.email', 'repro@example.org');
  git('add', '-A'); git('commit', '-q', '-m', 'copy');
}
const logs = [];
const proc = fork(path.join(root, 'app/lib/backend/main.js'), [workspace, '--hostname', '127.0.0.1', '--port', '0'], {
  cwd: path.join(root, 'app'), env: { ...process.env, THEIA_CONFIG_DIR: config }, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
});
proc.stdout.on('data', d => logs.push(String(d))); proc.stderr.on('data', d => logs.push(String(d)));
const ready = new Promise((res, rej) => { proc.once('message', a => res(`http://127.0.0.1:${a.port}`)); proc.once('exit', c => rej(new Error('exit ' + c))); });
const t0 = Date.now(); const ts = () => String(Date.now() - t0).padStart(5);
(async () => {
  let browser;
  try {
    const url = await ready;
    const cli = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/catenary.mjs'), '--port', new URL(url).port, ...args], { encoding: 'utf8', timeout: 15000 }));
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(15000);
    page.on('console', m => { logs.push('[page ' + m.type() + '] ' + m.text()); });
    const frames = [], models = [];
    const kinds = text => { const out = []; const re = /"kind":"([A-Za-z]+)"/g; let m; while ((m = re.exec(text))) out.push(m[1]); return out; };
    page.on('websocket', ws => {
      const log = dir => f => { const t = typeof f.payload === 'string' ? f.payload : f.payload.toString('latin1'); const k = kinds(t); if (/"(updateModel|setModel)"/.test(t)) { models.push([Date.now(), t]); } if (k.length) frames.push(`${Date.now()} ${dir} ${[...new Set(k)].join(',')}${/setBounds|newBounds/.test(t) ? ' [bounds:' + (t.match(/"newPosition":\{[^}]*\}/g) || []).join(' ') + ']' : ''}${/"revision":\d+/.test(t) ? ' rev=' + t.match(/"revision":(\d+)/)[1] : ''}`); };
      ws.on('framesent', log('>>')); ws.on('framereceived', log('<<'));
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('#theia-main-content-panel').waitFor();
    cli('rpc', 'open', JSON.stringify(path.join(workspace, 'workspace.trig')));
    const settings = { ...(AUTO_COMMIT ? { autoCommit: true } : {}), ...(VALIDATION ? { validation: 'views' } : {}) };
    if (Object.keys(settings).length) console.log('setSettings', JSON.stringify(cli('rpc', 'setSettings', JSON.stringify(settings))));
    const view = cli('exec', JSON.stringify({ kind: 'createView', label: 'Repro' })).result.id;
    const r = cli('exec', JSON.stringify({ kind: 'addToView', view, ids: [iriId('urn:name:Wonderland%20Books%20(fictional)')], at: { x: 400, y: 400 } }));
    console.log('addToView', JSON.stringify(r.result));
    cli('eval', `await ctx.editors.open(${JSON.stringify(view)}); return true`);
    const canvas = page.locator('svg.sprotty-graph:visible');
    await canvas.waitFor();
    const cardSel = 'svg.sprotty-graph g.card';
    const cards = page.locator(cardSel + '[id*="_3aRepro_"]');
    await cards.first().waitFor();
    await page.waitForTimeout(500);
    const prefix = (await cards.first().getAttribute('id')).replace(/_n-.*$/, '_');
    const inView = () => page.locator(cardSel).filter({ has: page.locator(`[id^="${prefix}"]`) });
    const idsNow = () => page.evaluate(({ sel, prefix }) => [...document.querySelectorAll(sel)].map(g => g.id).filter((id, i, a) => id.startsWith(prefix) && a.indexOf(id) === i), { sel: cardSel, prefix });
    console.log(ts(), 'cards before', await idsNow());
    // The violations by instance: with VALIDATION=1 the expand must add one (a "validation" change with elements, then a refresh).
    const violations = () => { try { const r = cli('model', 'violations'), m = r.result ?? r, list = Array.isArray(m) ? m : m.value ?? m.violations; return Array.isArray(list) ? JSON.stringify(list.map(v => `${v.instance ?? '-'} ${v.severity}`)) : JSON.stringify(r).slice(0, 300); } catch (e) { return 'n/a ' + String(e).slice(0, 80); } };
    if (VALIDATION) { await page.waitForTimeout(1000); console.log('violations before the expand', violations()); }
    cli('rpc', 'setTracing', 'true');
    // No GLSP select frame is sent: the selection is read from the selection model of the window.
    cli('eval', `window.__sel = []; ctx.selection.onDidChange(s => window.__sel.push([Date.now(), JSON.stringify(s.ids)])); return true`);
    const tExpand = Date.now();
    await cards.first().locator('.card-name').click();
    const out = page.locator('.catenary-halo .halo-action[data-action="expandOut"]:visible');
    await out.waitFor();
    // A first open can show the single card at a large scale: the halo arrow is then under the Properties panel. Zoom out with the
    // wheel until the arrow is inside the canvas.
    const area = await canvas.boundingBox(), arrow = await out.boundingBox();
    if (arrow.x + arrow.width > area.x + area.width - 20) {
      const dx = arrow.x + arrow.width - (area.x + area.width) + 300;
      const vpOf = () => page.evaluate(() => document.querySelector('svg.sprotty-graph:not([style*="none"]) > g')?.getAttribute('transform'));
      console.log(ts(), 'halo arrow outside the canvas by', Math.round(dx - 300), 'px; viewport', await vpOf());
      await page.mouse.move(area.x + 30, area.y + 30);
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(300);
      console.log(ts(), 'after wheel, viewport', await vpOf());
      await cards.first().locator('.card-name').click();
      await out.waitFor();
    }
    await out.click();
    const rows = page.locator('.catenary-popup-picker .item');
    await rows.first().waitFor();
    const labels = await rows.allTextContents();
    console.log(ts(), 'pick rows', labels.length, labels.slice(0, 3));
    // Pick a single neighbor (not "Show all").
    await rows.nth(labels.length > 1 ? 1 : 0).click();
    const before = new Set(await idsNow());
    await page.waitForFunction(({ sel, prefix, n }) => [...document.querySelectorAll(sel)].map(g => g.id).filter((id, i, a) => id.startsWith(prefix) && a.indexOf(id) === i).length > n, { sel: cardSel, prefix, n: before.size });
    const ids = await idsNow();
    console.log(ts(), 'cards after', ids);
    const fresh = ids.find(id => !before.has(id));
    const el = page.locator(`svg.sprotty-graph:visible g.card[id="${fresh}"]`).first();
    const box = await el.boundingBox();
    console.log(ts(), 'new card screen box', box);
    // Each animation frame: record the screen position and the transform of the new card when one changes.
    await page.evaluate(id => {
      window.__pos = []; let last;
      const tick = () => {
        const g = document.querySelector(`svg.sprotty-graph g.card[id="${id}"]`);
        const r = g && g.getBoundingClientRect();
        const v = g ? `${Math.round(r.x)},${Math.round(r.y)} ${g.getAttribute('transform')}` : 'gone';
        if (v !== last) { window.__pos.push([Date.now(), v]); last = v; }
        requestAnimationFrame(tick);
      };
      tick();
    }, fresh);
    const storeBefore = FAST ? [] : cli('rpc', 'view', JSON.stringify(view)).result.boxes;
    if (DRAG_DELAY) await page.waitForTimeout(DRAG_DELAY);
    const from = { x: box.x + Number(process.env.DX ?? 45), y: box.y + Number(process.env.DY ?? 32) };
    console.log(ts(), 'drag from name center', from);
    const to = { x: from.x - 400, y: from.y + 200 };
    if (!FAST) console.log('under pointer', await page.evaluate(({ x, y }) => { let e = document.elementFromPoint(x, y); const out = []; while (e && out.length < 6) { out.push(`${e.tagName}#${e.id}.${(e.getAttribute('class') || '').trim()}`); e = e.parentElement; } return out; }, from));
    if (!FAST) await page.screenshot({ path: path.join(dir, 'before.png') });
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: FAST ? 4 : 8 });
    if (!FAST) await page.screenshot({ path: path.join(dir, 'during.png') });
    await page.mouse.up();
    const tDrop = Date.now();
    console.log(ts(), 'dropped');
    const seen = [];
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(100);
      const b = await el.boundingBox();
      const tr = await page.evaluate(id => { const g = document.querySelector(`svg.sprotty-graph g.card[id="${id}"]`); const vp = g && g.closest('svg').querySelector(':scope > g'); return `card=${g && g.getAttribute('transform')} vp=${vp && vp.getAttribute('transform')}`; }, fresh);
      const pos = b ? `${Math.round(b.x)},${Math.round(b.y)} ${tr}` : 'gone';
      if (!seen.length || seen[seen.length - 1].pos !== pos) { seen.push({ t: ts(), pos }); console.log(ts(), 'screen', pos); }
    }
    const trace = cli('rpc', 'trace', '0');
    fs.writeFileSync(path.join(dir, 'trace.json'), JSON.stringify(trace, null, 1));
    const rel = t => String(t - tDrop).padStart(6);
    console.log('expand click at', rel(tExpand), 'ms relative to the drop');
    const spans = (trace.result?.spans ?? trace.spans ?? []).filter(s => s.kind === 'command' || s.kind === 'file' || s.kind === 'change'
      || (s.kind === 'validation' && s.name === 'run') || /^view /.test(s.name) || s.name === 'read changed files').sort((a, b) => a.start - b.start);
    console.log('spans (ms relative to the drop, duration)');
    for (const s of spans) console.log(rel(s.start), `+${Math.round(s.ms)}`.padStart(6), s.kind, s.name);
    console.log('selection changes (ms relative to the drop)');
    for (const [t, ids] of await page.evaluate(() => window.__sel)) console.log(rel(t), ids);
    console.log('card position per frame (ms relative to the drop)');
    for (const [t, v] of await page.evaluate(() => window.__pos)) console.log(rel(t), v);
    const pick = boxes => JSON.stringify(boxes.filter(b => fresh.endsWith(b.id) || fresh.includes(b.id)).map(b => ({ id: b.id, x: b.x, y: b.y })));
    console.log('store box of the new card before the drag', pick(storeBefore));
    console.log('notifications', await page.locator('.theia-notification-message').allTextContents());
    const v = cli('rpc', 'view', JSON.stringify(view)).result;
    console.log('store boxes', JSON.stringify(v.boxes.map(b => ({ id: b.id, x: b.x, y: b.y, w: b.width, h: b.height }))));
    console.log('store box of the new card after the run', pick(v.boxes));
    if (VALIDATION) console.log('violations after the run', violations());
    if (GIT) console.log('git log', execFileSync('git', ['log', '--oneline'], { cwd: workspace, encoding: 'utf8' }).trim().split('\n').join(' | '));
    console.log('load', load());
    await page.screenshot({ path: path.join(dir, 'end.png') });
    console.log('GLSP frames (ms relative to the drop)');
    console.log(frames.filter(f => !/RequestContextActions|SetContextActions|catenaryPointer|RequestPopup|SetPopup|request_/.test(f)).slice(-40).map(f => rel(Number(f.slice(0, f.indexOf(' ')))) + f.slice(f.indexOf(' '))).join('\n'));
    // The position of the new card in each model that the server sent (its GLSP id is the DOM id without the canvas prefix).
    const modelId = fresh.slice(prefix.length);
    const find = (o, id) => { if (!o || typeof o !== 'object') return; if (o.id === id && o.position) return o.position; for (const v of Object.values(o)) { const r = find(v, id); if (r) return r; } };
    console.log('new card position in server models (ms relative to the drop)', modelId);
    for (const [t, text] of models) { let pos; try { pos = find(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)), modelId); } catch { pos = 'unparsed'; } console.log(rel(t), JSON.stringify(pos ?? null)); }
    console.log('positions seen', seen.length, '->', seen.map(s => s.pos).join(' | '));
  } catch (e) { console.error('FAIL', e); try { await (await browser?.contexts()[0]?.pages()[0])?.screenshot({ path: path.join(dir, 'fail.png') }); } catch {} console.error(logs.slice(-20).join('')); }
  finally { await browser?.close(); try { process.kill(-proc.pid, 'SIGKILL'); } catch {} fs.writeFileSync(path.join(dir, 'backend.log'), logs.join('')); console.log('artifacts', dir); }
})();
