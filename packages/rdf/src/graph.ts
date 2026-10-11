// The ModelGraph of Catenary: the rdf-core ModelGraph whose transactions propose data migrations (shape-ops.ts, ModelStore queue).
// Construct it with newModelGraph (model-graph.ts), which gives the Catenary rules.

import type { MigrationChange } from '@catenary/model';
import { ModelGraph as CoreModelGraph } from 'rdf-core';

export { cmp, sorted } from 'rdf-core';
export type { Change, Dependencies, GraphChange, GraphNames, GraphRules, Patch } from 'rdf-core';
export {
    CATENARY_GRAPH_NAMES, DATA_GRAPH_PREFIX, REPORT_GRAPH, SHAPES_GRAPH_PREFIX, UNION_GRAPH, dataGraphIri, fileOfGraph, shapesGraphIri
} from './graph-names';

/** A data migration that a shape edit of the open transaction proposes (the store puts it in its queue). */
export type Proposal = { change: MigrationChange; reason: string };

export type ModelGraph = CoreModelGraph<Proposal>;
export const ModelGraph = CoreModelGraph;
