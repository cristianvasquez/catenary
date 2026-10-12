// The model as quads in a QuadStore. Each model file has data and shapes graphs.
// Each view file uses its view IRI as its graph name.
// The role of a graph comes from the registry of this class (`union`, `setShapesGraphs`), not from its name.
// The store is the source of truth. Every change goes through `add` / `remove`, which record a patch:
// a transaction gives one patch, undo applies the patch backwards. Element ids: see ids.ts.
// The rules (view test, metamodel test, cache dependencies of a quad, layout-only test of a patch) come in through the constructor.
// Catenary passes its rules in packages/rdf/src/model-graph.ts.

import type { TermSet } from 'rdf-ext';
import type { NamedNode, Quad, Quad_Graph, Quad_Object, Quad_Predicate, Quad_Subject, Term } from '@rdfjs/types';
import type { QuadStore } from 'rdf-files';
import { rdf, tripleKey } from './terms';

/**
 * The graph names of the host. The core owns no IRI value: the caller gives the names to the constructor.
 * `union`: the logical union of the data graphs. `report`: the graph of the validation report (not saved).
 * `data`, `shapes`: the store graph of the data and of the shapes of a file (its store path).
 * `fileOf`: the store path of a data or shapes graph, or undefined for another graph.
 */
export interface GraphNames {
    union: string;
    report: string;
    data(file: string): string;
    shapes(file: string): string;
    fileOf(graph: string): string | undefined;
}

/** The vocabulary rules of the change events and the logical data scope. The caller gives them to the constructor. */
export interface GraphRules {
    isView(g: ModelGraph, t: Term | undefined): boolean;
    views(g: ModelGraph): NamedNode[];
    metamodelQuad(g: ModelGraph, q: Quad): boolean;
    /** The cache inputs that one added or removed quad invalidates. */
    dependencies(g: ModelGraph, q: Quad): Dependencies;
    /** True when a committed patch changes placement geometry and style only (GraphChange.layout). */
    layoutOnly(g: ModelGraph, patch: Patch): boolean;
}

/** `was`: on an add, the statement that it replaces (an IRI change); the store keeps the files of that statement. */
export type Change = { op: 'add' | 'remove'; quad: Quad; was?: Quad };

/** The changes of one transaction, in order. */
export type Patch = Change[];

/** One committed patch and its cache dependencies. Metadata changes can have an empty patch. */
export interface GraphChange {
    sequence: number; patch: Patch; graphs: string[]; elements: string[];
    shapes: boolean; query: boolean; data: boolean; persisted: boolean; layout: boolean;
}
export type Dependencies = Pick<GraphChange, 'shapes' | 'query' | 'data' | 'persisted'>;
let sequence = 0;
const emptyChange = (): GraphChange => ({ sequence: 0, patch: [], graphs: [], elements: [], shapes: false, query: false, data: false, persisted: false, layout: false });

type Maybe<T> = T | null | undefined;

/** `P`: the type of the records that the open transaction proposes (`proposed`). */
export class ModelGraph<P = unknown> {
    /** Logical union of file data graphs; temporary additions use it until transaction placement. */
    union: NamedNode;

    /** The shapes graphs: the store graphs of the shapes files. */
    protected shapes: TermSet<NamedNode> = rdf.termSet<NamedNode>();
    protected data?: NamedNode[];
    protected log?: Patch;

    /** Shapes graph that gets new node shapes (the primary shapes file). Undefined: the first shapes graph. */
    primaryShapes?: NamedNode;

    /** Preferred language tag of the labels that the reads give, set by the host. A plain preference: the host gives the rule. Undefined: none. */
    language?: string;

    /** Records that the open transaction proposes. A transaction starts with none, and a rollback removes them. The caller reads them after the commit. */
    proposed: P[] = [];

    /** The committed event and the last event that affects each cache input. */
    change: GraphChange = emptyChange();
    keys = { shapes: this.change, query: this.change, data: this.change, persisted: this.change };
    protected readonly listeners = new Set<(change: GraphChange) => void>();
    protected pending: Dependencies = { shapes: false, query: false, data: false, persisted: false };

