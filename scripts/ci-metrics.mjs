#!/usr/bin/env node
// Numbers of the risk-based CI (.github/workflows/ci.yml) from the GitHub API, as Markdown. The nightly CI run writes them to its job
// summary. Needs the gh CLI with a token (GH_TOKEN, or gh auth login).
// Usage: node scripts/ci-metrics.mjs [--days 14] [--repo owner/name]
//  - time to green per profile: PR head push → the gate job passed (p50, p90), from the risk-profile status of the PR commit
//  - runner minutes per workflow run, by profile (Windows ×2 and macOS ×10, the GitHub multipliers)
//  - duplicate runs: automatic runs of one workflow on one commit (push and pull_request, branch and tag)
//  - flaky runs: runs that passed on a second attempt; release lead time: tag commit → published release
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const days = Number(opt('days', 14));
const repo = opt('repo', process.env.GITHUB_REPOSITORY) ?? execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { encoding: 'utf8' }).trim();
const since = new Date(Date.now() - days * 864e5).toISOString();
const api = path => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
const pages = (path, key) => api(path).flatMap(p => (key ? p[key] : p));
const minutes = ms => (ms / 60000).toFixed(1);
const pct = (a, q) => { if (!a.length) return '–'; const s = [...a].sort((x, y) => x - y); return minutes(s[Math.min(s.length - 1, Math.floor(q * s.length))]); };
const weight = labels => (labels.some(l => /windows/i.test(l)) ? 2 : labels.some(l => /macos/i.test(l)) ? 10 : 1);

const runs = pages(`repos/${repo}/actions/runs?created=>=${since.slice(0, 10)}&per_page=100`, 'workflow_runs').filter(r => r.status === 'completed');
const profileCache = new Map();
function profileOf(sha) {
    if (!profileCache.has(sha)) {
        let p = '';
        try { p = (pages(`repos/${repo}/commits/${sha}/statuses?per_page=100`).find(s => s.context === 'risk-profile')?.description ?? '').split(':')[0]; } catch { /* none */ }
        profileCache.set(sha, p || 'none');
    }
    return profileCache.get(sha);
}

// Time to green and runner minutes of each PR run of CI.
const byProfile = new Map();
const row = p => byProfile.get(p) ?? byProfile.set(p, { runs: 0, green: [], minutes: 0 }).get(p);
let totalMinutes = 0;
for (const run of runs) {
    const jobs = pages(`repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, 'jobs');
    const used = jobs.reduce((n, j) => n + (j.started_at && j.completed_at ? (Date.parse(j.completed_at) - Date.parse(j.started_at)) * weight(j.labels ?? []) : 0), 0);
    totalMinutes += used;
    if (run.name !== 'CI' || run.event !== 'pull_request') continue;
    const r = row(profileOf(run.head_sha));
    r.runs++;
    r.minutes += used;
    const start = Date.parse(run.run_started_at ?? run.created_at);
    const gate = jobs.find(j => j.name === 'gate');
    // Runs before the gate job existed (the baseline): the whole run had to pass.
    if (gate?.conclusion === 'success') r.green.push(Date.parse(gate.completed_at) - start);
    else if (!gate && run.conclusion === 'success') r.green.push(Date.parse(run.updated_at) - start);
}

const dup = new Map();
for (const r of runs.filter(r => r.event !== 'workflow_dispatch' && r.event !== 'schedule')) {
    const key = `${r.name} ${r.head_sha}`;
    dup.set(key, (dup.get(key) ?? 0) + 1);
}
const duplicates = [...dup.values()].filter(n => n > 1).reduce((n, c) => n + c - 1, 0);
const flaky = runs.filter(r => r.run_attempt > 1 && r.conclusion === 'success').length;

const releases = pages(`repos/${repo}/releases?per_page=100`).filter(r => r.published_at && Date.parse(r.published_at) >= Date.parse(since));
const lead = releases.map(r => {
    try {
        const commit = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/commits/${r.tag_name}`], { encoding: 'utf8' }));
        return `${r.tag_name}: ${minutes(Date.parse(r.published_at) - Date.parse(commit.commit.committer.date))} min`;
    } catch { return `${r.tag_name}: ?`; }
});

const out = [`## CI metrics, last ${days} days (${repo})`, '',
    '| Profile | PR runs | Time to green p50 (min) | p90 (min) | Runner min per run |', '|---|---|---|---|---|'];
for (const p of ['docs', 'cosmetic', 'standard', 'critical', 'platform', 'none']) {
    const r = byProfile.get(p);
    if (!r) continue;
    out.push(`| ${p} | ${r.runs} | ${pct(r.green, 0.5)} | ${pct(r.green, 0.9)} | ${minutes(r.minutes / r.runs)} |`);
}
out.push('', `- Workflow runs: ${runs.length}, runner minutes (weighted): ${minutes(totalMinutes)}`,
    `- Duplicate runs (one workflow, one commit; push, PR or tag): ${duplicates}`,
    `- Flaky runs (passed on a later attempt): ${flaky}`,
    `- Release lead time (tag commit → published): ${lead.join(', ') || 'no release'}`,
    '', 'Targets: docs p50 < 1 min, cosmetic p50 < 2 min, standard and critical p50 < 3.5 min, platform p50 < 5 min; 0 duplicate runs.');
console.log(out.join('\n'));
