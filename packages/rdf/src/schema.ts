// The schema providers (@catenary/explorer SchemaProvider) on this store: their rules join the metamodel of the shapes (mergeSchema).
// The rules come from all graphs of the files, not from the validation report. Validation never uses them.

import type { QueryPort, SchemaProvider } from '@catenary/explorer';
import { Classes, mergeSchema } from '@catenary/model';
import { rdfsSchema } from '@catenary/rdfs';
import type { Term } from '@rdfjs/types';
import { ModelGraph, VALIDATION_GRAPH } from './graph';
import { labels } from './sparql';

/** The schema providers, in merge order. The shapes win over all of them. */
export const SCHEMA_PROVIDERS: readonly SchemaProvider[] = [rdfsSchema];

export function schemaPort(g: ModelGraph): QueryPort {
    return {
        select: query => g.store.select(query) as unknown as Record<string, Term>[],
        graph: (pattern, v = '?g') => `GRAPH ${v} { ${pattern} } FILTER (${v} != <${VALIDATION_GRAPH}>)`,
        labels: iris => labels(g, [...iris])
    };
}

/** The metamodel `meta` with the rules of each schema provider. */
export function withSchema<T extends Classes>(g: ModelGraph, meta: T): T {
    const port = schemaPort(g);
    return SCHEMA_PROVIDERS.reduce((m, p) => mergeSchema(m, p.schema(port), p.id), meta);
}
