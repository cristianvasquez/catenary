// The reads of the read budget (spec/manifest.hs §11.3 readBudgetMs) on a generated workspace with a view of 600 cards: each panel
// read of 600 elements and each step of a content change with an open canvas is one tracer span, and the kept reads equal the reads
// of a new store. This file asserts no elapsed time: `pnpm test:perf` measures these spans against the budget (perf/read-budget.perf.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODEL_QUERIES, ShapesModel, TraceSpan, iriId } from '@catenary/model';
import { ModelGraph } from '../src/graph';
import { ModelStore } from '../src/model-store';
import { hiddenNeighborCounts, readWarnings } from '../src/scoped-doc';
import { shapeTargetMatches } from '../src/shacl-targets';
import { tracer } from '../src/trace';
import {
    B, BUDGET_READS, CARDS, CHANGE_STEPS, Fixture, budgetElements as elements, budgetReads, budgetView as view, openBudgetFixture, openCanvas, person, project, team
} from './scale-fixtures';

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

/** The store as its kept reads see it: the graph and the shapes model. */
const inner = (store: ModelStore) => store as unknown as { graph: ModelGraph; shapesIndex(): { model: ShapesModel } };

describe('the reads of the read budget on a view of 600 cards (§11.3 readBudgetMs)', () => {
    it('lists each MODEL_QUERIES read that takes element ids', () => {
        // explorerDrag takes the rows of the Model explorer, relationChoices two instances: not the elements of a view.
        const withIds = Object.entries(MODEL_QUERIES).filter(([k, ps]) => ps.some(p => p === 'ids' || p === 'selection' || p === 'target')
            && k !== 'explorerDrag' && k !== 'relationChoices').map(([k]) => k);
        expect([...BUDGET_READS].sort()).toEqual(withIds.sort());
    });

    describe('panel reads of 600 elements', () => {
        // One store for the reads of this block: no test of the block edits it.
        let fixture: Fixture;
        beforeAll(async () => { fixture = await openBudgetFixture(); }, 60_000);
        afterAll(() => fixture?.dispose());

        for (const name of BUDGET_READS) {
            it(`${name} of 600 elements: one rpc span`, async () => {
                const read = budgetReads(fixture.store)[name]!;
                const spans = await spansOf(() => tracer.span('rpc', name, read));
                expect(spans.filter(s => s.kind === 'rpc' && s.name === name && s.parent === undefined)).toHaveLength(1);
            }, 60_000);
        }
    });

    it('a rename of one card with the canvas open: each step of the change is a span; the kept reads equal fresh ones', async () => {
        const fixture = await openBudgetFixture();
        const { store } = fixture;
        const card = elements[5];
        const canvas = openCanvas(store);
        // The kept reads without kept state: a fresh read of the store.
        const freshNeighbors = () => hiddenNeighborCounts(inner(store).graph, inner(store).shapesIndex().model, store.viewDoc(view).views[view]);
        const freshWarnings = () => readWarnings(inner(store).graph, inner(store).shapesIndex().model);
        try {
            for (let i = 1; i <= 3; i++) {
                const label = `Renamed ${i}`;
                let after!: ReturnType<typeof canvas.reads>;
                const spans = await spansOf(() => {
                    expect(tracer.span('rpc', 'execute', () => store.execute({ kind: 'rename', id: card, label })).ok).toBe(true);
                    after = canvas.reads();
                });
                expect(spans.some(s => s.kind === 'rpc' && s.name === 'execute')).toBe(true);
                for (const step of CHANGE_STEPS) expect(spans.some(s => s.name === step), step).toBe(true);
                expect(canvas.part.instances[card].label).toBe(label);
                // law_keptReadsEqualRead: the kept reads equal a fresh read of the store.
                expect(after.neighbors).toEqual(freshNeighbors());
                expect(store.snapshot().warnings).toEqual([...store.warnings, ...freshWarnings()]);
            }
        } finally {
            canvas.dispose();
            await fixture.dispose();
        }
    }, 60_000);
});

describe('kept reads after data patches equal the reads of a new store (§11.3 law_keptReadsEqualRead)', () => {
    it('target matches, hidden neighbor counts, applicability, figures and dataset warnings after each edit, undo and redo', async () => {
        const fixture = await openBudgetFixture();
        const { store, dir } = fixture;
        const knows = `${B}knows`, memberOf = `${B}memberOf`, iriTerm = (value: string) => ({ termType: 'NamedNode' as const, value });
        const steps: (() => { ok: boolean })[] = [
            () => store.execute({ kind: 'rename', id: elements[7], label: 'Renamed seven' }),
            // The two labels of a placed card become one: its warning goes (the view is not read again).
            () => store.execute({ kind: 'rename', id: elements[11], label: 'Renamed eleven' }),
            // A statement on a path of sh:node: the walk from person 7 reaches another team and its project.
            () => store.execute({ kind: 'setStatements', id: elements[7], values: { [memberOf]: [iriTerm(team(150))] } }),
            // Team 50 loses its members one by one: with the last one it is no target of TeamShape any more, and project 50 (a card
            // that no changed statement names) loses its only reason, through the walk of two steps.
            ...[50, 350, 650, 950].map(i => () => store.execute({ kind: 'setStatements', id: iriId(person(i)), values: { [memberOf]: [iriTerm(team(150))] } })),
            // A relation to an instance that the view does not show.
            () => store.execute({ kind: 'setStatements', id: elements[9], values: { [knows]: [iriTerm(person(900))] } }),
            () => store.undo(),
            () => store.undo(),
            () => store.redo(),
            // A change of the view graph: a placed card goes.
            () => store.execute({ kind: 'delete', ids: [iriId(project(3))] })
        ];
        const reads = (s: ModelStore) => {
            const v = s.viewDoc(view).views[view];
            const nodes = CARDS.map(iriTerm);
            return {
                targets: shapeTargetMatches(inner(s).graph, { nodes }),
                neighbors: s.hiddenNeighborCounts(v),
                applicability: s.viewApplicability(v),
                figures: s.viewFigures(view)!.derivation.figures.map(f => [f.id, f.title, f.rows.map(r => r.text)]),
                warnings: s.snapshot().warnings
            };
        };
        try {
            reads(store);
            for (const step of steps) {
                const r = step();
                expect(r.ok, JSON.stringify(r)).toBe(true);
                const kept = reads(store);
                await store.idle();
                const fresh = new ModelStore();
                fresh.watching = false;
                try {
                    expect(await fresh.open(`${dir}/workspace.trig`)).toEqual({ ok: true });
                    const read = reads(fresh);
                    expect(kept.targets).toEqual(read.targets);
                    expect(kept.neighbors).toEqual(read.neighbors);
                    expect(kept.applicability).toEqual(read.applicability);
                    expect(kept.figures).toEqual(read.figures);
                    expect(kept.warnings).toEqual(read.warnings);
                } finally {
                    await fresh.idle();
                    fresh.close();
                }
            }
        } finally {
            await fixture.dispose();
        }
    }, 120_000);
});
