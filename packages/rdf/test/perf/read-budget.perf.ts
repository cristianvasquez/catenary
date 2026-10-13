// `pnpm test:perf`: the elapsed time of the read budget (spec/manifest.hs §11.3 readBudgetMs) on the generated view of 600 cards.
// Each panel read of 600 elements and each step of a content change with an open canvas is one tracer span. The p50 of its samples
// must keep the budget, or the ceiling of its OVER_BUDGET entry. Tracer spans use performance.now(): they include the time that the
// thread waits for a CPU. read-budget.test.ts checks the same reads without time.

import { afterAll, beforeAll, describe, it } from 'vitest';
import { TraceSpan } from '@catenary/model';
import { tracer } from '../../src/trace';
import {
    BUDGET_EDGES, BUDGET_READS, CARDS, CHANGE_STEPS, Fixture, PEOPLE, PROJECTS, TEAMS, budgetElements, budgetReads, openBudgetFixture, openCanvas
} from '../scale-fixtures';
import { PerfReport, SAMPLES, WARMUP, spanSamples } from './report';

/** spec/manifest.hs §11.3 readBudgetMs. */
const READ_BUDGET_MS = 50;
/**
 * Spans that still exceed the budget on this fixture, with the open.md row that owns the work and a ceiling that the span must keep
 * (a regression above it fails). Remove an entry when its span meets the budget. The panel reads of 600 elements are linear: the
 * scoped read of 600 placements and the JavaScript of the records (PERF7). The edit computes the snapshot of each window in its span:
 * `snapshot/files` compares the canonical form of the changed files with the saved one. The execute ceiling below is accepted as is (kata 5f5r: will not fix).
 */
const OVER_BUDGET: Record<string, { row: string; ceilingMs: number }> = {
    // 43 to 52 ms: at the budget, over it when other test files load the machine.
    selected: { row: 'PERF7', ceilingMs: 150 },
    links: { row: 'PERF7', ceilingMs: 3000 },
    copyAsRdf: { row: 'PERF7', ceilingMs: 1500 },
    appearance: { row: 'PERF7', ceilingMs: 400 },
    deletePlan: { row: 'PERF7', ceilingMs: 400 },
    elementRows: { row: 'PERF7', ceilingMs: 400 },
    occurrence: { row: 'PERF7', ceilingMs: 400 },
    outline: { row: 'PERF7', ceilingMs: 400 },
    selectionActions: { row: 'PERF7', ceilingMs: 400 },
    unplaced: { row: 'PERF7', ceilingMs: 400 },
    view: { row: 'PERF7', ceilingMs: 400 },
    execute: { row: 'none', ceilingMs: 400 }
};
/** The limit of a span: a step of CHANGE_STEPS keeps the budget, also inside a span of OVER_BUDGET. */
const limit = (name: string): [number, string | undefined] => {
    const o = CHANGE_STEPS.includes(name) ? undefined : OVER_BUDGET[name];
    return o ? [o.ceilingMs, o.row === 'none' ? 'accepted ceiling, kata 5f5r' : `${o.row} ceiling`] : [READ_BUDGET_MS, undefined];
};

/** Run `fn` under the tracer and return the spans that it recorded. */
async function spansOf(fn: () => unknown): Promise<TraceSpan[]> {
    tracer.setClient(true);
    tracer.take();
    try {
        await fn();
        return tracer.take().spans;
    } finally {
        tracer.setClient(false);
    }
}

/** The measured spans of one run: the top spans of kind `kinds`, and the spans of CHANGE_STEPS at any depth. A step that runs more than once in a run counts with its slowest span. */
function measured(spans: TraceSpan[], kinds: string[]): Map<string, number> {
    const ids = new Set(spans.map(s => s.id));
    const out = new Map<string, number>();
    for (const s of spans) {
        if (!(kinds.includes(s.kind) && (s.parent === undefined || !ids.has(s.parent))) && !CHANGE_STEPS.includes(s.name)) continue;
        const k = `${s.kind}/${s.name}`;
        out.set(k, Math.max(out.get(k) ?? 0, s.ms));
    }
    return out;
}

let files: Record<string, number> = {};
const report = new PerfReport('read-budget', {});
afterAll(() => {
    Object.assign(report.fixture, { cards: CARDS.length, placedRelations: BUDGET_EDGES, people: PEOPLE, teams: TEAMS, projects: PROJECTS, fileBytes: files });
    report.write();
});

describe('read budget: panel reads of 600 elements (§11.3 readBudgetMs)', () => {
    let fixture: Fixture;
    beforeAll(async () => {
        fixture = await openBudgetFixture();
        files = fixture.files;
    }, 60_000);
    afterAll(() => fixture?.dispose());

    for (const name of BUDGET_READS) {
        it(`${name} of 600 elements`, async () => {
            const read = budgetReads(fixture.store)[name]!;
            report.check(`rpc/${name}`, await spanSamples(name, read), ...limit(name));
        }, 300_000);
    }
});

describe('read budget: a rename of one card with the canvas open (§11.3 readBudgetMs)', () => {
    it('the edit, the snapshot and each refresh read', async () => {
        const fixture = await openBudgetFixture();
        const canvas = openCanvas(fixture.store);
        const rename = (label: string) => spansOf(() => {
            tracer.span('rpc', 'execute', () => fixture.store.execute({ kind: 'rename', id: budgetElements[5], label }));
            canvas.reads();
        });
        try {
            for (let i = 0; i < WARMUP; i++) await rename(`Warm-up ${i}`);
            const samples = new Map<string, number[]>();
            for (let i = 0; i < SAMPLES; i++) {
                for (const [k, ms] of measured(await rename(`Renamed ${i}`), ['rpc', 'refresh'])) samples.set(k, [...samples.get(k) ?? [], ms]);
            }
            const failures: string[] = [];
            for (const [k, xs] of [...samples].sort(([a], [b]) => a.localeCompare(b))) {
                try {
                    report.check(k, xs, ...limit(k.slice(k.indexOf('/') + 1)));
                } catch (e) {
                    failures.push((e as Error).message);
                }
            }
            if (failures.length) throw new Error(failures.join('\n'));
        } finally {
            canvas.dispose();
            await fixture.dispose();
        }
    }, 300_000);
});
