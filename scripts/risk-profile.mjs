#!/usr/bin/env node
// Risk profile of a change, and the CI plan of that profile. .github/workflows/ci.yml runs it in the classify job.
// Profiles, low to high risk: docs < cosmetic < standard < critical < platform. The highest profile of all changed files and
// tripwires wins. A low profile comes only from an allowlist: an unknown path is `standard`. Labels can only raise the profile.
// Usage:
//   node scripts/risk-profile.mjs [--base <rev>] [--head <rev>] [--mode pr|main|nightly] [--labels a,b] [--pr N]
//       Prints the plan as JSON. In GitHub Actions it also writes the step outputs and the job summary.
//   node scripts/risk-profile.mjs --run-tests [--base <rev>]
//       Runs the unit tests of the plan: the affected tests, or the full suite (fallback when the selection is not safe).
//   node scripts/risk-profile.mjs --gate
//       The merge gate of ci.yml: reads PLAN (the classify outputs) and RESULTS (the job results) from the environment.
// Environment: CI_PROFILES=off gives `platform` to every change (kill switch). CI_SHADOW_EVERY=N runs the full unit suite as a
// non-blocking shadow job on every Nth PR of a reduced profile (default 1: every PR).
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROFILES = ['docs', 'cosmetic', 'standard', 'critical', 'platform'];
const rank = p => PROFILES.indexOf(p);
const max = (a, b) => (rank(a) >= rank(b) ? a : b);

/** A glob with `**`, `*` and one level of `{a,b}` as a RegExp on the whole repository-relative path. */
export function glob(pattern) {
    const re = pattern.split(/(\*\*\/|\*\*|\*|\{[^}]*\})/).map(part =>
        part === '**/' ? '(?:.*/)?'
            : part === '**' ? '.*'
                : part === '*' ? '[^/]*'
                    : part.startsWith('{') ? `(?:${part.slice(1, -1).split(',').map(escape).join('|')})`
                        : escape(part)).join('');
    return new RegExp(`^${re}$`);
}
const escape = s => s.replace(/[.+?^$()|[\]\\{}]/g, '\\$&');

// First matching rule wins. Each rule: [profile, patterns, reason].
export const RULES = [
    ['docs', ['**/*.md', 'LICENSE'], 'documentation', ['**/test/**', '**/fixtures/**', 'examples/**']],
    ['platform', [
        '.github/**', 'scripts/risk-profile.mjs', 'scripts/test/**', 'scripts/package.sh', 'scripts/install-*.sh', 'scripts/build-*.sh',
        'scripts/smoke-desktop.mjs', 'scripts/check-windows-package.mjs', 'scripts/verify.mjs', 'scripts/check-*.mjs',
        'vitest.config.mts', '**/tsconfig*.json', 'pnpm-lock.yaml', '**/package.json', 'pnpm-workspace.yaml', '.node-version',
        'electron-app/**', 'app/**', 'modeler/src/electron-main/**', 'patches/**'
    ], 'build, packaging, dependencies or CI'],
    ['critical', [
        'packages/rdf/**', 'packages/rdf-files/**', 'packages/rdf-serialization/**'
    ], 'store, files on disk or serialization'],
    ['critical', [
        'modeler/src/node/**', 'modeler/src/common/protocol.ts', 'modeler/src/common/cli-protocol.ts', 'scripts/catenary.mjs',
        'scripts/smoke-cli.mjs'
    ], 'RPC, CLI or token check'],
    ['critical', [
        'packages/model/src/{commands,snapshot,ids,paths}.ts'
    ], 'edit commands, snapshot schema, IDs or paths (persisted)'],
    ['standard', ['packages/model/**', 'modeler/**/*.{ts,tsx}', 'modeler/test/**', 'examples/**', 'spec/*.hs', 'scripts/**'], 'application code'],
    ['cosmetic', ['modeler/css/**/*.css', 'docs/**/*.{png,svg,jpg,gif}'], 'styles or images']
].map(([profile, patterns, reason, except = []]) => ({ profile, res: patterns.map(glob), reason, except: except.map(glob) }));

/** Files whose behavior differs on Windows: the Windows unit job tests them (.github/workflows/windows.yml). */
const WINDOWS = ['packages/model/src/paths.ts', 'packages/rdf-files/src/**', 'packages/rdf/src/{workspace,files,trig,placement}.ts',
    'modeler/src/electron-main/**', 'modeler/test/electron-profile.test.ts', 'packages/*/test/{paths,rdf-files,watch,workspace-files,workspace,review-save,text-patch,trig}.test.ts',
    '.github/workflows/windows.yml'].map(glob);
