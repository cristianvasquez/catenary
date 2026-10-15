import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_PROTOCOL } from '../src/common/cli-protocol';

// scripts/catenary.mjs against a fake discovery file: a live PID (this process) and a port where nothing listens. The checks of these
// tests run before any request.
const script = path.join(__dirname, '../../scripts/catenary.mjs');
let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function cli(discovery: Record<string, unknown>, ...args: string[]) {
    const run = mkdtempSync(path.join(tmpdir(), 'catenary-cli-test-'));
    dirs.push(run);
    mkdirSync(path.join(run, 'catenary'));
    writeFileSync(path.join(run, 'catenary', `${process.pid}.json`),
        JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: 1, token: 't', cwd: run, argv: [], ...discovery }));
    const r = spawnSync(process.execPath, [script, '--port', '1', ...args], { env: { ...process.env, XDG_RUNTIME_DIR: run }, encoding: 'utf8' });
    return { status: r.status, error: r.stderr ? (JSON.parse(r.stderr) as { error: string }).error : undefined };
}

describe('CLI script (manifest §12)', () => {
    it('law_cliRefusesOlderBackend: a backend without cliProtocol is protocol 1; every command except status and instances exits 2', () => {
        expect(CLI_PROTOCOL).toBe(2);
        const refusal = 'The backend on port 1 uses CLI protocol 1. This CLI needs 2: restart the backend.';
        for (const args of [['model'], ['rpc'], ['exec', '{"kind":"createView","label":"V"}'], ['undo'], ['ui'], ['open-view', 'v']]) {
            expect(cli({}, ...args), args.join(' ')).toEqual({ status: 2, error: refusal });
        }
        expect(cli({ cliProtocol: 1 }, 'model')).toEqual({ status: 2, error: refusal });
        // status and instances do not check the protocol: status tries the request (nothing listens on port 1).
        expect(cli({}, 'status').error).toMatch(/^cannot reach backend on port 1/);
        expect(cli({}, 'instances').status).toBe(0);
        // The current protocol passes the check.
        expect(cli({ cliProtocol: CLI_PROTOCOL }, 'model').error).toMatch(/^cannot reach backend on port 1/);
    });

    it('exec takes one JSON object: an array, a string or no JSON exits 2 before a request', () => {
        for (const arg of ['[{"kind":"createView","label":"V"}]', '"createView"', 'null', '{kind:']) {
            expect(cli({ cliProtocol: CLI_PROTOCOL }, 'exec', arg), arg).toEqual({ status: 2, error: 'exec takes one JSON object with a string kind' });
        }
    });
});
