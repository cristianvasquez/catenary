// Generated scale fixtures of the read tests (spec/manifest.hs §11.3) and of their elapsed-time measurements (test/perf). Each
// open writes a new temporary workspace and opens a new store: a test that edits owns its fixture. No copy of user data.

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { Doc, EXPLORER_PAGE, MODEL_QUERIES, NS, iriId } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { tracer } from '../src/trace';
import { DATA as FIXTURE_DATA, SHAPES as FIXTURE_SHAPES, WORKSPACE, writeWorkspace } from './helpers';

/** A store opened on a new temporary workspace. `dispose` stops the trace, awaits ModelStore.dispose and removes the files. */
export interface Fixture {
    dir: string;
    store: ModelStore;
    /** Relative path → bytes, of each file that the fixture wrote. */
    files: Record<string, number>;
    dispose(): Promise<void>;
}

/** Write `files` (relative path → text) and `workspace.trig` (or the fixture workspace with its views) to a new directory and open a store on it. */
async function openFixture(prefix: string, files: Record<string, string>, opts: { fixtureViews?: boolean; validate?: boolean } = {}): Promise<Fixture> {
    const dir = mkdtempSync(join(tmpdir(), `catenary-${prefix}-`));
    const workspace = opts.fixtureViews ? writeWorkspace(dir) : join(dir, 'workspace.trig');
    if (!opts.fixtureViews) writeFileSync(workspace, WORKSPACE);
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
    }
    const store = new ModelStore();
    store.watching = false;
    expect(await store.open(workspace)).toEqual({ ok: true });
    if (opts.validate) await store.validate();
    return {
        dir, store,
        files: Object.fromEntries(Object.keys(files).map(f => [f, statSync(join(dir, f)).size])),
        async dispose() {
            while (tracer.on) tracer.setClient(false);
            await store.dispose();
            rmSync(dir, { recursive: true, force: true });
        }
    };
}

/** A read under the tracer: its answer, its SPARQL queries and all store reads (queries and matches) of its span. No time. */
export function traced<T>(name: string, read: () => T): { answer: T; sparql: number; reads: number } {
    tracer.setClient(true);
    try {
        tracer.take();
        const answer = tracer.span('rpc', name, read);
        const batch = tracer.take();
        const span = batch.spans.find(s => s.kind === 'rpc' && s.name === name);
        return { answer, sparql: batch.spans.filter(s => s.kind === 'sparql').length, reads: span?.queries ?? 0 };
    } finally {
        tracer.setClient(false);
    }
}

// ---- The budget fixture: a view of 600 cards (read-budget.test.ts, perf/read-budget.perf.ts) ----

export const B = 'urn:b:';
export const BUDGET_VIEW = 'urn:name:Budget';
const SMALL = 'urn:name:Small';
export const PEOPLE = 1200, TEAMS = 300, PROJECTS = 300;
export const person = (i: number) => `${B}person${String(i).padStart(4, '0')}`;
export const team = (i: number) => `${B}team${String(i).padStart(4, '0')}`;
export const project = (i: number) => `${B}project${String(i).padStart(4, '0')}`;
/** The cards of the big view: 400 people, 100 teams, 100 projects. */
export const CARDS = [...[...Array(400).keys()].map(person), ...[...Array(100).keys()].map(team), ...[...Array(100).keys()].map(project)];
/** The placed relations of the big view: person i is a member of team i (i < 60). */
export const BUDGET_EDGES = 60;