/** Files of the packages: a change builds and starts the Linux and Windows packages. */
const PACKAGING = ['scripts/package.sh', 'scripts/smoke-desktop.mjs', 'scripts/check-windows-package.mjs', 'scripts/install-electron.sh',
    'scripts/build-drivelist.sh', 'electron-app/**', 'modeler/src/electron-main/**', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/**',
    '.node-version', 'app/package.json', '.github/workflows/windows.yml'].map(glob);
const RELEASE = ['.github/workflows/release.yml', 'scripts/package.sh'].map(glob);
/** Files that the browser tests (scripts/e2e.cjs) check. */
const BROWSER = ['modeler/src/browser/**', 'modeler/css/**', 'scripts/e2e.cjs', 'app/**'].map(glob);
const any = (res, f) => res.some(r => r.test(f));

export function pathProfile(file) {
    for (const rule of RULES) {
        if (rule.res.some(r => r.test(file)) && !rule.except.some(r => r.test(file))) return { profile: rule.profile, reason: rule.reason };
    }
    return { profile: 'standard', reason: 'no rule: unknown paths get standard' };
}

const isTest = f => /(^|\/)test\//.test(f) || /\.test\.[cm]?[jt]sx?$/.test(f) || f === 'scripts/e2e.cjs';
const isCode = f => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f);
// Tripwires on added lines. Each: [regex, profile, reason, applies to test files too].
const TRIPWIRES = [
    [/\bfrom\s+['"](node:)?(fs|fs\/promises|child_process|worker_threads)['"]|require\(\s*['"](node:)?(fs|fs\/promises|child_process|worker_threads)['"]\s*\)/, 'critical', 'imports fs, child_process or worker_threads', false],
    [/\b(writeFile|writeFileSync|rename|renameSync|rm|rmSync|unlink|unlinkSync|execFile|execFileSync|execSync|spawn|spawnSync)\s*\(/, 'critical', 'writes files or starts processes', false],
    [/['"`]https?:\/\/[^'"`\s]+['"`]/, 'critical', 'adds or changes an IRI constant', false],
    [/\b(describe|it|test)\.(skip|todo)\b|\{\s*skip\s*:/, 'critical', 'skips a test', true]
];

/**
 * The profile of a change.
 * @param {{ files: { status: string, path: string, from?: string }[], added?: Record<string, string[]>, labels?: string[], off?: boolean }} change
 *   status: A, M, D, R (git --name-status). added: the added lines of each file.
 */
export function classify({ files, added = {}, labels = [], off = false }) {
    const found = [];
    let profile = 'docs';
    const raise = (p, why) => {
        profile = max(profile, p);
        found.push([p, why]);
    };
    const errors = [];
    if (off) raise('platform', 'CI_PROFILES=off');
    if (!files.length) raise('platform', 'no changed files found: run everything');
    for (const f of files) {
        const { profile: p, reason } = pathProfile(f.path);
        raise(p, `${f.path} (${reason})`);
        if (f.status === 'D' && isTest(f.path)) raise('critical', `${f.path} deleted (a test file)`);
        if (f.status === 'R' && /^packages\//.test(f.from ?? f.path)) raise('critical', `${f.from} → ${f.path} (moved in packages/)`);
        if (!isCode(f.path)) continue;
        for (const line of added[f.path] ?? []) {
            if (/\b(describe|it|test)\.only\b/.test(line) && isTest(f.path)) errors.push(`${f.path}: .only in a test`);
            for (const [re, p, why, tests] of TRIPWIRES) {
                if ((tests || !isTest(f.path)) && re.test(line)) raise(p, `${f.path} ${why}`);
            }
        }
    }
    const lines = Object.values(added).reduce((n, a) => n + a.length, 0);
    if (lines > 400 || files.length > 20) raise('standard', `large change (${files.length} files, ${lines} added lines)`);
    for (const l of labels) if (l === 'risk:critical' || l === 'risk:platform') raise(l.slice(5), `label ${l}`);
    return { profile, reasons: [...new Set(found.filter(([p]) => p === profile).map(([, why]) => why))], errors };
}

/** Unit tests of a `standard` change: `full`, or the source files for `vitest related` and the test files to run. */
export function testSelection(files) {
    const paths = files.filter(f => f.status !== 'D').map(f => f.path);
    const full = paths.find(p => /^packages\/model\/src\//.test(p) || /^packages\/[^/]+\/test\/(helpers|project-full|project-reference|doc-reference|view-part-reference)\.ts$/.test(p));
    if (full) return { mode: 'full', reason: `${full}: every layer depends on it` };
    const related = paths.filter(p => /^(packages\/[^/]+|modeler)\/src\/.*\.(ts|tsx)$/.test(p));
    const tests = paths.filter(p => /^(packages\/[^/]+\/test|modeler\/test)\/.*\.test\.ts$/.test(p));
    if (paths.some(p => /^examples\//.test(p))) tests.push('packages/rdf/test/workspace-files.test.ts', 'packages/rdf/test/workspace.test.ts');
    return { mode: related.length || tests.length ? 'affected' : 'none', related, tests: [...new Set(tests)] };
}

/**
 * The CI plan: for each job '' (skip), 'required' (the gate needs it) or 'optional' (runs, reports, does not block the merge; blocks
 * the release because the run on main makes it required).
 * mode: pr, main (after the merge), nightly.
 */
export function plan({ profile, files, mode = 'pr', labels = [], pr = 0, shadowEvery = 1 }) {
    const paths = files.map(f => f.path);
    const touches = res => paths.some(p => any(res, p));
    const at = p => rank(profile) >= rank(p);
    const job = (when, level = 'required') => (when ? level : '');
    const tests = profile === 'standard' ? testSelection(files) : { mode: at('critical') ? 'full' : 'none' };
    let p = {
        fast: job(at('cosmetic')),
        check: at('standard'),
        affected: job(tests.mode === 'affected'),
        unit: job(tests.mode === 'full'),
        build: job(at('standard')),
        electron: profile === 'platform',
        cli: job(at('critical')),
        e2e: job(at('critical') || (profile === 'standard' && touches(BROWSER)), 'optional'),
        windows_unit: job(at('critical') && touches(WINDOWS), 'optional'),
        packages: job(profile === 'platform' && touches(PACKAGING)),
        release_dry: job(profile === 'platform' && touches(RELEASE), 'optional'),
        shadow: job(mode === 'pr' && !at('critical') && tests.mode !== 'full' && pr > 0 && pr % Math.max(1, shadowEvery) === 0, 'optional')
    };
    if (mode !== 'pr') {
        // After the merge: the full set, everything required. The nightly run adds Windows and the packages.
        p = { ...p, fast: 'required', check: true, affected: '', unit: 'required', build: 'required', electron: true, cli: 'required',
            e2e: 'required', windows_unit: mode === 'nightly' || p.windows_unit ? 'required' : '',
            packages: mode === 'nightly' || p.packages ? 'required' : '', release_dry: '', shadow: '' };
    }
    return { ...p, hold: mode === 'pr' && labels.includes('risk:hold'), tests };
}

/** The jobs of .github/workflows/ci.yml for each plan entry. `affected` runs in the fast job, `cli` and `electron` in the build job. */
export const JOBS = { fast: 'fast', unit: 'unit', build: 'build', e2e: 'e2e', windows_unit: 'windows-unit', packages: 'packages', release_dry: 'release-dry', shadow: 'shadow' };

/**
 * The merge gate: classify passed, each required job passed, and with risk:hold each optional job passed too. Shadow runs never
 * block. A required job that was skipped or cancelled fails the gate.
 * @param plan the classify outputs (strings). @param results { job: 'success' | 'failure' | 'cancelled' | 'skipped' }.
 */
export function gate(plan, results) {
    const failed = [], notes = [];
    if (results.classify !== 'success') failed.push(`classify: ${results.classify}`);
    for (const [key, job] of Object.entries(JOBS)) {
        const level = plan[key] ?? '';
        const result = results[job] ?? 'skipped';
        if (!level || result === 'success') continue;
        const blocking = level === 'required' || (level === 'optional' && plan.hold === 'true' && key !== 'shadow');
        (blocking ? failed : notes).push(`${job} (${level}): ${result}`);
    }
    return { ok: !failed.length, failed, notes };
}

// --- Command line -------------------------------------------------------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function changes(base, head = 'HEAD') {
    const files = git('diff', '--name-status', '-M', base, head).trim().split('\n').filter(Boolean).map(line => {
        const [status, a, b] = line.split('\t');
        return status.startsWith('R') ? { status: 'R', from: a, path: b } : { status: status[0], path: a };
    });
    const added = {};
    let current;
    for (const line of git('diff', '-U0', '--no-color', base, head).split('\n')) {
        if (line.startsWith('+++ ')) current = line.slice(4).replace(/^b\//, '');
        else if (line.startsWith('+') && current && current !== '/dev/null') (added[current] ??= []).push(line.slice(1));
    }
    return { files, added };
}

function defaultBase() {
    for (const ref of ['origin/main', 'main']) {
        try { return git('merge-base', ref, 'HEAD').trim(); } catch { /* next */ }
    }
    return 'HEAD^';
}

function runTests(selection) {
    const vitest = args => spawnSync('pnpm', ['-s', 'vitest', 'run', ...args], { cwd: root, stdio: 'inherit' }).status ?? 1;
    console.log(`unit tests: ${JSON.stringify(selection)}`);
    if (selection.mode === 'none') return 0;
    if (selection.mode === 'full') return vitest([]);
    let status = 0;
    if (selection.related.length) {
        // `vitest related` runs the tests that import the changed files. No test for a changed source file is not safe: run all.
        const report = join(mkdtempSync(join(tmpdir(), 'catenary-related-')), 'report.json');
        status = spawnSync('pnpm', ['-s', 'vitest', 'related', '--run', '--passWithNoTests', '--reporter=default', '--reporter=json',
            `--outputFile.json=${report}`, ...selection.related], { cwd: root, stdio: 'inherit' }).status ?? 1;
        let suites = 0;
        try { suites = JSON.parse(readFileSync(report, 'utf8')).numTotalTestSuites; } catch { /* no report: fall back */ }
        if (status === 0 && !suites) {
            console.log('vitest related found no test for the changed source files: running the full suite');
            return vitest([]);
        }
    }
    if (selection.tests.length) status ||= vitest(selection.tests);
    return status;
}

function main() {
    const argv = process.argv.slice(2);
    const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
    const base = opt('base') || process.env.BASE_SHA || defaultBase();
    let change;
    try { change = changes(base, opt('head') || 'HEAD'); } catch (e) {
        console.error(`git diff ${base}: ${e.message.split('\n')[0]}`);
        change = { files: [], added: {} };
    }
    if (argv.includes('--gate')) {
        // In the gate job: PLAN = toJSON(needs.classify.outputs), RESULTS = toJSON(needs).
        const results = Object.fromEntries(Object.entries(JSON.parse(process.env.RESULTS || '{}')).map(([k, v]) => [k, v.result]));
        const g = gate(JSON.parse(process.env.PLAN || '{}'), results);
        for (const n of g.notes) console.log(`not blocking: ${n}. It blocks the release when it fails after the merge.`);
        for (const f of g.failed) console.log(`BLOCKING: ${f}`);
        console.log(g.ok ? 'gate: passed' : 'gate: failed');
        process.exit(g.ok ? 0 : 1);
    }
    if (argv.includes('--run-tests')) {
        process.exit(runTests(testSelection(change.files)));
    }
    const mode = opt('mode') || 'pr';
    const labels = (opt('labels') ?? process.env.PR_LABELS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const pr = Number(opt('pr') ?? process.env.PR_NUMBER ?? 0);
    const result = classify({ ...change, labels, off: process.env.CI_PROFILES === 'off' });
    const p = plan({ profile: result.profile, files: change.files, mode, labels, pr, shadowEvery: Number(process.env.CI_SHADOW_EVERY || 1) });
    const out = { base, mode, profile: result.profile, reasons: result.reasons, errors: result.errors, files: change.files.length, plan: p };
    console.log(JSON.stringify(out, null, 2));
    if (process.env.GITHUB_OUTPUT) {
        const lines = { profile: result.profile, reason: result.reasons[0] ?? '', base, ...Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'tests')) };
        appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(lines).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}\n`).join(''));
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
        const rows = Object.entries(p).filter(([k]) => k !== 'tests').map(([k, v]) => `| ${k} | ${v === true ? 'yes' : v === false ? 'no' : v || '–'} |`);
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`## Risk profile: \`${result.profile}\` (${mode})`, '',
            ...result.reasons.slice(0, 20).map(r => `- ${r}`), ...result.errors.map(e => `- **error:** ${e}`), '',
            `Unit tests: \`${JSON.stringify(p.tests)}\``, '', '| Job | Plan |', '|---|---|', ...rows, ''].join('\n'));
    }
    if (result.errors.length) {
        console.error(result.errors.join('\n'));
        process.exit(1);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
