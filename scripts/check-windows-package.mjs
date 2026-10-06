#!/usr/bin/env node
// Static check of the Windows package (scripts/package-windows.sh) on any platform: the layout, no Linux or macOS binary left, each
// .exe/.dll/.node is Windows x64, each native file that the bundle loads is there or replaced, and the launcher has CRLF.
// Usage: node scripts/check-windows-package.mjs [package-dir] [--allow-no-plugins]   (default: dist/Catenary-win32-x64)
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const pkg = args.find(a => !a.startsWith('--')) ?? join(root, 'dist/Catenary-win32-x64');
const app = join(pkg, 'resources/app');
const backend = join(app, 'lib/backend');
let failures = 0;

function check(name, ok, detail) {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? `\n     ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

if (!existsSync(app)) {
    console.log(`not a package: ${pkg} (run "pnpm package:win" first)`);
    process.exit(2);
}

const files = [];
const walk = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(join(dir, e.name)) : files.push(join(dir, e.name)); };
walk(pkg);
const rel = f => relative(pkg, f).split('\\').join('/');

function head(file, length, position = 0) {
    const fd = openSync(file, 'r');
    try {
        const b = Buffer.alloc(length);
        return b.subarray(0, readSync(fd, b, 0, length, position));
    } finally { closeSync(fd); }
}

/** The machine of a PE file (0x8664: x64), or undefined when the file is not a PE file. */
function peMachine(file) {
    const dos = head(file, 64);
    if (dos.length < 64 || dos.toString('latin1', 0, 2) !== 'MZ') return undefined;
    const pe = head(file, 6, dos.readUInt32LE(0x3c));
    return pe.length === 6 && pe.toString('latin1', 0, 4) === 'PE\0\0' ? pe.readUInt16LE(4) : undefined;
}

const required = ['Catenary.exe', 'Catenary.cmd', 'resources/app/package.json', 'resources/app/lib/backend/main.js',
    'resources/app/lib/backend/electron-main.js', 'resources/app/lib/frontend/index.html', 'resources/app/lib/backend/native/rg.exe',
    'resources/app/lib/backend/native/watcher.node', 'resources/app/lib/backend/native/keytar.node',
    'resources/app/lib/prebuilds/win32-x64/conpty.node', 'resources/app/lib/prebuilds/win32-x64/conpty_console_list.node',
    'resources/app/lib/prebuilds/win32-x64/conpty/OpenConsole.exe', 'resources/app/lib/prebuilds/win32-x64/conpty/conpty.dll',
    'resources/app/lib/backend/turtle.wasm', 'resources/app/lib/backend/tree-sitter.wasm', 'resources/app/lib/backend/validation-worker.js'];
const missing = required.filter(f => !existsSync(join(pkg, f)));
check('required files', !missing.length, missing);
check('Electron default app removed', !existsSync(join(pkg, 'resources/default_app.asar')));
const main = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).main;
check(`package.json main (${main}) exists`, !!main && existsSync(join(app, main)), main);
check('built-in notations', existsSync(join(backend, 'notations')) && readdirSync(join(backend, 'notations')).some(f => f.endsWith('.ttl')));

// Binaries: ELF (Linux) and Mach-O (macOS) magic numbers; PE x64 for each Windows binary.
const foreign = files.filter(f => statSync(f).size >= 4 && ['7f454c46', 'cffaedfe', 'cefaedfe'].includes(head(f, 4).toString('hex'))).map(rel);
check('no Linux or macOS binaries', !foreign.length, foreign);
const binaries = files.filter(f => /\.(exe|dll|node)$/i.test(f));
const notX64 = binaries.filter(f => peMachine(f) !== 0x8664).map(f => `${rel(f)} (${peMachine(f)?.toString(16) ?? 'not PE'})`);
check(`Windows x64 binaries (${binaries.length})`, binaries.length > 10 && !notX64.length, notX64);

// Native files that the bundles load from lib/backend/native: there, or replaced (drivelist) or optional (native-keymap).
const bundles = readdirSync(backend).filter(f => f.endsWith('.js')).map(f => readFileSync(join(backend, f), 'utf8'));
const loaded = new Set(bundles.flatMap(t => [...t.matchAll(/["'`]\.\/native\/([\w.-]+\.node)["'`]/g)].map(m => m[1])));
const optional = { 'drivelist.node': 'replaced by a stub', 'keymapping.node': 'loaded in try/catch' };
const absent = [...loaded].filter(n => !existsSync(join(backend, 'native', n)) && !optional[n]);
check(`native modules of the bundle (${[...loaded].join(', ')})`, loaded.size > 0 && !absent.length, absent);
const mainJs = bundles[readdirSync(backend).filter(f => f.endsWith('.js')).indexOf('main.js')];
check('drivelist binding replaced by the stub', !mainJs.includes('bindings("drivelist")') && mainJs.includes('var drivelistBindings = { list(cb)'));
check('ripgrep path has .exe on win32', /native\/rg\$\{process\.platform === "win32" \? "\.exe" : ""\}/.test(mainJs));

// Launcher: CRLF, the executable and the plugin folder relative to the launcher.
const cmd = readFileSync(join(pkg, 'Catenary.cmd'), 'latin1');
check('Catenary.cmd has CRLF line ends only', /\r\n$/.test(cmd) && !/[^\r]\n/.test(cmd), JSON.stringify(cmd));
check('Catenary.cmd starts %~dp0Catenary.exe with the plugin folder', cmd.includes('"%~dp0Catenary.exe"') && cmd.includes('local-dir:"%~dp0resources\\app\\plugins"'), cmd);
if (cmd.includes('%~dp0example')) check('example workspace in the package', existsSync(join(pkg, 'example/workspace.trig')));

const plugins = existsSync(join(app, 'plugins')) ? readdirSync(join(app, 'plugins')) : [];
if (args.includes('--allow-no-plugins')) console.log(`info plugins: ${plugins.join(', ') || 'none'}`);
else check('Git plugins (Source Control)', plugins.includes('vscode.git') && plugins.includes('vscode.git-base'), plugins);

console.log(failures ? `package: ${failures} failed` : `package: passed (${files.length} files)`);
process.exit(failures ? 1 : 0);
