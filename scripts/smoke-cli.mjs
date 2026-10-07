#!/usr/bin/env node
// Contract smoke test of the CLI and RPC protocol against the browser backend (app/lib/backend/main.js, run `pnpm build` first).
// Starts a backend on a copy of the test fixtures, drives it with scripts/catenary.mjs and checks: authentication, the RPC method
// list, an edit that writes a view file, undo and redo on disk, and a second backend that reads the written files back.
// CI runs it for critical and platform changes (.github/workflows/ci.yml). Never uses workspace/; stops the processes it started.
// Usage: node scripts/smoke-cli.mjs
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'app/lib/backend/main.js');
if (!existsSync(entry)) {
    console.log('app/lib/backend/main.js missing: run pnpm build first');
    process.exit(2);
}
const tmp = mkdtempSync(join(tmpdir(), 'catenary-smoke-cli-'));
const ws = join(tmp, 'workspace');
const run = join(tmp, 'run');
const fixtures = join(root, 'packages/rdf/test/fixtures');
mkdirSync(ws);
for (const f of ['workspace.trig', 'data.ttl', 'shapes.ttl', 'views']) cpSync(join(fixtures, f), join(ws, f), { recursive: true });
const viewFile = join(ws, 'views/cli-smoke-view.view.trig');
const label = 'CLI smoke view';

let failures = 0;
function check(name, ok, detail) {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? `\n     ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 30000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timeout: ${what}`);
        await sleep(200);
    }
}

/** A backend with its own discovery folder. Returns { port, token, stop }. */
async function start(name) {
    const runDir = join(run, name);
    mkdirSync(runDir, { recursive: true });
    const log = openSync(join(tmp, `${name}.log`), 'a');
    const proc = spawn(process.execPath, [entry, ws, '--hostname', '127.0.0.1', '--port', '0'], {
        cwd: join(root, 'app'), env: { ...process.env, XDG_RUNTIME_DIR: runDir }, detached: true, stdio: ['ignore', log, log]
    });
    const dir = join(runDir, 'catenary');
    const file = await until(`discovery file of backend ${name}`, () => existsSync(dir) && readdirSync(dir).find(f => f.endsWith('.json')));
    const info = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const cli = (...args) => JSON.parse(execFileSync(process.execPath, [join(root, 'scripts/catenary.mjs'), '--port', String(info.port), ...args],
        { env: { ...process.env, XDG_RUNTIME_DIR: runDir }, encoding: 'utf8' }));
    const stop = async () => {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* ended */ }
        await sleep(500);
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* ended */ }
    };
    return { ...info, cli, stop };
}

const post = (port, headers) => fetch(`http://127.0.0.1:${port}/catenary/cli`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ method: 'status' })
}).then(r => r.status);

let a, b;
try {
    a = await start('a');
    const { cli } = a;
    check('status before open: empty model', cli('status').model?.views === 0);
    check('request without a token: 401', (await post(a.port, {})) === 401);
    check('request with a wrong token: 401', (await post(a.port, { authorization: 'Bearer wrong' })) === 401);
    check('request with the token: 200', (await post(a.port, { authorization: `Bearer ${a.token}` })) === 200);

    const methods = cli('rpc');
    const missing = ['open', 'execute', 'save', 'undo', 'redo', 'getSnapshot'].filter(m => !(m in methods));
    check('RPC method list has the core methods', !missing.length, missing);

    const opened = cli('rpc', 'open', JSON.stringify(join(ws, 'workspace.trig')));
    check('open the workspace', opened.result?.ok === true && opened.model?.file === join(ws, 'workspace.trig'), opened);
    const before = cli('model', 'views');
    const warnings = cli('model', 'warnings');

    const created = cli('exec', JSON.stringify({ kind: 'createView', label }));
    check('createView returns the new ID', created.result?.ok === true && typeof created.result.id === 'string', created);
    await until('the edit is on disk', () => cli('model', 'dirty') === false && existsSync(viewFile));
    check('the view is in the model', cli('model', 'views')[created.result.id] === label);
    check('the view file is written', existsSync(viewFile));

    cli('undo');
    await until('undo is on disk', () => cli('model', 'dirty') === false && !existsSync(viewFile));
    check('undo removes the view and its file', !(created.result.id in cli('model', 'views')) && !existsSync(viewFile));
    cli('redo');
    await until('redo is on disk', () => cli('model', 'dirty') === false && existsSync(viewFile));
    check('redo restores the view and its file', cli('model', 'views')[created.result.id] === label && existsSync(viewFile));
    await a.stop();
    a = undefined;

    b = await start('b');
    const reopened = b.cli('rpc', 'open', JSON.stringify(join(ws, 'workspace.trig')));
    check('a second backend opens the written files', reopened.result?.ok === true, reopened);
    const views = b.cli('model', 'views');
    check('it reads the new view and the old views', views[created.result.id] === label && Object.keys(before).every(id => id in views), views);
    check('no new read warnings', JSON.stringify(b.cli('model', 'warnings')) === JSON.stringify(warnings), b.cli('model', 'warnings'));
} catch (e) {
    failures++;
    console.log(`FAIL ${e.message.split('\n').slice(0, 5).join('\n     ')}`);
} finally {
    await a?.stop();
    await b?.stop();
}
if (failures) console.log(`smoke-cli: ${failures} failures. Logs: ${tmp}`);
else {
    rmSync(tmp, { recursive: true, force: true });
    console.log('smoke-cli: passed');
}
process.exit(failures ? 1 : 0);
