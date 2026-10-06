#!/usr/bin/env node
// Smoke test of the desktop app: starts it on a copy of examples/catalog, drives it with the CLI protocol and checks the file paths,
// the writes, Git, the watcher, the plugins and the native modules. Made for the Windows package (CI workflow windows.yml); runs on
// Linux too. The workspace path has a space and a non-ASCII letter. The test never uses workspace/ and stops the processes it started.
// Usage: node scripts/smoke-desktop.mjs [package-dir] [--crlf | --launcher]
//   package-dir  dist/Catenary-win32-x64. Without it: the Linux build of electron-app/. On Linux without a display, use xvfb-run.
//   --crlf       the workspace files have CRLF line ends, as after a Git checkout with core.autocrlf on Windows.
//   --launcher   start Catenary.cmd of the package on its example/ folder (Windows). Read-only: no edits in the package.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const argv = process.argv.slice(2);
const pkg = argv.find(a => !a.startsWith('--')) && resolve(argv.find(a => !a.startsWith('--')));
const crlf = argv.includes('--crlf');
const launcher = argv.includes('--launcher');
if (launcher && !(windows && pkg)) {
    console.log('--launcher needs Windows and a package folder');
    process.exit(2);
}
// The long path name: on Windows, os.tmpdir() can be a short 8.3 name (C:\Users\RUNNER~1\…), which a user does not type.
const tmp = mkdtempSync(join(realpathSync.native(tmpdir()), 'catenary-smoke-'));
const ws = launcher ? join(pkg, 'example') : join(tmp, 'my wörkspace');
const run = join(tmp, 'run');
const log = join(tmp, 'app.log');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;

function check(name, ok, detail) {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? `\n     ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

async function until(what, fn, ms = 90000) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
        try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
        await sleep(500);
    }
    throw new Error(`timeout: ${what}${last ? ` (last: ${JSON.stringify(last)})` : ''}`);
}

const gitEnv = { GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 'smoke@example.org', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 'smoke@example.org' };
// `-C` instead of `cwd`: a missing folder gives a git message, not a spawn ENOENT. On a failure, the output says why.
const git = (...args) => {
    try {
        return execFileSync('git', ['-C', ws, '-c', 'user.name=smoke', '-c', 'user.email=smoke@example.org', ...args], { encoding: 'utf8' }).trim();
    } catch (e) {
        const where = (() => { try { return execFileSync(windows ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).trim(); } catch (w) { return w.message; } })();
        throw new Error(`git ${args.join(' ')}: ${e.message}\n  workspace ${JSON.stringify(ws)} exists: ${existsSync(ws)}\n  git: ${where}`);
    }
};

/** A recursive copy. Not fs.cpSync: on Windows, Node 22 gave no error and no folder for a destination with a non-ASCII letter. */
function copyTree(from, to) {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from, { withFileTypes: true })) {
        if (e.isDirectory()) copyTree(join(from, e.name), join(to, e.name));
        else copyFileSync(join(from, e.name), join(to, e.name));
    }
}

mkdirSync(run);
if (!launcher) {
    copyTree(join(root, 'examples/catalog'), ws);
    // The line ends of the copy, whatever the checkout gave (core.autocrlf on Windows): LF, or CRLF with --crlf.
    for (const f of readdirSync(ws, { recursive: true }).map(f => join(ws, f)).filter(f => /\.(ttl|trig)$/.test(f))) {
        writeFileSync(f, readFileSync(f, 'utf8').replace(/\r?\n/g, crlf ? '\r\n' : '\n'));
    }
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'catalog');
}

const plugins = pkg ? join(pkg, 'resources/app/plugins') : join(root, 'app/plugins');
const profile = `--user-data-dir=${join(tmp, 'profile')}`;
// Catenary.cmd gives the example folder and the plugins; it starts Catenary.exe with `start` and ends at once.
const [exe, args, cwd] = launcher ? ['cmd.exe', ['/d', '/c', join(pkg, 'Catenary.cmd'), profile], pkg]
    : pkg ? [join(pkg, 'Catenary.exe'), [ws, `--plugins=local-dir:${plugins}`, profile], pkg]
        : [join(realpathSync(join(root, 'node_modules/electron')), 'dist/electron'), ['.', ws, `--plugins=local-dir:${plugins}`, profile], join(root, 'electron-app')];
// Linux CI runners and containers have no usable Chromium sandbox (no SUID helper, user namespaces off or root).
if (!windows) args.push('--no-sandbox');
const out = openSync(log, 'a');
// XDG_RUNTIME_DIR: the backend writes its discovery file there (cli-endpoint.ts), so the test finds its own backend only.
const env = { ...process.env, ...gitEnv, XDG_RUNTIME_DIR: run, CATENARY_BACKEND_LOG: log };
const app = spawn(exe, args, { cwd, env, detached: !windows, stdio: ['ignore', out, out] });
let backendPid;

/** The parent process of `pid` on Windows: the Electron main process of the backend. */
const parentPid = pid => Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`], { encoding: 'utf8' }).trim());

