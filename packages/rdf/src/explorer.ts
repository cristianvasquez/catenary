// The Model explorer (ADR 0006): the sections of the explorer plugins (@catenary/contracts) on this store. A plugin query runs only
// when the frontend asks for the children of a key. Keys: '<plugin id>/<plugin key>'.

import type { ExplorerPlugin, ExplorerPort, RelatedProvider, RelatedSection } from '@catenary/contracts';
import { EXPLORER_PAGE, ExplorerPage, ExplorerPath, ExplorerRow, fuzzyMatch, iriId, shortIri } from '@catenary/model';
import { rdfsExplorer } from '@catenary/rdfs';
import { shaclExplorer, shaclRelated } from '@catenary/shacl/backend';
import type { Term } from '@rdfjs/types';
import * as path from 'path';
import { ModelGraph } from './graph';
import { elementTerm } from './ids';
import type { Settings } from './settings';
import type { ShapesIndex } from './shapes-read';
import { labels } from './sparql';
import { rdf, termKey } from './terms';

export interface ExplorerContext { g: ModelGraph; idx: ShapesIndex; settings?: Settings; folder: string }

/** The sections of the Model explorer, in display order. */
export const EXPLORER_PLUGINS: readonly ExplorerPlugin[] = [rdfsExplorer, shaclExplorer];

/** The Related sections of the Links tab (ui-manifest §8.8), in display order. */
export const RELATED_PROVIDERS: readonly RelatedProvider[] = [shaclRelated];

const keyed = (plugin: ExplorerPlugin) => (row: ExplorerRow): ExplorerRow => ({ ...row, key: plugin.id + '/' + row.key });

/** All rows of a key; no key: the sections. */
function rows(port: ExplorerPort, key?: string): ExplorerRow[] {
    if (key === undefined) return EXPLORER_PLUGINS.flatMap(p => p.sections(port).map(keyed(p)));
    const slash = key.indexOf('/');
    const plugin = EXPLORER_PLUGINS.find(p => p.id === key.slice(0, slash));
    return plugin ? plugin.children(port, key.slice(slash + 1)).map(keyed(plugin)) : [];
}

/** The Related sections of the selected element ids. Keys: '<provider id>/<section key>'. A section with no rows gives no section. */
export function relatedSections(port: ExplorerPort, elements: string[]): RelatedSection[] {
    return RELATED_PROVIDERS.flatMap(p => p.related(port, elements).filter(s => s.rows.length).map(s => ({ ...s, key: p.id + '/' + s.key })));
}

/** One page of the rows of a key. */
export function explorerChildren(port: ExplorerPort, key?: string, offset = 0): ExplorerPage {
    const all = rows(port, key);
    return { rows: all.slice(offset, offset + EXPLORER_PAGE), total: all.length };
}

/** The element rows of all plugins whose name matches `text`, best first, at most one page. */
export function explorerSearch(port: ExplorerPort, text: string): ExplorerRow[] {
    return EXPLORER_PLUGINS.flatMap(p => p.items(port).map(keyed(p)))
        .flatMap(row => { const m = fuzzyMatch(row.name, text); return m ? [{ row: { ...row, folder: false }, score: m.score }] : []; })
        .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name))
        .slice(0, EXPLORER_PAGE).map(r => r.row);
}

/** The paths to the rows of an IRI in all sections. */
export function explorerPaths(port: ExplorerPort, iri: string): ExplorerPath[] {
    return EXPLORER_PLUGINS.flatMap(p => p.paths(port, iri).map(path => ({ ...path, keys: path.keys.map(k => p.id + '/' + k) })));
}

/** The element ids of the rows under a key, at any depth (each key once: a cycle ends). */
export function explorerElements(port: ExplorerPort, key: string): string[] {
    const ids = new Set<string>(), seen = new Set<string>();
    const visit = (k: string) => {
        if (seen.has(k)) return;
        seen.add(k);
        for (const row of rows(port, k)) {
            if (row.element) ids.add(row.element);
            if (row.folder) visit(row.key);
        }
    };
    visit(key);
    return [...ids];
}

/**
 * The store graphs of a file (ui-manifest §8.5 law_fileRowsOwnSubjects): the data graph and the shapes graph of a model file, the view
 * graphs of a view file. An unknown file has none.
 */
export function graphsOfFile(ctx: ExplorerContext, file: string): string[] {
    const ws = ctx.settings, known = ws?.knownFile(path.resolve(ctx.folder, file));
    if (!ws || !known) return [];
    const views = [...ws.viewFiles].filter(([, f]) => f.path === known).map(([g]) => g);
    return [...ctx.g.graphsOfFile(known).map(g => g.value), ...views];
}

/**
 * The plugin port of one request: the plugin queries read the graphs of the file only. No file: the graphs of all model files (the
 * Related sections of the Links tab). The memo lives for the request.
 */
export function explorerPort(ctx: ExplorerContext, file?: string): ExplorerPort {
    const memo = new Map<string, unknown>(), byTerm = ctx.idx.byTerm;
    const files = file === undefined ? [...ctx.settings?.modelFiles.keys() ?? []] : [file];
    const graphs = [...new Set(files.flatMap(f => graphsOfFile(ctx, f)))].map(g => `<${g}>`).join(' ');
    return {
        select: query => ctx.g.select(query) as unknown as Record<string, Term>[],
        graph: (pattern, v = '?g') => `VALUES ${v} { ${graphs} } GRAPH ${v} { ${pattern} }`,
        labels: iris => labels(ctx.g, [...iris]),
        compact: shortIri,
        id: iri => byTerm.get(termKey(rdf.namedNode(iri))) ?? iriId(iri),
        memo: <T>(key: string, compute: () => T) => (memo.has(key) ? memo.get(key) : memo.set(key, compute()).get(key)) as T
    };
}

/** A property shape uses its indexed term. Other elements use the IRI of the id. */
export function iriOf(idx: ShapesIndex, id: string): string | undefined {
    const t = idx.property.get(id)?.term ?? elementTerm(id);
    return t?.termType === 'NamedNode' ? t.value : undefined;
}