const BUDGET_SHAPES = `@prefix sh: <${NS.sh}> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
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
const BUDGET_DATA = [
    ...[...Array(PEOPLE).keys()].map(i => `<${person(i)}> a <${B}Person> ; <${NS.rdfs}label> "Person ${i}" ; <${B}memberOf> <${team(i % TEAMS)}>${i + 1 < PEOPLE ? ` ; <${B}knows> <${person(i + 1)}>` : ''} .`),
    ...[...Array(TEAMS).keys()].map(i => `<${team(i)}> a <${B}Team> ; <${NS.rdfs}label> "Team ${i}" ; <${B}worksOn> <${project(i % PROJECTS)}> .`),
    ...[...Array(PROJECTS).keys()].map(i => `<${project(i)}> a <${B}Project> ; <${NS.rdfs}label> "Project ${i}" .`),
    `<${B}untyped> <${B}note> "kept in the file" .`,
    // A placed card with two labels: a subject warning, and a warning of the view read.
    `<${person(11)}> <${NS.rdfs}label> "Alias 11" .`
].join('\n');
const budgetPlacement = (view: string, i: number) => `${view}/p/${String(i).padStart(4, '0')}`;
const budgetViewFile = (view: string, label: string, cards: string[], edges: [string, string, string][]) => `<${view}> {
  <${view}> a <${NS.view}View> ; <${NS.rdfs}label> "${label}" .
${cards.map((c, i) => `  <${budgetPlacement(view, i)}> a <${NS.view}Placement> ; <${NS.view}element> <${c}> ; <${NS.view}x> ${(i % 30) * 700} ; <${NS.view}y> ${Math.floor(i / 30) * 400} ; <${NS.view}view> <${view}> .`).join('\n')}
${edges.map(([s, p, o], i) => `  <${view}/e/${i}> a <${NS.view}Placement> ; <${NS.rdf}reifies> <<( <${s}> <${p}> <${o}> )>> ; <${NS.view}view> <${view}> .`).join('\n')}
}
`;
const BUDGET_EDGE_LIST = [...Array(BUDGET_EDGES).keys()].map(i => [person(i), `${B}memberOf`, team(i)] as [string, string, string]);

/** The view id, the placement ids and the element ids of the 600 cards. */
export const budgetView = iriId(BUDGET_VIEW);
export const budgetIds = CARDS.map((_, i) => iriId(budgetPlacement(BUDGET_VIEW, i)));
export const budgetElements = CARDS.map(iriId);

/** A new workspace with the view of 600 cards and a small view of 10, opened and validated. */
export const openBudgetFixture = (): Promise<Fixture> => openFixture('read-budget', {
    'shapes.ttl': BUDGET_SHAPES,
    'data.ttl': BUDGET_DATA,
    'views/budget.view.trig': budgetViewFile(BUDGET_VIEW, 'Budget', CARDS, BUDGET_EDGE_LIST),
    'views/small.view.trig': budgetViewFile(SMALL, 'Small', CARDS.slice(0, 10), [])
}, { validate: true });

/** The arguments of each MODEL_QUERIES read that takes elements, for the 600 cards of the view. */
export function budgetReads(store: ModelStore): Partial<Record<keyof typeof MODEL_QUERIES, () => unknown>> {
    const view = budgetView, ids = budgetIds, elements = budgetElements;
    return {
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
}

/** The names of the reads of budgetReads. */
export const BUDGET_READS = Object.keys(budgetReads({} as ModelStore)) as (keyof typeof MODEL_QUERIES)[];

/** The steps of a content change that 1hma brought within the budget (span names, at any depth of the trace). */
export const CHANGE_STEPS = ['dataset warnings', 'instance file origins', 'data patch', 'hidden neighbors', 'figures', 'applicability'];

/** The canvas of the big view: its kept part and its refresh reads, as ViewState and ViewGModelFactory hold them (view-session.ts). */
export interface Canvas {
    part: Doc;
    /** The refresh reads of the canvas, each in its tracer span. */
    reads(): { neighbors: unknown; figures: number; applicability: unknown };
    dispose(): void;
}

/** Open the canvas of the big view: it reads once, and at each change it sends a snapshot and merges the DataPatch into its part. */
export function openCanvas(store: ModelStore): Canvas {
    const view = budgetView;
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
    return { part, reads, dispose: () => listener.dispose() };
}

// ---- The selection fixture: 300 placed instances (selection-scale.test.ts, perf/selection-scale.perf.ts) ----

export const SELECTION_N = 300, SELECTION_EDGES = 10;
export const THING = 'urn:x:Thing', LOOSE = 'urn:x:Loose', KNOWS = 'urn:x:knows';
const SELECTION_VIEW = 'urn:name:Big';
export const instance = (i: number) => `urn:x:i${String(i).padStart(4, '0')}`;
const selectionPlacement = (i: number) => `${SELECTION_VIEW}/p/${String(i).padStart(4, '0')}`;
export const selectionEdge = (i: number) => `${SELECTION_VIEW}/e/${String(i).padStart(4, '0')}`;

const SELECTION_SHAPES = `@prefix sh: <${NS.sh}> .
<urn:x:ThingShape> a sh:NodeShape ; sh:targetClass <${THING}> ; sh:name "Thing" ;
  sh:property [ sh:path <${NS.rdfs}label> ; sh:datatype <http://www.w3.org/2001/XMLSchema#string> ] ;
  sh:property [ sh:path <${KNOWS}> ; sh:class <${THING}> ] .
`;
// Even instances: Thing (a node shape targets it). Odd instances: Loose (no node shape). Each instance knows the next one.
const SELECTION_DATA = [...Array(SELECTION_N).keys()].map(i => `<${instance(i)}> a <${i % 2 ? LOOSE : THING}> ; <${NS.rdfs}label> "Item ${i}" ${i + 1 < SELECTION_N ? `; <${KNOWS}> <${instance(i + 1)}>` : ''} .`).join('\n');
// A card per instance, and an edge for the first SELECTION_EDGES relations: the other relations are hidden.
const SELECTION_VIEW_FILE = `<${SELECTION_VIEW}> {
  <${SELECTION_VIEW}> a <${NS.view}View> ; <${NS.rdfs}label> "Big" .
${[...Array(SELECTION_N).keys()].map(i => `  <${selectionPlacement(i)}> a <${NS.view}Placement> ; <${NS.view}element> <${instance(i)}> ; <${NS.view}x> ${(i % 20) * 200} ; <${NS.view}y> ${Math.floor(i / 20) * 100} ; <${NS.view}view> <${SELECTION_VIEW}> .`).join('\n')}
${[...Array(SELECTION_EDGES).keys()].map(i => `  <${selectionEdge(i)}> a <${NS.view}Placement> ; <${NS.rdf}reifies> <<( <${instance(i)}> <${KNOWS}> <${instance(i + 1)}> )>> ; <${NS.view}view> <${SELECTION_VIEW}> .`).join('\n')}
}
`;

export const selectionView = iriId(SELECTION_VIEW);
export const selectionIds = [...Array(SELECTION_N).keys()].map(i => iriId(selectionPlacement(i)));
export const selectionElements = [...Array(SELECTION_N).keys()].map(i => iriId(instance(i)));

/** A new workspace with a view of 300 placed instances. */
export const openSelectionFixture = (): Promise<Fixture> => openFixture('selection-scale', {
    'shapes.ttl': SELECTION_SHAPES,
    'data.ttl': SELECTION_DATA,
    'views/big.view.trig': SELECTION_VIEW_FILE
});

// ---- The explorer fixture: the fixture workspace and extra files, one with 600 subjects (explorer.test.ts, perf/explorer.perf.ts) ----

export const EXPLORER_BIG = 600;
export const AGENT = 'http://www.w3.org/ns/prov#Agent';
const MORE = `@prefix rdfs: <${NS.rdfs}> .
<urn:x:Robot> rdfs:subClassOf <${AGENT}> .
<urn:x:untyped> rdfs:label "Untyped" .
<urn:x:task> a <osg://vocab/data-product-draft#Task> ; rdfs:label "Task without action" .
<urn:x:two> a <${AGENT}>, <urn:x:Robot> ; rdfs:label "Two types" .
<urn:x:A> rdfs:subClassOf <urn:x:B> . <urn:x:B> rdfs:subClassOf <urn:x:A> .
<urn:x:a> a <urn:x:A> ; rdfs:label "In a cycle" .
${Array.from({ length: EXPLORER_PAGE + 5 }, (_, i) => `<urn:x:m${i}> a <urn:x:Many> .`).join('\n')}
`;

/** A new workspace: the fixture workspace with its views and data, and the files of the Model explorer tests. */
export const openExplorerFixture = (): Promise<Fixture> => openFixture('explorer', {
    'shapes.ttl': FIXTURE_SHAPES,
    'data.ttl': FIXTURE_DATA,
    'more.ttl': MORE,
    'owner.ttl': `@prefix sh: <${NS.sh}> . <urn:x:S> a sh:NodeShape ; sh:property <urn:x:P> .`,
    'property.ttl': `@prefix sh: <${NS.sh}> . <urn:x:P> sh:path <urn:x:q> .`,
    // A class declared in a shapes file, and a data file that types an instance with it.
    'declared.ttl': `@prefix sh: <${NS.sh}> . @prefix rdfs: <${NS.rdfs}> .
<urn:y:C> a rdfs:Class, sh:NodeShape ; rdfs:label "Declared" .`,
    'typed.ttl': `@prefix rdfs: <${NS.rdfs}> . <urn:y:i> a <urn:y:C> ; rdfs:label "Typed" ; <urn:y:refers> <urn:y:other> .`,
    'big.ttl': `@prefix rdfs: <${NS.rdfs}> .
${Array.from({ length: EXPLORER_BIG }, (_, i) => `<urn:z:i${i}> a <urn:z:Big> ; rdfs:label "Big ${i}" ; <urn:z:next> <urn:z:i${i + 1}> .`).join('\n')}`
}, { fixtureViews: true });