function stop() {
    try {
        if (windows) execFileSync('taskkill', ['/PID', String(launcher && backendPid ? parentPid(backendPid) : app.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-app.pid, 'SIGTERM');
    } catch { /* already ended */ }
    try { if (backendPid) process.kill(windows ? backendPid : -backendPid, 'SIGTERM'); } catch { /* already ended */ }
}

let instance;
async function cli(method, params = {}) {
    const res = await fetch(`http://${instance.host}:${instance.port}/catenary/cli`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token}` },
        body: JSON.stringify({ method, params })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
}
const rpc = (method, ...args) => cli('rpc', { method, args });
const evaluate = code => cli('eval', { code });
const status = () => cli('status');
const commits = () => Number(git('rev-list', '--count', 'HEAD'));
/** The edit is on disk and in Git: nothing dirty, a new commit, a clean Git status. */
const settled = async before => {
    await until('write and commit', async () => !(await status()).model.dirty && commits() > before && git('status', '--porcelain') === '');
    return commits();
};

try {
    const dir = join(run, 'catenary');
    const file = await until('discovery file of the backend', () => existsSync(dir) && readdirSync(dir).find(f => f.endsWith('.json')), 120000);
    instance = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    backendPid = instance.pid;
    const s = await until('model and window', async () => { const r = await status(); return r.model?.file && r.windows?.length ? r : undefined; });

    // Paths of the backend: native separators, inside the workspace, on disk.
    check('workspace file path', s.files.workspace.path === join(ws, 'workspace.trig'), s.files.workspace.path);
    const paths = [...s.files.files, ...s.files.views].map(f => f.path);
    const outside = paths.filter(p => !p.startsWith(ws + sep) || !existsSync(p));
    check(`model and view files inside the workspace and on disk (${paths.length})`, paths.length >= 4 && !outside.length, outside);
    check('no read warnings except Git', (await cli('model', { path: 'warnings' })).every(w => /commit/.test(w)), await cli('model', { path: 'warnings' }));

    // Paths in the frontend: Theia URIs and the backend paths must give the same strings (commands.ts, file-kinds-decorator.ts compare them).
    const front = await evaluate(`
        const find = name => ctx.get([...ctx.container._bindingDictionary._map.keys()].find(k => (typeof k === 'symbol' ? k.description : k?.name) === name));
        const root = (await find('WorkspaceService').roots)[0].resource;
        const URI = root.constructor;
        const children = (await find('FileService').resolve(root)).children.map(c => c.resource.path.fsPath());
        const files = ctx.model.snapshot.files.files.map(f => f.path);
        const search = await find('FileSearchService').find('data', { rootUris: [root.toString()], limit: 10 });
        const drives = await find('EnvVariablesServer').getDrives();
        return { root: root.path.fsPath(), roundTrip: files.filter(p => URI.fromFilePath(p).path.fsPath() !== p), children, files, search, drives };`);
    check('frontend workspace root is the workspace path', front.root === ws, front.root);
    check('backend paths survive a Theia URI round trip', front.roundTrip.length === 0, front.roundTrip);
    const unlisted = front.files.filter(p => dirname(p) === ws && !front.children.includes(p));
    check('file navigator names equal backend paths', unlisted.length === 0, { unlisted, children: front.children });
    check('file search finds data.ttl (ripgrep)', front.search.some(u => u.endsWith('/data.ttl')), front.search);
    check('drive list (drivelist stub on Windows)', front.drives.length > 0, front.drives);

    // Source Control: the Git plugins load from the --plugins folder (a `local-dir:` URI with a Windows path in Catenary.cmd).
    if (existsSync(join(plugins, 'vscode.git'))) {
        const git = await until('Git plugin commands', async () => JSON.stringify(await cli('commands', { filter: 'git.', all: true })).includes('"git.commit"'), 90000).catch(e => e.message);
        check('Git plugin loaded (git.commit command)', git === true, git);
    } else console.log(`info no Git plugins in ${plugins}: Source Control not checked`);
    if (!launcher) await edits();
} catch (e) {
    check('smoke test ran to the end', false, e.message);
} finally {
    stop();
    await sleep(1000);
    if (failures && existsSync(log)) console.log(`\napp output (${log}):\n${readFileSync(log, 'utf8').split('\n').slice(-60).join('\n')}`);
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows can hold a file for a moment */ }
}
console.log(failures ? `smoke: ${failures} failed` : 'smoke: passed');
process.exit(failures ? 1 : 0);

/** Writes in the copy of the workspace: new file, text patch, undo, watcher, settings. */
async function edits() {
    // An edit writes a new file and commits it; undo removes it.
    let n = commits();
    const created = await rpc('execute', { kind: 'createView', label: 'Smoke test' });
    check('createView', created.result?.ok === true, created);
    n = await settled(n);
    const view = (await status()).files.views.find(v => v.view === created.result.id);
    check('new view file in views/ and committed', !!view && view.path.startsWith(join(ws, 'views') + sep) && existsSync(view.path), view);
    await rpc('undo');
    n = await settled(n);
    check('undo removes the view file', view && !existsSync(view.path), view?.path);

    // A rename patches the text of data.ttl (a Turtle text patch) and keeps its line ends.
    const data = join(ws, 'data.ttl');
    const renamed = await rpc('execute', { kind: 'rename', id: 'n-urn_3aname_3aEnglish', label: 'English language' });
    check('rename', renamed.result?.ok === true, renamed);
    n = await settled(n);
    const patched = readFileSync(data, 'utf8');
    check('data.ttl patched', patched.includes('"English language"'), patched.slice(0, 300));
    check(`data.ttl keeps ${crlf ? 'CRLF' : 'LF'} line ends`, crlf ? !/[^\r]\n/.test(patched) : !patched.includes('\r'), JSON.stringify(patched.slice(0, 200)));
    await rpc('undo');
    n = await settled(n);

    // The watcher reads a file that another program writes in a new subfolder.
    const added = join(ws, 'sub folder', 'added.ttl');
    mkdirSync(dirname(added));
    writeFileSync(added, '@prefix ex: <http://example.org/> .\nex:Added a ex:Thing .\n');
    const seen = await until('watcher reads the new file', async () => (await status()).files.files.find(f => f.path === added), 30000).catch(e => e.message);
    check('watcher: external file listed with its native path', typeof seen === 'object', seen);
    git('add', '-A');
    git('commit', '-q', '-m', 'added');
    n = commits();

    // Settings: the manifest stores the file in a subfolder as a relative path with `/`, and reads it back as a native path.
    const set = await rpc('setSettings', { defaultFile: 'sub folder/added.ttl' });
    check('setSettings', set.result?.ok === true, set);
    n = await settled(n);
    const manifest = readFileSync(join(ws, 'workspace.trig'), 'utf8');
    check('workspace.trig has "sub folder/added.ttl" and no \\', manifest.includes('sub folder/added.ttl') && !manifest.includes('\\'), manifest);
    const defaultFile = (await status()).files.defaultFile;
    check('default file read back as native path', defaultFile.path === added, defaultFile);

    const text = readFileSync(log, 'utf8');
    // keymapping.node: package-windows.sh removes native-keymap (no Windows prebuild); Theia then uses the browser keyboard layout.
    const native = text.split('\n').filter(l => /Failed to load native module|Could not load native|No prebuild|ERR_DLOPEN|not a valid Win32|Cannot find module .*\.node/.test(l))
        .filter(l => !/keymapping\.node/.test(l));
    check('no native module errors in the app output (keymapping.node is left out)', native.length === 0, native);
}
