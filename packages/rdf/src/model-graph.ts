// A ModelGraph with the Catenary rules: the view rules of views.ts and the metamodel rule of vocabulary.ts. graph.ts imports neither.

import type { QuadStore } from 'rdf-files';
import { GraphRules, ModelGraph } from './graph';
import { isView, views } from './views';
import { metamodelQuad } from './vocabulary';

const CATENARY_RULES: GraphRules = { isView, views, metamodelQuad };

export function newModelGraph(store: QuadStore): ModelGraph {
    return new ModelGraph(store, CATENARY_RULES);
}
