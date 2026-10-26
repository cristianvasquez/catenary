// Shared parts of the browser tests (scripts/e2e.cjs): registration and selection, fixtures, the agent CLI, backend and browser
// lifetime, a predicate wait and the failure diagnostics. The scenario files register with `test`; e2e.cjs calls `run`.
// Each test has its own backend (port 0, address through IPC), configuration folder, workspace copy and browser.
const { describe, test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { setTimeout: sleep } = require('node:timers/promises');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const executablePath = process.env.CHROMIUM || '/usr/bin/chromium';

const scenarios = [];
/** Register a browser scenario. `run` decides which scenarios go to node:test. */
const test = (name, options, fn) => { scenarios.push({ name, options, fn }); };

/**
 * E2E_LIST=1 prints the scenario names, one per line, and starts nothing. E2E_TEST=<name> runs only the scenario with that exact
 * name. An unknown name sets exit code 1 and runs nothing. E2E_CONCURRENCY sets the number of parallel scenarios (default 3).
 */
function run() {
  const names = scenarios.map(s => s.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) throw new Error(`Two browser scenarios have the name ${JSON.stringify(duplicate)}`);
  if (process.env.E2E_LIST === '1') {
    for (const name of names) console.log(name);
    return;
  }
  const wanted = process.env.E2E_TEST;
  const selected = wanted ? scenarios.filter(s => s.name === wanted) : scenarios;
  if (!selected.length) {
    console.error(`E2E_TEST: no browser scenario has the exact name ${JSON.stringify(wanted)}. Run E2E_LIST=1 pnpm e2e to list the ${names.length} names.`);
    process.exitCode = 1;
    return;
  }
  describe('browser', { concurrency: Number(process.env.E2E_CONCURRENCY) || 3 }, () => {
    for (const s of selected) nodeTest(s.name, s.options, s.fn);
  });
}

const show = value => {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

/**
 * Wait until `until(state)` is true for a state from `observe()`, with a monotonic deadline (performance.now). Returns that state.
 * An error from `observe` is the observed state, and the wait continues. `abort()` returns a reason to stop at once, for example
 * an exited backend. A timeout error names the condition and gives the last observed state.
 */
async function waitUntil(description, observe, until = Boolean, { timeout = 10000, interval = 100, abort } = {}) {
  const start = performance.now(), deadline = start + timeout;
  let last = '(not observed)';
  for (;;) {
    try {
      const state = await observe();
      if (until(state)) return state;
      last = state;
    } catch (e) {
      last = `error: ${e.message}`;
    }
    const reason = abort?.();
    if (reason) throw new Error(`Stopped waiting until ${description}: ${reason}. Last observed state: ${show(last)}`);
    const left = deadline - performance.now();
    if (left <= 0) throw new Error(`Timed out after ${Math.round(performance.now() - start)} ms waiting until ${description}. Last observed state: ${show(last)}`);
    await sleep(Math.min(interval, left));
  }
}

/**
 * Page init script: records each long task of the page (start and duration in ms of performance.now()). The observer is passive: it
 * requests no frames, so it adds no load to the runner.
 */
const LONG_TASKS = () => {
  const tasks = globalThis.__e2eLongTasks = [];
  try {
    new PerformanceObserver(list => { for (const e of list.getEntries()) tasks.push([Math.round(e.startTime), Math.round(e.duration)]); })
      .observe({ type: 'longtask', buffered: true });
  } catch {}
};

/**
 * Launch Chromium for the test `t`. A node:test timeout does not stop the test function: when the launch ends after the test has
 * ended, the `after` hooks have already run, so the browser is closed here. Else it keeps `node scripts/e2e.cjs` alive.
 * 30 s: the first browser start of a CI runner took 13 to 45 s.
 */
async function launchBrowser(t, options = {}) {
  const browser = await chromium.launch({ executablePath, timeout: 30000, ...options });
  if (t.signal.aborted) {
    await browser.close().catch(() => {});
    throw new Error('the test ended before the browser launch completed');
  }
  return browser;
}

/** The agent CLI (scripts/catenary.mjs) on the backend at `url`: `cli(...args)` returns its JSON output. `record(entry)` gets each call. */
const catenaryCli = (url, record) => (...args) => {
  const entry = { at: new Date().toISOString(), args, result: 'running' };
  record?.(entry);
  try {
    const out = JSON.parse(execFileSync(process.execPath,
      [path.join(root, 'scripts/catenary.mjs'), '--port', new URL(url).port, ...args], { encoding: 'utf8', timeout: 15000 }));
    entry.result = 'ok';
    return out;
  } catch (e) {
    entry.result = `failed: ${e.message}${e.stderr ? `\n${e.stderr}` : ''}`;
    throw e;
  }
};

/** A row of the Theia file navigator (#files) with the name `name`. */
const navNode = (page, name) => page.locator('#files .theia-TreeNode')
  .filter({ has: page.locator('.theia-TreeNodeSegmentGrow', { hasText: new RegExp(`^${name.replace(/[.]/g, '\\.')}$`) }) });
/** Show the file navigator and expand the folders of `folders`. */
async function navigator(page, ...folders) {
  // A click on the current tab collapses the side panel (no tab is current), a second click shows it again.
  const tab = page.locator('#shell-tab-explorer-view-container');
  const current = () => tab.evaluate(t => t.classList.contains('lm-mod-current'));
  if (!await page.locator('#files').isVisible()) {
    if (await current()) { await tab.click(); await waitUntil('the side panel is collapsed', current, c => !c); }
    await tab.click();
  }
  await page.locator('#files').waitFor();
  for (const f of folders) {
    const node = navNode(page, f).first();
    await node.waitFor();
    if (!await node.locator('.theia-ExpansionToggle:not(.theia-mod-collapsed)').count()) await node.locator('.theia-ExpansionToggle').click();
  }
}

// Inspect saved RDF as a dataset, not Turtle text (prefixes and serialization order are not stable).
const rdfRows = (file, query) => require('../rdf-query.cjs').rows(file, query);

/** The fixture views are drawn at the card text 22 px (the default is 40): the tests run at that size, so the fixed card boxes show all rows and the lines run where the fixtures put them. */
const FIXTURE_PREFERENCES = { 'catenary.cardFontSize': 22, 'catenary.groupFontSize': 20, 'catenary.noteFontSize': 16, 'catenary.layoutSpacing': 120 };

/** The standard fixture: workspace.trig, data.ttl, shapes.ttl and views/ of packages/rdf/test/fixtures. */
function copyFixtures(workspace) {
  for (const file of ['workspace.trig', 'data.ttl', 'shapes.ttl']) {
    fs.copyFileSync(path.join(root, 'packages/rdf/test/fixtures', file), path.join(workspace, file));
  }
  fs.cpSync(path.join(root, 'packages/rdf/test/fixtures/views'), path.join(workspace, 'views'), { recursive: true });
}

/** Start a backend on `workspace`. `backend` (optional) receives the arguments, the exit code and the signal. */
function startBackend(workspace, config, onLog, backend = {}) {
  const entry = path.join(root, 'app/lib/backend/main.js');
  assert.ok(fs.existsSync(entry), 'Run pnpm build before pnpm e2e.');
  const settings = path.join(config, 'settings.json');
  if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify(FIXTURE_PREFERENCES, null, 2));
  // Theia reports its listening address through IPC. Port 0 avoids collisions with other runs.
  // With the git extension (Source Control view), as scripts/desktop.sh starts it.
  const args = [workspace, '--hostname', '127.0.0.1', '--port', '0', '--plugins=local-dir:plugins'];
  const proc = fork(entry, args, {
    cwd: path.join(root, 'app'),
    env: { ...process.env, THEIA_CONFIG_DIR: config },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  Object.assign(backend, { command: [process.execPath, entry, ...args], pid: proc.pid, exitCode: null, signal: null });
  proc.once('exit', (code, signal) => Object.assign(backend, { exitCode: code, signal }));
  proc.stdout.on('data', onLog);
  proc.stderr.on('data', onLog);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend did not listen within 20 seconds')), 20000);
    proc.once('error', e => { clearTimeout(timer); reject(e); });
    proc.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Backend exited before readiness (code ${code}, signal ${signal})`)); });
    proc.once('message', address => {
      clearTimeout(timer);
      if (!address?.port) reject(new Error(`Invalid backend address: ${JSON.stringify(address)}`));
      else resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return { proc, ready };
}

/** True while a process of the group `pid` runs. */
const groupAlive = pid => {
  try { process.kill(-pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
};

/** Stop the backend and Theia's helper processes (its process group). Resolves after the group has no process. */
async function stopBackend(proc) {
  if (!proc?.pid) return;
  const kill = signal => {
    try { process.kill(-proc.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  };
  const exited = proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise(resolve => proc.once('exit', resolve));
  kill('SIGTERM');
  await Promise.race([exited, sleep(2000)]);
  kill('SIGKILL');
  await exited;
  await waitUntil(`process group ${proc.pid} has no process`, () => groupAlive(proc.pid), alive => !alive, { timeout: 5000, interval: 50 });
}

/**
 * A backend on a workspace copy, a browser page with the CLI bridge connected, and the cleanup. `run(app)` gets
 * { page, cli, url, dir, workspace, config, logs, errors, waitUntil }: `logs` collects the backend output, the browser console
 * errors and warnings and the page errors; `errors` has the page error messages. `app.waitUntil` stops at once when the backend exits.
 * Options: `fixture(workspace)` (default copyFixtures), `page` (newPage options), `defaultTimeout` (10000), `gotoTimeout` (30000: each
 * page load and the wait for `ready`; a cold load of the Theia bundle on a loaded 4 vCPU runner is not a correctness check),
 * `ready` (a selector to wait for after the page load; null for none).
 * Each resource registers its cleanup when it is created. On a failure the temporary folder stays, with the workspace, the
 * configuration, backend-browser.log, diagnostics.json (phase, URL, backend exit code and signal, the last CLI commands, browser
 * errors), failure.png, page.html, long-tasks.json (the long tasks of the page, see LONG_TASKS) and
 * backend-trace.json (the backend trace, when the scenario turned it on).
 */
async function withApp(t, name, options, run) {
  const { fixture = copyFixtures, page: pageOptions = { viewport: { width: 1600, height: 1000 } }, defaultTimeout = 10000, gotoTimeout = 30000,
    ready = '#shell-tab-explorer-view-container' } = options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `catenary-${name}-`));
  const workspace = path.join(dir, 'workspace'), config = path.join(dir, 'config');
  const cleanups = [];
  let passed = false;
  t.after(async () => {
    let failure;
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (e) { failure ??= e; }
    }
    if (passed && !failure) fs.rmSync(dir, { recursive: true, force: true });
    if (failure) throw failure;
  });
  const logs = [], errors = [];
  const diagnostics = { scenario: t.name, phase: 'fixture', url: null, backend: {}, commands: [], browserErrors: [] };
  const record = entry => { diagnostics.commands.push(entry); if (diagnostics.commands.length > 5) diagnostics.commands.shift(); };
  const abort = () => {
    const { exitCode, signal } = diagnostics.backend;
    return exitCode != null || signal != null ? `the backend exited (code ${exitCode}, signal ${signal})` : undefined;
  };
  let page;
  try {
    fs.mkdirSync(workspace);
    fs.mkdirSync(config);
    fixture(workspace);
    diagnostics.phase = 'backend start';
    const started = startBackend(workspace, config, data => logs.push(String(data)), diagnostics.backend);
    cleanups.push(() => stopBackend(started.proc));
    const url = diagnostics.url = await started.ready;
    const cli = catenaryCli(url, record);
    diagnostics.phase = 'browser launch';
    const browser = await launchBrowser(t);
    cleanups.push(() => browser.close());
    browser.on('disconnected', () => diagnostics.browserErrors.push('browser disconnected'));
    page = await browser.newPage(pageOptions);
    page.setDefaultTimeout(defaultTimeout);
    await page.addInitScript(LONG_TASKS);
    page.setDefaultNavigationTimeout(gotoTimeout);
    page.on('console', m => {
      if (m.type() === 'error' || m.type() === 'warn') logs.push(m.text());
      if (m.type() === 'error') diagnostics.browserErrors.push(`console: ${m.text()}`);
    });
    page.on('pageerror', e => { errors.push(e.message); logs.push(e.stack ?? e.message); diagnostics.browserErrors.push(`page: ${e.message}`); });
    diagnostics.phase = 'page load';
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (ready) await page.locator(ready).waitFor({ timeout: gotoTimeout });
    diagnostics.phase = 'CLI bridge';
    await waitUntil('the CLI bridge reports a browser window', () => cli('status').windows.length, n => n > 0, { timeout: 15000, abort });
    diagnostics.phase = 'scenario';
    const bound = (description, observe, until, opts) => waitUntil(description, observe, until, { abort, ...opts });
    await run({ page, cli, url, dir, workspace, config, logs, errors, waitUntil: bound });
    passed = true;
  } catch (e) {
    fs.writeFileSync(path.join(dir, 'backend-browser.log'), logs.join('\n'));
    fs.writeFileSync(path.join(dir, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
    await page?.screenshot({ path: path.join(dir, 'failure.png'), timeout: 3000 }).catch(() => {});
    if (page) fs.writeFileSync(path.join(dir, 'page.html'), await page.content().catch(() => ''));
    // A stalled page can also answer no evaluate: the probe read has its own limit.
    const probe = page && await Promise.race([page.evaluate(() => ({ timeOrigin: performance.timeOrigin, now: performance.now(),
      visibility: document.visibilityState, focus: document.hasFocus(), longTasks: globalThis.__e2eLongTasks })).catch(e => ({ error: e.message })),
    new Promise(resolve => setTimeout(() => resolve({ error: 'no answer in 3000 ms' }), 3000))]);
    if (probe) fs.writeFileSync(path.join(dir, 'long-tasks.json'), JSON.stringify({ failedAt: new Date().toISOString(), ...probe }, null, 2));
    try { fs.writeFileSync(path.join(dir, 'backend-trace.json'), JSON.stringify(catenaryCli(diagnostics.url)('rpc', 'trace', '0'), null, 2)); } catch {}
    const { exitCode = null, signal = null } = diagnostics.backend;
    console.error(`${name} failure artifacts: ${dir}`);
    throw new Error(`${name} failed in phase "${diagnostics.phase}": ${e.message}\n`
      + `URL: ${diagnostics.url}; backend exit code ${exitCode}, signal ${signal}\n`
      + `Last CLI command: ${show(diagnostics.commands.at(-1) ?? null)}\n`
      + `Browser errors: ${diagnostics.browserErrors.length ? diagnostics.browserErrors.slice(-5).join(' | ') : 'none'}\n`
      + `Artifacts: ${dir}`, { cause: e });
  }
}

/** withApp on the standard fixture (copyFixtures). */
const withFixtureApp = (t, name, run) => withApp(t, name, {}, run);

module.exports = { test, run, root, launchBrowser, waitUntil, catenaryCli, navNode, navigator, rdfRows, FIXTURE_PREFERENCES, copyFixtures,
  startBackend, stopBackend, withApp, withFixtureApp };
