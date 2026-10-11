// The facts of the store that the panel reads share, kept on the data event (ModelGraph.keys.data) as the view reads of ModelStore
// (viewReads). PanelReads owns one ReadFacts. A read takes a store-wide fact from it (the shaped classes, the terms of each property
// shape id) and asks an indexed fact (files, placements, instances) for a set of elements: the first request reads the store once
// for all of them, a later request of the same elements reads nothing (manifest §11.3 readBudgetMs). No read computes a store-wide
// fact, or reads the store, once per element.

import { Placements, placements } from './actions';
import type { GraphChange, ModelGraph } from './graph';
import { filesOfElements } from './selection';
import type { Settings } from './settings';
import { shapedClasses } from './shape-proposal';
import type { ShapesIndex } from './shapes-read';
import { instancesAmong } from './sparql';

export class ReadFacts {
    private graph?: ModelGraph;
    private event?: GraphChange;
    private shaped?: Set<string>;
    private terms?: Map<string, string[]>;
    private files = new Map<string, string[]>();
    private placed = new Map<string, Set<string>>();
    private instances = new Map<string, boolean>();

    constructor(private readonly ctx: { graph: ModelGraph; settings?: Settings; shapesIndex(): ShapesIndex }) {}

    /** The graph of the request. A new graph or a data event drops every fact. */
    private fresh(): ModelGraph {
        const g = this.ctx.graph;
        if (g !== this.graph || g.keys.data !== this.event) {
            this.graph = g;
            this.event = g.keys.data;
            this.shaped = undefined;
            this.terms = undefined;
            this.files = new Map();
            this.placed = new Map();
            this.instances = new Map();
        }
        return g;
    }

    /** The classes that a node shape targets (shape-proposal.ts shapedClasses), once per data event. */
    shapedClasses(): Set<string> {
        const g = this.fresh();
        return this.shaped ??= shapedClasses(g);
    }

    /** Element id -> the IRIs of its property shape terms: the inverse of ShapesIndex.byTerm, once per data event. */
    termsOf(): Map<string, string[]> {
        this.fresh();
        if (this.terms) return this.terms;
        const terms = new Map<string, string[]>();
        for (const [key, id] of this.ctx.shapesIndex().byTerm) terms.set(id, [...terms.get(id) ?? [], key.slice(1, -1)]);
        return this.terms = terms;
    }

    /** The source files of each element (selection.ts filesOfElements), the elements not asked before in one request. */
    filesOf(of: Iterable<string>): Map<string, string[]> {
        const g = this.fresh(), ids = [...of];
        const missing = [...new Set(ids)].filter(id => !this.files.has(id));
        if (missing.length) for (const [id, files] of filesOfElements(g, () => this.ctx.shapesIndex(), this.ctx.settings, missing)) this.files.set(id, files);
        const out = new Map<string, string[]>();
        for (const id of ids) out.set(id, this.files.get(id) ?? []);
        return out;
    }

    /** The views with a placement of each element (actions.ts placements), the elements not asked before in one request. */
    placementsOf(of: Iterable<string>): Placements {
        const g = this.fresh(), ids = [...of];
        const missing = [...new Set(ids)].filter(id => !this.placed.has(id));
        if (missing.length) {
            const found = placements(g, this.ctx.shapesIndex().byTerm, missing, this.termsOf());
            for (const id of missing) this.placed.set(id, found.get(id) ?? new Set());
        }
        const out: Placements = new Map();
        for (const id of ids) { const s = this.placed.get(id); if (s?.size) out.set(id, s); }
        return out;
    }

    /** The IRIs among `iris` that are instances (vocabulary.ts isInstance), the IRIs not asked before in one request. */
    instancesAmong(of: Iterable<string>): Set<string> {
        // `of` can be an iterator (one pass): read it once.
        const g = this.fresh(), iris = [...of];
        const missing = [...new Set(iris)].filter(s => !this.instances.has(s));
        if (missing.length) {
            const found = instancesAmong(g, missing);
            for (const s of missing) this.instances.set(s, found.has(s));
        }
        const out = new Set<string>();
        for (const s of iris) if (this.instances.get(s)) out.add(s);
        return out;
    }
}
