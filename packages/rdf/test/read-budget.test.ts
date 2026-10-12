// The read budget of the backend thread (spec/manifest.hs §11.3 readBudgetMs): on a generated workspace with a view of 600 cards,
// each panel read of 600 elements (the MODEL_QUERIES that take elements) and each step of a content change with an open canvas (the
// edit with its snapshot, the merge of the DataPatch, the hidden neighbor counts, the figures, the applicability) is one tracer span
// that ends within the budget. The spans measure the backend thread; the wall clock of the test does not count. The fixture is
// generated here: no copy of user data.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Doc, MODEL_QUERIES, NS, ShapesModel, TraceSpan, iriId } from '@catenary/model';
import { ModelGraph } from '../src/graph';
import { ModelStore } from '../src/model-store';
import { hiddenNeighborCounts, readWarnings } from '../src/scoped-doc';
import { shapeTargetMatches } from '../src/shacl-targets';
import { tracer } from '../src/trace';
import { WORKSPACE } from './helpers';

/** spec/manifest.hs §11.3 readBudgetMs, on a developer machine. A CI runner is slower (vitest.config.mts): there the limits are three times larger. */
const SLOWER = process.env.CI ? 3 : 1;
const READ_BUDGET_MS = 50 * SLOWER;
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
/** The steps of a content change that 1hma brought within the budget: each one is held to it, also inside a span of OVER_BUDGET. */
const CHANGE_STEPS = ['dataset warnings', 'instance file origins', 'data patch', 'hidden neighbors', 'figures', 'applicability'];

const B = 'urn:b:', VIEW = 'urn:name:Budget', SMALL = 'urn:name:Small';
const PEOPLE = 1200, TEAMS = 300, PROJECTS = 300;
const person = (i: number) => `${B}person${String(i).padStart(4, '0')}`;
const team = (i: number) => `${B}team${String(i).padStart(4, '0')}`;
const project = (i: number) => `${B}project${String(i).padStart(4, '0')}`;
// The cards of the big view: 400 people, 100 teams, 100 projects.
const CARDS = [...[...Array(400).keys()].map(person), ...[...Array(100).keys()].map(team), ...[...Array(100).keys()].map(project)];

const SHAPES = `@prefix sh: <${NS.sh}> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<${B}PersonShape> a sh:NodeShape ; sh:targetClass <${B}Person> ; sh:name "Person" ;
  sh:property <${B}PersonShape-name>, <${B}PersonShape-memberOf>, <${B}PersonShape-knows> .
<${B}PersonShape-name> sh:path <${NS.rdfs}label> ; sh:datatype xsd:string ; sh:minCount 1 .
<${B}PersonShape-memberOf> sh:path <${B}memberOf> ; sh:class <${B}Team> ; sh:node <${B}TeamShape> .
<${B}PersonShape-knows> sh:path <${B}knows> ; sh:class <${B}Person> .
<${B}TeamShape> a sh:NodeShape ; sh:name "Team" ; sh:property <${B}TeamShape-worksOn> .
<${B}TeamShape-worksOn> sh:path <${B}worksOn> ; sh:class <${B}Project> ; sh:node <${B}ProjectShape> .
<${B}ProjectShape> a sh:NodeShape ; sh:name "Project" ; sh:property <${B}ProjectShape-name> .
<${B}ProjectShape-name> sh:path <${NS.rdfs}label> ; sh:minCount 1 .
`;
// Teams and projects have no class target: they are checked through sh:node from the people (a walk of two steps).
const DATA = [
    ...[...Array(PEOPLE).keys()].map(i => `<${person(i)}> a <${B}Person> ; <${NS.rdfs}label> "Person ${i}" ; <${B}memberOf> <${team(i % TEAMS)}>${i + 1 < PEOPLE ? ` ; <${B}knows> <${person(i + 1)}>` : ''} .`),
    ...[...Array(TEAMS).keys()].map(i => `<${team(i)}> a <${B}Team> ; <${NS.rdfs}label> "Team ${i}" ; <${B}worksOn> <${project(i % PROJECTS)}> .`),
    ...[...Array(PROJECTS).keys()].map(i => `<${project(i)}> a <${B}Project> ; <${NS.rdfs}label> "Project ${i}" .`),
    `<${B}untyped> <${B}note> "kept in the file" .`,
    // A placed card with two labels: a subject warning, and a warning of the view read.
    `<${person(11)}> <${NS.rdfs}label> "Alias 11" .`
].join('\n');
const placement = (view: string, i: number) => `${view}/p/${String(i).padStart(4, '0')}`;
const viewFile = (view: string, label: string, cards: string[], edges: [string, string, string][]) => `<${view}> {
  <${view}> a <${NS.view}View> ; <${NS.rdfs}label> "${label}" .
${cards.map((c, i) => `  <${placement(view, i)}> a <${NS.view}Placement> ; <${NS.view}element> <${c}> ; <${NS.view}x> ${(i % 30) * 700} ; <${NS.view}y> ${Math.floor(i / 30) * 400} ; <${NS.view}view> <${view}> .`).join('\n')}
${edges.map(([s, p, o], i) => `  <${view}/e/${i}> a <${NS.view}Placement> ; <${NS.rdf}reifies> <<( <${s}> <${p}> <${o}> )>> ; <${NS.view}view> <${view}> .`).join('\n')}
}
`;
// 60 placed relations: person i is a member of team i (i < 100).
const EDGES = [...Array(60).keys()].map(i => [person(i), `${B}memberOf`, team(i)] as [string, string, string]);

