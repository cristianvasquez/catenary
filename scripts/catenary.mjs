#!/usr/bin/env node
// Command-line interface of a running Catenary backend, for agents and scripts. Output: JSON on stdout.
// Protocol: modeler/src/common/cli-protocol.ts. The backend writes $XDG_RUNTIME_DIR/catenary/<pid>.json (port, token) at start.
import { readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// The CLI protocol version, shared with the backend (modeler/src/common/cli-protocol.ts, manifest §12).
const { cliProtocol: CLI_PROTOCOL } = JSON.parse(readFileSync(new URL('../modeler/src/common/cli-protocol.json', import.meta.url), 'utf8'));

const USAGE = `Usage: catenary [--port N | --workspace PATH] [--window N] [--timeout MS] <command> [arguments]

--workspace PATH: use the backend whose loaded model file is PATH (a .trig file) or is inside PATH (a folder).

Backend (works without a browser window):
  instances                      running backends (discovery files)
  status                         model summary, files, connected windows
  model [dot.path] [--keys]      the model snapshot, or a part: views, counts, violations, meta, files
  rpc [method [json-arg...]]     call a ModelService method; without a method: list methods and parameters
  exec '<EditCommand JSON>'      rpc execute; the command kinds and their fields: exec --schema
  exec --schema [kind]           the command kinds with their fields and docs, or the fields of one kind; no backend
  exec '[<EditCommand>, ...]'    rpc executeBatch: one transaction, one undo step, one commit; a failure changes nothing.
                                 "$N" in a command is the result id of command N (0-based)
  exec -                         the same batch, from NDJSON on stdin (one command per line)
  undo | redo | save             rpc shortcuts
  layout <view> [--mode layered|force]
                                 lay out a view (ID or IRI) as Apply Layout does: one setLayout command, one undo step

Frontend (needs an open window):
  commands [filter] [--all]      Theia commands: id, label, enabled, keys (--all: also disabled ones)
  run <command-id> [json-arg...] run a command; the result tells: done, error, waiting (prompt open), timeout
  prompt                         the open prompt: dialog, quick pick, input box, picker (view editor), inline input (card, tab)
  answer [text] [--pick LABEL | --index N | --button LABEL | --cancel]
                                 answer the open prompt, then wait as run does
  ui                             active widget, open views, selection, open prompt
  open-view <view-id> [--fit]    open and activate a view in the window (command catenary.openView), then report ui.currentView;
                                 exit 0 only when it is the view; --fit: fit the view to the screen after the open
  messages [--since SEQ]         notifications (last 200)
  eval '<js>'                    evaluate in the window; expression or statements with return; ctx: container, get(symbol),
                                 commands, model, selection, editors, shell

Exit status: 0 done, 1 failed, 2 usage or connection error, 3 waiting for an answer or timeout.`;

function fail(message, code = 2) {
    process.stderr.write(JSON.stringify({ error: message }) + '\n');
    process.exit(code);
}

/** Write to stdout, then exit. A pipe takes a large write in several steps: process.exit right after the write cuts the output at 64 KiB. */
function finish(text, code) {
    process.exitCode = code;
    // A reader that closes the pipe early (| head) gives EPIPE: not an error of the command.
    process.stdout.on('error', e => process.exit(e.code === 'EPIPE' ? code : 1));
    process.stdout.write(text, () => process.exit(code));
}

function parseArgs(argv) {
    const opts = {};
    const pos = [];
    const valued = new Set(['port', 'workspace', 'window', 'timeout', 'pick', 'index', 'button', 'since', 'mode']);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') opts.help = true;
        else if (a.startsWith('--')) {
            const [k, v] = a.slice(2).split(/=(.*)/s);
            if (valued.has(k)) opts[k] = v ?? argv[++i];
            else opts[k] = true;
        } else pos.push(a);
    }
    return { opts, pos };
}

