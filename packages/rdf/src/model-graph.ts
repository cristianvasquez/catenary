// A ModelGraph with the Catenary rules: the view rules of views.ts, the metamodel rule of vocabulary.ts and the cache rules of change.ts.
// graph.ts (rdf-core) imports none of them.

import type { QuadStore } from 'rdf-files';
import { layoutOnly, quadDependencies } from './change';
import { GraphRules, ModelGraph, Proposal } from './graph';
import { isView, views } from './views';
import { metamodelQuad } from './vocabulary';

const CATENARY_RULES: GraphRules = { isView, views, metamodelQuad, dependencies: quadDependencies, layoutOnly };

export function newModelGraph(store: QuadStore): ModelGraph {
    return new ModelGraph<Proposal>(store, CATENARY_RULES);
}