let dir: string, store: ModelStore;
const view = iriId(VIEW);
const ids = CARDS.map((_, i) => iriId(placement(VIEW, i)));
const elements = CARDS.map(iriId);

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'catenary-read-budget-'));
    writeFileSync(join(dir, 'workspace.trig'), WORKSPACE);
    writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
    writeFileSync(join(dir, 'data.ttl'), DATA);
    mkdirSync(join(dir, 'views'));
    writeFileSync(join(dir, 'views', 'budget.view.trig'), viewFile(VIEW, 'Budget', CARDS, EDGES));
    writeFileSync(join(dir, 'views', 'small.view.trig'), viewFile(SMALL, 'Small', CARDS.slice(0, 10), []));
    store = new ModelStore();
    store.watching = false;
    expect(await store.open(join(dir, 'workspace.trig'))).toEqual({ ok: true });
    await store.validate();
}, 60_000);
afterAll(async () => {
    while (tracer.on) tracer.setClient(false);
    await store.idle();
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

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

/** Runs of each measured step: the budget holds for the fastest run, so the load of other test files does not count. */
const RUNS = 3;

/**
 * The measured spans of one run: the top spans of kind `kinds` (a child span is inside its parent), and the spans of CHANGE_STEPS at
 * any depth. Key: kind/name. Value: the time and its largest child spans (what to look at first).
 */
function measured(spans: TraceSpan[], kinds: string[]): Map<string, { ms: number; children: string }> {
    const ids = new Set(spans.map(s => s.id));
    const children = (s: TraceSpan): string => spans.filter(c => c.parent === s.id).sort((a, b) => b.ms - a.ms).slice(0, 3)
        .map(c => `${c.kind}/${c.name.slice(0, 30)} ${Math.round(c.ms)} ms`).join(', ');
    const out = new Map<string, { ms: number; children: string }>();
    for (const s of spans) {
        if (!(kinds.includes(s.kind) && (s.parent === undefined || !ids.has(s.parent))) && !CHANGE_STEPS.includes(s.name)) continue;
        const k = `${s.kind}/${s.name}`, was = out.get(k);
        // A step that runs more than once in a run (two canvases, two snapshots) counts with its slowest span.
        if (!was || s.ms > was.ms) out.set(k, { ms: s.ms, children: children(s) });
    }
    return out;
}

/** The spans above the budget (or the ceiling of OVER_BUDGET for a top span), by their fastest run. */
function overBudget(runs: Map<string, { ms: number; children: string }>[]): string[] {
    const best = new Map<string, { ms: number; children: string }>();
    for (const run of runs) for (const [k, v] of run) if (!best.has(k) || v.ms < best.get(k)!.ms) best.set(k, v);
    return [...best].filter(([k, v]) => {
        const name = k.slice(k.indexOf('/') + 1);
        return v.ms > (CHANGE_STEPS.includes(name) ? READ_BUDGET_MS : (OVER_BUDGET[name]?.ceilingMs ?? 50) * SLOWER);
    }).map(([k, v]) => `${k} ${Math.round(v.ms)} ms (${v.children})`);
}

/** The arguments of each MODEL_QUERIES read that takes elements, for the 600 cards of the view. */
const READS: Partial<Record<keyof typeof MODEL_QUERIES, () => unknown>> = {
    copyAsRdf: () => store.reads.copyAsRdf(view, ids),
    outline: () => store.reads.outline(view, { view, ids }),
    appearance: () => store.reads.appearance(view, ids),
    occurrence: () => store.reads.occurrence(ids, view),
    links: () => store.reads.links(ids, view),
    selectionActions: () => store.reads.selectionActions({ view, ids, activeView: view }),
    selected: () => store.reads.selected({ view, ids }),
    view: () => store.reads.view(view, ids),
    deletePlan: () => store.reads.deletePlan(elements),
    elementRows: () => store.reads.elementRows(ids, view),
    unplaced: () => store.reads.unplaced(elements)
};

describe('the read budget of the backend thread on a view of 600 cards (§11.3 readBudgetMs)', () => {
    it('lists each MODEL_QUERIES read that takes element ids', () => {
        // explorerDrag takes the rows of the Model explorer, relationChoices two instances: not the elements of a view.
        const withIds = Object.entries(MODEL_QUERIES).filter(([k, ps]) => ps.some(p => p === 'ids' || p === 'selection' || p === 'target')
            && k !== 'explorerDrag' && k !== 'relationChoices').map(([k]) => k);
        expect(Object.keys(READS).sort()).toEqual(withIds.sort());
    });

    for (const [name, read] of Object.entries(READS)) {
        it(`${name} of 600 elements: one span within the budget`, async () => {
            // The first read of the store after the open (the shapes index, the request context) is not part of the read.
            read();
            const runs = [];
            for (let i = 0; i < RUNS; i++) runs.push(measured(await spansOf(() => tracer.span('rpc', name, read)), ['rpc']));
            expect(runs.every(r => r.has(`rpc/${name}`))).toBe(true);
            expect(overBudget(runs).join('; ')).toBe('');
        }, 60_000);
    }

    it('a rename of one card with the canvas open: the edit, the snapshot and each refresh read within the budget; the kept reads equal fresh ones', async () => {
        const card = elements[5];
        // The canvas: the kept part of its view and its reads, as ViewState and ViewGModelFactory hold them (view-session.ts).
        const part: Doc = store.viewDoc(view);
        const reads = () => {
            const v = part.views[view];
            return {
                neighbors: tracer.span('refresh', 'hidden neighbors', () => store.hiddenNeighborCounts(v)),
                // ModelStore.viewFigures has its own span (refresh/figures).
                figures: store.viewFigures(view)!.derivation.figures.length,
                applicability: tracer.span('refresh', 'applicability', () => store.viewApplicability(v))
            };
        };
        reads();
        // The window has the snapshot of the open (model-service.ts sends one at each change).
        store.snapshot();
        const listener = store.onDidChange(e => {
            // The RPC service sends a snapshot to each window; the canvas merges a DataPatch into its kept part.
            tracer.span('snapshot', 'to client', () => store.snapshot());
            if (e.reason === 'edit') expect(tracer.span('refresh', 'data patch', () => store.mergeChanged(part, view, e.scope!.elements))).toBe(true);
        });
        try {
            const runs = [];
            for (let i = 1; i <= RUNS; i++) {
                const label = `Renamed ${i}`;
                let after!: ReturnType<typeof reads>;
                runs.push(measured(await spansOf(() => {
                    expect(tracer.span('rpc', 'execute', () => store.execute({ kind: 'rename', id: card, label })).ok).toBe(true);
                    after = reads();
                }), ['rpc', 'refresh']));
                expect(part.instances[card].label).toBe(label);
                // law_keptReadsEqualRead: the kept reads equal a fresh read of the store.
                expect(after.neighbors).toEqual(freshNeighbors());
                expect(store.snapshot().warnings).toEqual([...store.warnings, ...freshWarnings()]);
            }
            expect(runs.every(r => CHANGE_STEPS.every(step => [...r.keys()].some(k => k.endsWith(`/${step}`))))).toBe(true);
            expect(overBudget(runs).join('; ')).toBe('');
        } finally {
            listener.dispose();
        }
    }, 60_000);
});

describe('kept reads after data patches equal the reads of a new store (§11.3 law_keptReadsEqualRead)', () => {
    it('target matches, hidden neighbor counts, applicability, figures and dataset warnings after each edit, undo and redo', async () => {
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
        const g = () => inner().graph;
        const reads = (s: ModelStore, graph: ModelGraph) => {
            const v = s.viewDoc(view).views[view];
            const nodes = CARDS.map(iriTerm);
            return {
                targets: shapeTargetMatches(graph, { nodes }),
                neighbors: s.hiddenNeighborCounts(v),
                applicability: s.viewApplicability(v),
                figures: s.viewFigures(view)!.derivation.figures.map(f => [f.id, f.title, f.rows.map(r => r.text)]),
                warnings: s.snapshot().warnings
            };
        };
        reads(store, g());
        for (const step of steps) {
            const r = step();
            expect(r.ok, JSON.stringify(r)).toBe(true);
            const kept = reads(store, g());
            await store.idle();
            const fresh = new ModelStore();
            fresh.watching = false;
            try {
                expect(await fresh.open(join(dir, 'workspace.trig'))).toEqual({ ok: true });
                const read = reads(fresh, (fresh as unknown as { graph: ModelGraph }).graph);
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
    }, 120_000);
});

/** The store as its kept reads see it: the graph and the shapes model. */
const inner = () => store as unknown as { graph: ModelGraph; shapesIndex(): { model: ShapesModel } };

/** The hidden neighbor counts of the view, read from the store without kept reads. */
const freshNeighbors = () => hiddenNeighborCounts(inner().graph, inner().shapesIndex().model, store.viewDoc(view).views[view]);

/** The dataset warnings, read from the store without kept reads. */
const freshWarnings = () => readWarnings(inner().graph, inner().shapesIndex().model);
