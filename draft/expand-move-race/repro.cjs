// Repro: expand a card from another (halo expandOut), drag the new card at once, watch whether it jumps back.
const { fork, execFileSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = '/home/cvasquez/os/rdf/catenary';
const { chromium } = require(path.join(root, 'node_modules/playwright-core'));
const { iriId } = require(path.join(root, 'packages/model/lib/ids.js'));
const scratch = process.env.SCRATCH || require('node:os').tmpdir();
const DRAG_DELAY = Number(process.env.DRAG_DELAY ?? 0);

const dir = fs.mkdtempSync(path.join(scratch, 'repro-'));
const workspace = path.join(dir, 'workspace'), config = path.join(dir, 'config');
fs.cpSync(path.join(root, 'examples/bookshop'), workspace, { recursive: true });
fs.mkdirSync(config);
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
    const frames = [];
    const kinds = text => { const out = []; const re = /"kind":"([A-Za-z]+)"/g; let m; while ((m = re.exec(text))) out.push(m[1]); return out; };
    page.on('websocket', ws => {
      const log = dir => f => { const t = typeof f.payload === 'string' ? f.payload : f.payload.toString('latin1'); const k = kinds(t); if (k.length) frames.push(`${ts()} ${dir} ${[...new Set(k)].join(',')}${/setBounds|newBounds/.test(t) ? ' [bounds:' + (t.match(/"newPosition":\{[^}]*\}/g) || []).join(' ') + ']' : ''}${/"revision":\d+/.test(t) ? ' rev=' + t.match(/"revision":(\d+)/)[1] : ''}`); };
      ws.on('framesent', log('>>')); ws.on('framereceived', log('<<'));
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('#theia-main-content-panel').waitFor();
    cli('rpc', 'open', JSON.stringify(path.join(workspace, 'workspace.trig')));
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
    cli('rpc', 'setTracing', 'true');
    await cards.first().locator('.card-name').click();
    const out = page.locator('.catenary-halo .halo-action[data-action="expandOut"]:visible');
    await out.waitFor();
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
    if (DRAG_DELAY) await page.waitForTimeout(DRAG_DELAY);
    const from = { x: box.x + Number(process.env.DX ?? 45), y: box.y + Number(process.env.DY ?? 32) };
    console.log(ts(), 'drag from name center', from);
    const to = { x: from.x - 400, y: from.y + 200 };
    console.log('under pointer', await page.evaluate(({ x, y }) => { let e = document.elementFromPoint(x, y); const out = []; while (e && out.length < 6) { out.push(`${e.tagName}#${e.id}.${(e.getAttribute('class') || '').trim()}`); e = e.parentElement; } return out; }, from));
    await page.screenshot({ path: path.join(dir, 'before.png') });
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.screenshot({ path: path.join(dir, 'during.png') });
    await page.mouse.up();
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
    console.log('notifications', await page.locator('.theia-notification-message').allTextContents());
    const v = cli('rpc', 'view', JSON.stringify(view)).result;
    console.log('store boxes', JSON.stringify(v.boxes.map(b => ({ id: b.id, x: b.x, y: b.y, w: b.width, h: b.height }))));
    await page.screenshot({ path: path.join(dir, 'end.png') });
    console.log(frames.filter(f => !/RequestContextActions|SetContextActions|catenaryPointer|RequestPopup|SetPopup|request_/.test(f)).slice(-40).join('\n'));
    console.log('positions seen', seen.length, '->', seen.map(s => s.pos).join(' | '));
  } catch (e) { console.error('FAIL', e); console.error(logs.slice(-20).join('')); }
  finally { await browser?.close(); try { process.kill(-proc.pid, 'SIGKILL'); } catch {} fs.writeFileSync(path.join(dir, 'backend.log'), logs.join('')); console.log('artifacts', dir); }
})();