const jsonArg = s => { try { return JSON.parse(s); } catch { return s; } };

function instances() {
    const dir = join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'catenary');
    let files = [];
    try { files = readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
    return files.flatMap(f => {
        try {
            const info = JSON.parse(readFileSync(join(dir, f), 'utf8'));
            try { process.kill(info.pid, 0); } catch { unlinkSync(join(dir, f)); return []; }
            const first = info.argv?.[0];
            info.workspace = first && !first.startsWith('-') ? resolve(info.cwd, first) : undefined;
            return [info];
        } catch { return []; }
    });
}

/** The model file that a backend has loaded (status → model.file), or the error of the status request. */
async function loadedFile(instance) {
    try {
        const res = await fetch(`http://${instance.host}:${instance.port}/catenary/cli`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token}` },
            body: JSON.stringify({ method: 'status' }),
            signal: AbortSignal.timeout(5000)
        });
        const body = await res.json();
        if (!res.ok) return { error: body.error ?? `HTTP ${res.status}` };
        return { file: body.model?.file };
    } catch (e) {
        return { error: e.cause?.message ?? e.message };
    }
}

const realpath = p => { try { return realpathSync(p); } catch { return resolve(p); } };
/** Path a is folder b or is inside it. path.relative also handles a root folder ("/", "C:\\"). */
const inside = (a, b) => { const r = relative(b, a); return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)); };

/** --workspace: the one backend whose loaded model file is PATH or is inside the folder PATH. Manifest §12 law_workspaceSelectsOne. */
async function pickByWorkspace(all, path) {
    const target = realpath(resolve(path));
    let stat;
    try { stat = statSync(target); } catch { fail(`--workspace ${path}: no such file or folder`); }
    if (!stat.isDirectory() && !target.endsWith('.trig')) fail(`--workspace ${path}: give a folder or a .trig file`);
    const loaded = await Promise.all(all.map(loadedFile));
    const matches = all.filter((_, n) => loaded[n].file && inside(realpath(loaded[n].file), target));
    if (matches.length === 1) return matches[0];
    const list = all.map((i, n) => `${i.port} (${loaded[n].file ?? (loaded[n].error ? `error: ${loaded[n].error}` : 'no model loaded')})`).join(', ');
    fail(`${matches.length ? `${matches.length} backends` : 'no backend'} loaded ${target}; running: ${list || 'none'}`);
}

async function pickInstance(opts) {
    const all = instances();
    if ('workspace' in opts) {
        if ('port' in opts) fail('give --port or --workspace, not both');
        if (!opts.workspace) fail('--workspace needs a path');
        return pickByWorkspace(all, opts.workspace);
    }
    const port = opts.port ?? process.env.CATENARY_PORT;
    if (port) {
        const found = all.find(i => String(i.port) === String(port));
        if (!found) fail(`no running backend on port ${port}; running: ${all.map(i => i.port).join(', ') || 'none'}`);
        return found;
    }
    if (!all.length) fail('no running backend found; start one with "pnpm start" or "pnpm desktop"');
    if (all.length === 1) return all[0];
    const cwd = process.cwd();
    const matches = all.filter(i => i.workspace && (inside(cwd, i.workspace) || inside(i.workspace, cwd)));
    if (matches.length === 1) return matches[0];
    fail(`${all.length} backends run; choose one with --port: ${all.map(i => `${i.port} (${i.workspace ?? i.cwd})`).join(', ')}`);
}

/**
 * The selected backend for a command. Every command except status and instances needs a backend with the CLI protocol of this CLI: an
 * older backend can ignore new arguments without an error. The discovery file gives the version; a missing value is 1.
 */
async function backendFor(opts, command) {
    const instance = await pickInstance(opts);
    const protocol = instance.cliProtocol ?? 1;
    if (command !== 'status' && protocol < CLI_PROTOCOL) {
        fail(`The backend on port ${instance.port} uses CLI protocol ${protocol}. This CLI needs ${CLI_PROTOCOL}: restart the backend.`);
    }
    return instance;
}

/** The argument of exec: one JSON object, or a JSON array (a batch). Else exit 2. */
function execArgument(text) {
    let value;
    try { value = JSON.parse(text); } catch { /* not JSON */ }
    if (value === null || typeof value !== 'object') fail('exec takes one JSON object with a string kind, or a JSON array of them');
    return value;
}

/** The commands of `exec -`: NDJSON on stdin, one JSON object per line (empty lines are skipped). Else exit 2. */
function execStdin() {
    const lines = readFileSync(0, 'utf8').split(/\r?\n/);
    const commands = [];
    lines.forEach((line, i) => {
        if (!line.trim()) return;
        let value;
        try { value = JSON.parse(line); } catch { fail(`exec -: line ${i + 1} is not JSON`); }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`exec -: line ${i + 1} is not a JSON object`);
        commands.push(value);
    });
    return commands;
}

/**
 * exec --schema [kind]: the edit command kinds and their fields from packages/model/src/command-schema.json (pnpm gen:schema,
 * manifest §12 law_schemaCoversEveryKind). No backend request. An unknown kind: exit 2 with the list of kinds.
 */
function execSchema(kind) {
    const { commands, types } = JSON.parse(readFileSync(new URL('../packages/model/src/command-schema.json', import.meta.url), 'utf8'));
    const field = f => `${f.name}${f.optional ? '?' : ''}: ${f.type}`;
    if (kind === undefined) return commands.map(c => `${c.kind}(${c.fields.map(field).join(', ')})${c.doc ? '  ' + c.doc : ''}`).join('\n') + '\n';
    const command = commands.find(c => c.kind === kind);
    if (!command) fail(`exec --schema: unknown command kind "${kind}"; kinds: ${commands.map(c => c.kind).join(', ')}`);
    // The aliases that the fields use, and the aliases that those use.
    const uses = new Set();
    const scan = text => Object.keys(types).forEach(t => {
        if (!uses.has(t) && new RegExp(`\\b${t}\\b`).test(text)) { uses.add(t); scan(types[t]); }
    });
    command.fields.forEach(f => scan(f.type));
    return [command.kind, ...(command.doc ? [command.doc] : []), ...command.fields.map(f => '  ' + field(f)),
        ...Object.keys(types).filter(t => uses.has(t)).map(t => `type ${t} = ${types[t]}`)].join('\n') + '\n';
}

async function call(instance, method, params, window) {
    let res;
    try {
        res = await fetch(`http://${instance.host}:${instance.port}/catenary/cli`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token}` },
            body: JSON.stringify({ method, params, window: window === undefined ? undefined : Number(window) })
        });
    } catch (e) {
        fail(`cannot reach backend on port ${instance.port}: ${e.cause?.message ?? e.message}`);
    }
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status} without JSON body` }));
    if (!res.ok) fail(body.error ?? `HTTP ${res.status}`, res.status === 400 ? 1 : 2);
    return body;
}

/**
 * open-view: run catenary.openView in the window, with --fit also glsp.diagram:fit, then read ui.currentView. Exit 0 only when the
 * current view is the requested one. Else exit 1 with the error message of the window, if any.
 */
async function openView(instance, viewId, opts, timeout) {
    const run = await call(instance, 'run', { id: 'catenary.openView', args: [viewId], timeout }, opts.window);
    const fit = opts.fit && run.status === 'done' && run.result === true
        ? await call(instance, 'run', { id: 'glsp.diagram:fit', args: [], timeout }, opts.window) : undefined;
    const { currentView = null } = await call(instance, 'ui', {}, opts.window);
    const messages = [...run.messages ?? [], ...fit?.messages ?? []];
    const ok = currentView === viewId && (!fit || fit.status === 'done');
    const error = ok ? undefined
        : run.error ?? messages.find(m => m.type === 'error')?.text ?? fit?.error
            ?? (currentView === viewId ? `fit: ${fit.status}` : `the current view is ${currentView ?? 'none'}, not ${viewId}`);
    return { result: { status: ok ? 'done' : 'error', view: viewId, currentView, error, messages }, code: ok ? 0 : 1 };
}

/** Exit status of a result: 1 for a failed command, 3 for a command that waits or still runs. */
function exitCode(result) {
    if (result && typeof result === 'object') {
        if (result.status === 'error' || result.error !== undefined) return 1;
        if (result.status === 'waiting' || result.status === 'timeout') return 3;
        if (result.result && typeof result.result === 'object' && result.result.ok === false) return 1;
    }
    return 0;
}

async function main() {
    const { opts, pos } = parseArgs(process.argv.slice(2));
    const [command, ...rest] = pos;
    if (opts.help || !command) {
        return finish(USAGE + '\n', command || opts.help ? 0 : 2);
    }
    if (command === 'instances') {
        process.stdout.write(JSON.stringify(instances().map(({ token, ...i }) => i), null, 2) + '\n');
        return;
    }
    const timeout = opts.timeout === undefined ? undefined : Number(opts.timeout);
    let method, params = {};
    switch (command) {
        case 'status': case 'ui': case 'prompt': method = command; break;
        case 'model': method = 'model'; params = { path: rest[0], keys: !!opts.keys }; break;
        case 'rpc': method = 'rpc'; params = { method: rest[0], args: rest.slice(1).map(jsonArg) }; break;
        case 'exec':
            if (opts.schema) return finish(execSchema(rest[0]), 0);
            if (!rest[0]) fail('exec needs an EditCommand as JSON, e.g. \'{"kind":"createView","label":"V"}\'');
            {
                const value = rest[0] === '-' ? execStdin() : execArgument(rest[0]);
                method = 'rpc'; params = { method: Array.isArray(value) ? 'executeBatch' : 'execute', args: [value] };
            }
            break;
        case 'undo': case 'redo': case 'save': method = 'rpc'; params = { method: command, args: [] }; break;
        case 'layout':
            if (!rest[0]) fail('layout needs a view id or IRI; see "catenary model views --keys"');
            if (opts.mode !== undefined && !['layered', 'force'].includes(opts.mode)) fail(`layout: --mode is layered or force, not "${opts.mode}"`);
            method = 'layout'; params = { view: rest[0], mode: opts.mode ?? 'layered' }; break;
        case 'commands': method = 'commands'; params = { filter: rest[0], all: !!opts.all }; break;
        case 'run':
            if (!rest[0]) fail('run needs a command id; see "catenary commands"');
            method = 'run'; params = { id: rest[0], args: rest.slice(1).map(jsonArg), timeout }; break;
        case 'answer':
            method = 'answer';
            params = { text: rest[0], pick: opts.pick, index: opts.index === undefined ? undefined : Number(opts.index), button: opts.button, cancel: !!opts.cancel, timeout };
            break;
        case 'open-view': {
            if (!rest[0]) fail('open-view needs a view id; see "catenary model views --keys"');
            const { result, code } = await openView(await backendFor(opts, command), rest[0], opts, timeout);
            return finish(JSON.stringify(result, null, 2) + '\n', code);
        }
        case 'messages': method = 'messages'; params = { since: opts.since === undefined ? undefined : Number(opts.since) }; break;
        case 'eval':
            if (!rest[0]) fail('eval needs code');
            method = 'eval'; params = { code: rest.join(' ') }; break;
        default: fail(`unknown command "${command}"; see "catenary --help"`);
    }
    const result = await call(await backendFor(opts, command), method, params, opts.window);
    finish(JSON.stringify(result, null, 2) + '\n', exitCode(result));
}

main().catch(e => fail(e.message ?? String(e), 1));
