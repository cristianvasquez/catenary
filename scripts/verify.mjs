#!/usr/bin/env node
// pnpm verify: check → test → build (→ e2e with --e2e). Stops at the first failed step and shows the end of its log.
// Each step writes its full output to a log file; the summary gives the duration of each step and the log directory.
// Usage: pnpm verify [--no-build] [--e2e]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const steps = [
    ['check', ['check']],
    ['test', ['test']],
    ...(args.has('--no-build') ? [] : [['build', ['build']]]),
    ...(args.has('--e2e') ? [['e2e', ['e2e']]] : [])
];
const logs = mkdtempSync(join(tmpdir(), 'catenary-verify-'));

// The store writes and commits each edit (ADR 0003). A step must not change the test fixtures or make commits in this repository.
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout.trim();
const repoState = () => ({ head: git('rev-parse', 'HEAD'), fixtures: git('status', '--porcelain', '--', 'packages/rdf/test/fixtures') });
const startState = repoState();

/** One line of facts from a log: the vitest count, the e2e count. */
function detail(name, log) {
    const clean = log.replace(/\x1b\[[0-9;]*m/g, '');
    if (name === 'test') return /Tests\s+(.+?)\s*\n/.exec(clean)?.[1] ?? '';
    if (name === 'e2e') return [/(?:#|ℹ) pass (\d+)/, /(?:#|ℹ) fail (\d+)/].map((r, i) => `${clean.match(r)?.[1] ?? '?'} ${i ? 'failed' : 'passed'}`).join(', ');
    return '';
}

for (const [name, script] of steps) {
    const start = Date.now();
    const r = spawnSync('pnpm', ['-s', ...script], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const log = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}\n` : ''}`;
    const file = join(logs, `${name}.log`);
    writeFileSync(file, log);
    const seconds = ((Date.now() - start) / 1000).toFixed(1);
    if (r.status !== 0) {
        console.log(`FAIL ${name} (${seconds}s, exit ${r.status ?? r.signal}) — full log: ${file}\n`);
        console.log(log.trimEnd().split('\n').slice(-40).join('\n'));
        console.log(`\nverify: FAILED at ${name}; later steps did not run.`);
        process.exit(1);
    }
    const state = repoState();
    if (state.head !== startState.head || state.fixtures !== startState.fixtures) {
        console.log(`FAIL ${name}: the step changed the repository (${state.head !== startState.head ? `new commit ${state.head.slice(0, 7)}` : ''}${state.fixtures !== startState.fixtures ? ` fixtures: ${state.fixtures}` : ''}). A test writes to the repository instead of a temporary copy.`);
        process.exit(1);
    }
    console.log(`ok   ${name.padEnd(5)} ${seconds.padStart(6)}s  ${detail(name, readFileSync(file, 'utf8'))}`);
}
console.log(`verify: passed (${steps.map(s => s[0]).join(', ')}). Logs: ${logs}`);
if (!args.has('--no-build')) console.log('A running backend still has the old build: restart it (see "catenary status" → build).');
