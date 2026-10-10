// The vocabulary plugins of the palette, links and fields contracts on this store, and their merge into the metamodel
// (mergeContributions). This package parses no vocabulary: SHACL and RDFS read their own statements through a query port.

import type { FieldsProvider } from '@catenary/fields';
import type { LinksProvider } from '@catenary/links';
import { Classes, mergeContributions } from '@catenary/model';
import type { PaletteProvider } from '@catenary/palette';
import type { QueryPort } from '@catenary/query';
import { rdfsFields, rdfsLinks, rdfsPalette } from '@catenary/rdfs';
import { shaclFields, shaclLinks, shaclPalette } from '@catenary/shacl/backend';
import type { Term } from '@rdfjs/types';
import { ModelGraph, VALIDATION_GRAPH } from './graph';
import { labels } from './sparql';

/** A vocabulary plugin: the graphs it reads and the contracts it gives. A plugin gives the contracts it can. */
export interface AuthoringPlugin {
    /** `shapes`: the shapes graphs (the SHACL shapes graph). `files`: all graphs of the files. Never the validation report. */
    reads: 'shapes' | 'files';
    palette?: PaletteProvider;
    links?: LinksProvider;
    fields?: FieldsProvider;
}

/** The plugins, in precedence order: for a class and a predicate, the first plugin that gives a link or a field wins. */
export const AUTHORING_PLUGINS: readonly AuthoringPlugin[] = [
    { reads: 'shapes', palette: shaclPalette, links: shaclLinks, fields: shaclFields },
    { reads: 'files', palette: rdfsPalette, links: rdfsLinks, fields: rdfsFields }
];

/** A query port on the graphs of the files, or on `graphs` only. */
export function queryPort(g: ModelGraph, graphs?: readonly string[]): QueryPort {
    const scope = (v: string) => graphs ? `FILTER (${v} IN (${graphs.map(x => `<${x}>`).join(', ')}))` : `FILTER (${v} != <${VALIDATION_GRAPH}>)`;
    return {
        select: query => g.store.select(query) as unknown as Record<string, Term>[],
        graph: (pattern, v = '?g') => `GRAPH ${v} { ${pattern} } ${scope(v)}`,
        labels: iris => labels(g, [...iris])
    };
}

/**
 * The metamodel of the plugins on `g`: each reads its graphs (`shapes`: `shapesGraphs`, default the shapes graphs of `g`).
 * `vocabulary`: the SKOS schemes and concepts, for the value sets of the links.
 */
export function authoringMetamodel(g: ModelGraph, vocabulary: Pick<Classes, 'schemes' | 'concepts'>, plugins = AUTHORING_PLUGINS,
    shapesGraphs = g.shapesGraphs().map(t => t.value)): Classes {
    const files = queryPort(g), shapes = queryPort(g, shapesGraphs);
    return mergeContributions(plugins.map(p => {
        const port = p.reads === 'shapes' ? shapes : files;
        const id = p.palette?.id ?? p.links?.id ?? p.fields?.id ?? '';
        return { id, classes: p.palette?.classes(port), links: p.links?.links(port), fields: p.fields?.fields(port) };
    }), vocabulary);
}