    onDidChange(listener: (change: GraphChange) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    /** Invalidate inputs changed by metadata, such as graph roles, prefixes or file membership. */
    invalidate(dependencies: Partial<Dependencies> = { shapes: true, query: true, data: true, persisted: true }): void {
        const event = { ...emptyChange(), ...dependencies };
        for (const key of Object.keys(this.keys) as (keyof Dependencies)[]) if (event[key]) {
            this.pending[key] = true;
            this.keys[key] = event;
        }
        if (!this.log) this.publish([], event);
    }

    /** The cache inputs that a quad invalidates (the dependencies rule). */
    protected dependencies(q: Quad): Dependencies {
        return this.rules.dependencies(this, q);
    }

    /** A quad of a data graph that changes the metamodel (GraphFacts.metamodelQuad): the metamodelQuad rule. */
    metamodelQuad(q: Quad): boolean {
        return this.rules.metamodelQuad(this, q);
    }

    /** View: a named graph with a view:View subject (GraphFacts.isView): the isView rule. */
    isView(t: Term | undefined): boolean {
        return this.rules.isView(this, t);
    }

    protected publish(patch: Patch, dependencies: Dependencies): void {
        const event: GraphChange = {
            ...dependencies, sequence: ++sequence, patch,
            graphs: [...new Set(patch.map(c => c.quad.graph.value))],
            elements: [...new Set(patch.flatMap(c => [c.quad.subject, c.quad.object])
                .filter(t => t.termType === 'NamedNode').map(t => t.value))],
            layout: this.rules.layoutOnly(this, patch)
        };
        this.change = event;
        for (const key of Object.keys(this.keys) as (keyof Dependencies)[]) if (event[key]) this.keys[key] = event;
        this.pending = { shapes: false, query: false, data: false, persisted: false };
        for (const listener of [...this.listeners]) listener(event);
    }

    constructor(readonly store: QuadStore, readonly rules: GraphRules, readonly names: GraphNames) {
        this.union = rdf.namedNode(names.union);
    }

    setShapesGraphs(graphs: Iterable<NamedNode>): void {
        const next = [...graphs];
        if (next.length === this.shapes.size && next.every(g => this.shapes.has(g))) return;
        this.shapes = rdf.termSet(next);
        this.invalidate({ shapes: true, query: true, data: true });
    }

    setDataGraphs(graphs: Iterable<NamedNode>): void {
        const next = [...graphs];
        if (this.data && next.length === this.data.length && next.every(g => this.data!.some(x => x.equals(g)))) return;
        this.data = next;
        this.invalidate({ shapes: true, query: true, data: true });
    }

    dataGraphs(): NamedNode[] { return this.data ?? [this.union]; }

    isDataGraph(t: Pick<Term, 'termType' | 'value'> | undefined): boolean {
        return !!t && t.termType === 'NamedNode' && (t.value === this.union.value || !!this.data?.some(g => g.value === t.value));
    }

    /** Register the data graph of a model file before statements enter it. The registry, not the IRI, gives a graph its role. */
    addDataGraph(g: NamedNode): void {
        if (this.data && !this.data.some(t => t.equals(g))) this.setDataGraphs([...this.data, g]);
    }

    /** Resolve temporary data additions before a command commits. Only final file graphs enter its patch. */
    placePending(resolve: (q: Quad, changes: readonly Change[], fallback: boolean) => string[] | undefined): void {
        if (!this.log || !this.data) return;
        const changes = [...this.log];
        let pending = this.store.match(null, null, null, this.union);
        const additions = new Map(changes.filter(c => c.op === 'add' && c.quad.graph.equals(this.union)).map(c => [tripleKey(c.quad), c]));
        const log = this.log;
        const place = (q: Quad, files: string[]) => {
            this.store.delete(q);
            for (const file of files) this.addDataGraph(rdf.namedNode(this.names.data(file)));
            for (const file of files) this.add(q.subject, q.predicate, q.object, rdf.namedNode(this.names.data(file)), additions.get(tripleKey(q))?.was);
        };
        while (pending.length) {
            const rest: Quad[] = [];
            for (const q of pending) {
                const files = resolve(q, changes, false);
                if (files?.length) place(q, files);
                else rest.push(q);
            }
            if (rest.length === pending.length) {
                // Place a parent first, then its new nested values can follow its concrete file graph.
                const subjects = new Set(rest.map(q => q.subject.value));
                const root = rest.find(q => !rest.some(r => r.object.equals(q.subject) && !r.subject.equals(q.subject) && subjects.has(r.subject.value))) ?? rest[0];
                const files = resolve(root, changes, true);
                if (!files?.length) throw new Error('Cannot assign a file to the new statements.');
                for (const q of rest.filter(q => q.subject.equals(root.subject))) place(q, files);
                pending = rest.filter(q => !q.subject.equals(root.subject));
            } else pending = rest;
        }
        log.splice(0, log.length, ...log.filter(c => !c.quad.graph.equals(this.union)));
    }

    isShapesGraph(t: Term | undefined): boolean {
        return !!t && t.termType === 'NamedNode' && this.shapes.has(t);
    }

    /** The registered data graph and shapes graph of a model file (its store path). A view file has its view graph instead. */
    graphsOfFile(file: string): NamedNode[] {
        return [rdf.namedNode(this.names.data(file)), rdf.namedNode(this.names.shapes(file))].filter(g => this.isDataGraph(g) || this.isShapesGraph(g));
    }

    has(q: Quad): boolean {
        return q.graph.equals(this.union) && this.data ? this.match(q.subject, q.predicate, q.object, this.union).length > 0 : this.store.has(q);
    }

    match(s?: Maybe<Term>, p?: Maybe<Term>, o?: Maybe<Term>, g?: Maybe<Term>): Quad[] {
        if (!g?.equals(this.union) || !this.data) return this.store.match(s, p, o, g);
        const found = new Map<string, Quad>();
        for (const graph of [...this.data, this.union]) for (const q of this.store.match(s, p, o, graph)) {
            found.set(tripleKey(q), rdf.quad(q.subject, q.predicate, q.object, this.union));
        }
        return [...found.values()];
    }

    /** Compile internal logical-model GRAPH patterns to distinct default-scope reads.
     * Oxigraph preserves duplicate bindings across FROM graphs, so each graph pattern needs DISTINCT.
     */
    protected scopedQuery(query: string): string {
        if (!this.data) return query;
        const union = `GRAPH <${this.union.value}>`;
        if (!query.includes(union)) return query;
        const graphs = [...new Set([...this.data, this.union, ...this.shapesGraphs(), ...this.rules.views(this), rdf.namedNode(this.names.report)].map(g => g.value))];
        const dataset = [...this.data, this.union].map(g => `FROM <${g.value}>`).join(' ')
            + ' ' + graphs.map(g => `FROM NAMED <${g}>`).join(' ');
        let index = 0, offset = 0;
        // Quotes inside IRI tokens are not string delimiters.
        const graphTokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|GRAPH\s+<[^\s<>]*>|<[^\s<>]*>/g;
        while (offset < query.length) {
            graphTokens.lastIndex = offset;
            let graph = graphTokens.exec(query);
            while (graph && graph[0] !== union) graph = graphTokens.exec(query);
            if (!graph) break;
            offset = graph.index;
            const start = query.indexOf('{', offset + union.length);
            const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|<[^\s<>]*>|\?[A-Za-z_][A-Za-z_0-9]*|[{}]/g;
            tokens.lastIndex = start;
            const variables = new Set<string>();
            let depth = 0, end = -1;
            for (let token = tokens.exec(query); token; token = tokens.exec(query)) {
                if (token[0] === '{') depth++;
                else if (token[0] === '}' && --depth === 0) { end = tokens.lastIndex; break; }
                else if (token[0].startsWith('?')) variables.add(token[0]);
            }
            if (end < 0) throw new Error('The logical data scope has no closing brace.');
            const projection = variables.size ? [...variables].join(' ') : `(1 AS ?__dataScope${index})`;
            const replacement = `{ SELECT DISTINCT ${projection} WHERE ${query.slice(start, end)} }`;
            query = query.slice(0, offset) + replacement + query.slice(end);
            offset += replacement.length;
            index++;
        }
        const keywords = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|<[^\s<>]*>|\bWHERE\b/gi;
        for (let keyword = keywords.exec(query); keyword; keyword = keywords.exec(query)) {
            if (keyword[0].toUpperCase() === 'WHERE') return query.slice(0, keyword.index) + dataset + ' ' + query.slice(keyword.index);
        }
        throw new Error('The logical data query has no WHERE clause.');
    }

    select(query: string) { return this.store.select(this.scopedQuery(query)); }
    construct(query: string): Quad[] { return this.store.construct(this.scopedQuery(query)); }

    /** All quads. */
    quads(): Quad[] { return this.store.match(); }

    /** `was`: the statement that this one replaces (see Change.was). */
    // g is the target graph. g.union is the union: placePending gives such a quad its file graph before the transaction commits.
    add(s: Quad_Subject, p: Quad_Predicate, o: Quad_Object, g: Quad_Graph, was?: Quad): void {
        const q = rdf.quad(s, p, o, g);
        if (this.has(q)) return;
        if (!this.log) { this.transact(graph => { graph.add(s, p, o, g, was); return { ok: true }; }); return; }
        const dependencies = this.dependencies(q);
        this.store.add(q);
        this.invalidate(dependencies);
        this.log.push(was ? { op: 'add', quad: q, was } : { op: 'add', quad: q });
    }

    remove(q: Quad): void {
        if (q.graph.equals(this.union) && this.data) {
            this.update(() => {
                for (const graph of [...this.data!, this.union]) for (const copy of this.store.match(q.subject, q.predicate, q.object, graph)) {
                    if (graph.equals(this.union)) this.removeStored(copy);
                    else this.remove(copy);
                }
            });
            return;
        }
        this.removeStored(q);
    }

    protected removeStored(q: Quad): void {
        if (!this.store.has(q)) return;
        if (!this.log) { this.transact(g => { g.remove(q); return { ok: true }; }); return; }
        const dependencies = this.dependencies(q);
        this.store.delete(q);
        this.invalidate(dependencies);
        this.log.push({ op: 'remove', quad: q });
    }

    removeMatches(s?: Maybe<Term>, p?: Maybe<Term>, o?: Maybe<Term>, g?: Maybe<Term>): void {
        for (const q of [...this.match(s, p, o, g)]) this.remove(q);
    }

    /** Replace the objects of (s, p) in graph g. Undefined removes them. */
    set(s: Quad_Subject, p: Quad_Predicate, o: Quad_Object | undefined, g: Quad_Graph): void {
        this.update(() => {
            const copies = g.equals(this.union) && this.data
                ? this.store.match(s, p).filter(q => this.isDataGraph(q.graph)) : this.match(s, p, null, g);
            const graphs = copies.length ? [...new Map(copies.map(q => [q.graph.value, q.graph])).values()] : [g];
            for (const q of copies) if (!o || !q.object.equals(o)) this.remove(q);
            if (o) for (const graph of graphs) this.add(s, p, o, graph);
        });
    }

    /**
     * Run `fn` as one transaction and return its result with the patch of its changes.
     * An error result or an exception reverts the changes (the patch is then empty).
     */
    transact<R extends { ok: boolean }>(fn: (g: this) => R): { result: R | { ok: false; error: string }; patch: Patch } {
        if (this.log) throw new Error('A transaction is already open.');
        const before = { change: this.change, keys: { ...this.keys }, shapes: this.shapes, data: this.data };
        const log: Patch = this.log = [];
        this.pending = { shapes: false, query: false, data: false, persisted: false };
        this.proposed = [];
        let result: R | { ok: false; error: string };
        try {
            result = fn(this);
        } catch (e) {
            result = { ok: false, error: (e as Error).message };
        }
        this.log = undefined;
        if (result.ok) {
            if (log.length || Object.values(this.pending).some(Boolean)) this.publish(log, this.pending);
            return { result, patch: log };
        }
        this.proposed = [];
        for (const c of [...log].reverse()) {
            if (c.op === 'add') this.store.delete(c.quad);
            else this.store.add(c.quad);
        }
        this.change = before.change;
        this.keys = before.keys;
        this.shapes = before.shapes;
        this.data = before.data;
        this.pending = { shapes: false, query: false, data: false, persisted: false };
        return { result, patch: [] };
    }

    /** Apply a synchronous load inside an existing transaction, or as its own patch. */
    update(fn: () => void): Patch {
        if (this.log) { fn(); return []; }
        const { result, patch } = this.transact(() => { fn(); return { ok: true }; });
        if (!result.ok) throw new Error('error' in result ? result.error : 'The graph update failed.');
        return patch;
    }

    /** The changes of the open transaction so far (empty outside a transaction). */
    changes(): readonly Change[] { return this.log ?? []; }

    undo(patch: Patch): void {
        this.update(() => {
            for (const c of [...patch].reverse()) {
                if (c.op === 'add') this.remove(c.quad);
                else this.add(c.quad.subject, c.quad.predicate, c.quad.object, c.quad.graph);
            }
        });
    }

    redo(patch: Patch): void {
        this.update(() => {
            for (const c of patch) {
                if (c.op === 'remove') this.remove(c.quad);
                else this.add(c.quad.subject, c.quad.predicate, c.quad.object, c.quad.graph, c.was);
            }
        });
    }

    objects(s: Term, p: Term, g: Maybe<Term> = this.union): Quad_Object[] {
        return [...this.match(s, p, null, g)].map(q => q.object);
    }

    /** The first object in term order: a stable choice when there are several. */
    object(s: Term, p: Term, g: Maybe<Term> = this.union): Quad_Object | undefined {
        return this.objects(s, p, g).sort((a, b) => cmp(a.value, b.value))[0];
    }

    subjects(p: Term, o: Maybe<Term>, g: Maybe<Term> = this.union): Quad_Subject[] {
        return [...this.match(null, p, o, g)].map(q => q.subject);
    }

    number(s: Term, p: Term, g: Term, fallback: number): number {
        const v = this.object(s, p, g)?.value;
        return v === undefined || isNaN(Number(v)) ? fallback : Number(v);
    }

    /** Shapes graph IRIs that have quads, sorted. */
    shapesGraphs(): NamedNode[] {
        return sorted([...this.shapes].filter(g => this.match(null, null, null, g).length > 0));
    }
}

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Terms sorted by value. */
export function sorted<T extends Term>(terms: Iterable<T>): T[] {
    return [...terms].sort((a, b) => cmp(a.value, b.value));
}
