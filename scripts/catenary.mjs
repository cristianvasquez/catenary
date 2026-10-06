#!/usr/bin/env node
// Command-line interface of a running Catenary backend, for agents and scripts. Output: JSON on stdout.
// Protocol: modeler/src/common/cli-protocol.ts. The backend writes $XDG_RUNTIME_DIR/catenary/<pid>.json (port, token) at start.
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const USAGE = `Usage: catenary [--port N] [--window N] [--timeout MS] <command> [arguments]

Backend (works without a browser window):
  instances                      running backends (discovery files)
  status                         model summary, files, connected windows
  model [dot.path] [--keys]      the model snapshot, or a part: views, counts, violations, meta, files
  rpc [method [json-arg...]]     call a ModelService method; without a method: list methods and parameters
  exec '<EditCommand JSON>'      rpc execute; the command kinds: packages/model/src/commands.ts
  undo | redo | save             rpc shortcuts

Frontend (needs an open window):
  commands [filter] [--all]      Theia commands: id, label, enabled, keys (--all: also disabled ones)
  run <command-id> [json-arg...] run a command; the result tells: done, error, waiting (prompt open), timeout
  prompt                         the open prompt: dialog, quick pick, input box, picker (view editor), inline input (card, tab)
  answer [text] [--pick LABEL | --index N | --button LABEL | --cancel]
                                 answer the open prompt, then wait as run does
  ui                             active widget, open views, selection, open prompt
  messages [--since SEQ]         notifications (last 200)
  eval '<js>'                    evaluate in the window; expression or statements with return; ctx: container, get(symbol),
                                 commands, model, selection, editors, shell

Exit status: 0 done, 1 failed, 2 usage or connection error, 3 waiting for an answer or timeout.`;

function fail(message, code = 2) {
    process.stderr.write(JSON.stringify({ error: message }) + '\n');
    process.exit(code);
}

function parseArgs(argv) {
    const opts = {};
    const pos = [];
    const valued = new Set(['port', 'window', 'timeout', 'pick', 'index', 'button', 'since']);
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

function pickInstance(opts) {
    const all = instances();
    const port = opts.port ?? process.env.CATENARY_PORT;
    if (port) {
        const found = all.find(i => String(i.port) === String(port));
        if (!found) fail(`no running backend on port ${port}; running: ${all.map(i => i.port).join(', ') || 'none'}`);
        return found;
    }
    if (!all.length) fail('no running backend found; start one with "pnpm start" or "pnpm desktop"');
    if (all.length === 1) return all[0];
    const cwd = process.cwd();
    const inside = (a, b) => a === b || a.startsWith(b + sep);
    const matches = all.filter(i => i.workspace && (inside(cwd, i.workspace) || inside(i.workspace, cwd)));
    if (matches.length === 1) return matches[0];
    fail(`${all.length} backends run; choose one with --port: ${all.map(i => `${i.port} (${i.workspace ?? i.cwd})`).join(', ')}`);
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

/** Exit status of a result: 1 for a failed command, 3 for a command that waits or still runs. */
function exitCode(result) {
    if (result && typeof result === 'object') {
        if (result.status === 'error') return 1;
        if (result.status === 'waiting' || result.status === 'timeout') return 3;
        if (result.result && typeof result.result === 'object' && result.result.ok === false) return 1;
    }
    return 0;
}

async function main() {
    const { opts, pos } = parseArgs(process.argv.slice(2));
    const [command, ...rest] = pos;
    if (opts.help || !command) {
        process.stdout.write(USAGE + '\n');
        process.exit(command || opts.help ? 0 : 2);
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
            if (!rest[0]) fail('exec needs an EditCommand as JSON, e.g. \'{"kind":"createView","label":"V"}\'');
            method = 'rpc'; params = { method: 'execute', args: [JSON.parse(rest[0])] }; break;
        case 'undo': case 'redo': case 'save': method = 'rpc'; params = { method: command, args: [] }; break;
        case 'commands': method = 'commands'; params = { filter: rest[0], all: !!opts.all }; break;
        case 'run':
            if (!rest[0]) fail('run needs a command id; see "catenary commands"');
            method = 'run'; params = { id: rest[0], args: rest.slice(1).map(jsonArg), timeout }; break;
        case 'answer':
            method = 'answer';
            params = { text: rest[0], pick: opts.pick, index: opts.index === undefined ? undefined : Number(opts.index), button: opts.button, cancel: !!opts.cancel, timeout };
            break;
        case 'messages': method = 'messages'; params = { since: opts.since === undefined ? undefined : Number(opts.since) }; break;
        case 'eval':
            if (!rest[0]) fail('eval needs code');
            method = 'eval'; params = { code: rest.join(' ') }; break;
        default: fail(`unknown command "${command}"; see "catenary --help"`);
    }
    const result = await call(pickInstance(opts), method, params, opts.window);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(exitCode(result));
}

main().catch(e => fail(e.message ?? String(e), 1));
