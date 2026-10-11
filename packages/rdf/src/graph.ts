// The ModelGraph of Catenary: the rdf-core ModelGraph whose transactions propose data migrations (shape-ops.ts, ModelStore queue).
// Construct it with newModelGraph (model-graph.ts), which gives the Catenary rules.

import type { MigrationChange } from '@catenary/model';
import { ModelGraph as CoreModelGraph } from 'rdf-core';

export {
    DATA_GRAPH_PREFIX, FILE_GRAPH_PREFIX, MODEL_GRAPH, VALIDATION_GRAPH, cmp, dataGraphIri, fileGraphIri, fileOfGraph, sorted
} from 'rdf-core';
export type { Change, Dependencies, GraphChange, GraphRules, Patch } from 'rdf-core';

/** A data migration that a shape edit of the open transaction proposes (the store puts it in its queue). */
export type Proposal = { change: MigrationChange; reason: string };

export type ModelGraph = CoreModelGraph<Proposal>;
export const ModelGraph = CoreModelGraph;
