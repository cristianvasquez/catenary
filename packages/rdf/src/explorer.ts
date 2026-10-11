// The Model explorer (ADR 0006): the sections of the explorer plugins (@catenary/explorer) on this store. A plugin query runs only
// when the frontend asks for the children of a key. Keys: '<plugin id>/<plugin key>'.

import type { ExplorerPlugin, ExplorerPort } from '@catenary/explorer';
import { EXPLORER_PAGE, ExplorerPage, ExplorerPath, ExplorerRow, fuzzyMatch, iriId, shortIri } from '@catenary/model';
import { rdfsExplorer } from '@catenary/rdfs';
import { shaclExplorer } from '@catenary/shacl/backend';
import type { Quad, Term } from '@rdfjs/types';
import * as path from 'path';
import { ModelGraph, VALIDATION_GRAPH } from './graph';
import { elementTerm, relationTriple } from './ids';
import type { Settings } from './settings';
import type { ShapesIndex } from './shapes-read';
import { statementsOfAll } from './selection';
import { labels, statementsByTerm } from './sparql';
import { rdf, termKey } from './terms';

/** One file scope, kept until the dataset changes. */
export interface ExplorerScope { subjects?: Set<string>; memo: Map<string, unknown> }
export interface ExplorerContext { g: ModelGraph; idx: ShapesIndex; settings?: Settings; folder: string; scopes: Map<string, ExplorerScope> }

/** The sections of the Model explorer, in display order. */
export const EXPLORER_PLUGINS: readonly ExplorerPlugin[] = [rdfsExplorer, shaclExplorer];

const keyed = (plugin: ExplorerPlugin) => (row: ExplorerRow): ExplorerRow => ({ ...row, key: plugin.id + '/' + row.key });

/** All rows of a key; no key: the sections. */
function rows(port: ExplorerPort, key?: string): ExplorerRow[] {
    if (key === undefined) return EXPLORER_PLUGINS.flatMap(p => p.sections(port).map(keyed(p)));
    const slash = key.indexOf('/');
    const plugin = EXPLORER_PLUGINS.find(p => p.id === key.slice(0, slash));
    return plugin ? plugin.children(port, key.slice(slash + 1)).map(keyed(plugin)) : [];
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

/** Plugin port with file subjects and memo values kept by the coordinator's event cache. */
export function explorerPort(ctx: ExplorerContext, file?: string): ExplorerPort {
    const scopes = ctx.scopes;
    let scope = scopes.get(file ?? '');
    if (!scope) scopes.set(file ?? '', scope = { subjects: file ? subjectsOfFile(ctx, file) : undefined, memo: new Map() });
    const { subjects, memo } = scope;
    const byTerm = ctx.idx.byTerm;
    return {
        select: query => ctx.g.select(query) as unknown as Record<string, Term>[],
        graph: (pattern, v = '?g') => `GRAPH ${v} { ${pattern} } FILTER (${v} != <${VALIDATION_GRAPH}>)`,
        labels: iris => labels(ctx.g, [...iris]),
        compact: shortIri,
        id: iri => byTerm.get(termKey(rdf.namedNode(iri))) ?? iriId(iri),
        inScope: iri => !subjects || subjects.has(iri),
        memo: <T>(key: string, compute: () => T) => (memo.has(key) ? memo.get(key) : memo.set(key, compute()).get(key)) as T
    };
}

/** IRI subjects of the statements of one file. */
export function subjectsOfFile(ctx: ExplorerContext, file: string): Set<string> {
    const ws = ctx.settings, subjects = new Set<string>();
    const known = ws?.knownFile(path.resolve(ctx.folder, file));
    if (!ws || !known) return subjects;
    for (const q of ctx.g.quads()) if (q.subject.termType === 'NamedNode' && !subjects.has(q.subject.value) && ws.filesOfQuad(q).includes(known)) subjects.add(q.subject.value);
    return subjects;
}

/** A property shape uses its indexed term. Other elements use the IRI of the id. */
export function iriOf(idx: ShapesIndex, id: string): string | undefined {
    const t = idx.property.get(id)?.term ?? elementTerm(id);
    return t?.termType === 'NamedNode' ? t.value : undefined;
}

/** Whether a file holds statements of the element or the triple of a relation. One element of `elementsInFile`. */
export function elementInFile(ctx: ExplorerContext, id: string, file: string): boolean {
    return elementsInFile(ctx, [id], file).has(id);
}

/**
 * The ids among `ids` with a statement (a relation: its triple) in `file`. The statements of all ids come in a bounded number of
 * queries (selection.ts statementsOfAll), not one store read per id (§11.3 readBudgetMs).
 */
export function elementsInFile(ctx: ExplorerContext, ids: string[], file: string): Set<string> {
    const ws = ctx.settings, out = new Set<string>();
    const known = ws?.knownFile(path.resolve(ctx.folder, file));
    if (!ws || !known || !ids.length) return out;
    const inFile = (quads: Quad[] | undefined) => !!quads?.some(q => ws.filesOfQuad(q).includes(known));
    const relations: string[] = [], byTerm = new Map<string, string[]>();
    for (const id of new Set(ids)) {
        if (relationTriple(id)) { relations.push(id); continue; }
        const term = (ctx.idx.property.get(id)?.term ?? elementTerm(id))?.value;
        if (term !== undefined) byTerm.set(term, [...byTerm.get(term) ?? [], id]);
    }
    for (const [id, quads] of statementsOfAll(ctx.g, () => ctx.idx, relations)) if (inFile(quads)) out.add(id);
    const subjects = statementsByTerm(ctx.g, byTerm.keys(), false);
    for (const [term, list] of byTerm) if (inFile(subjects.get(term))) for (const id of list) out.add(id);
    return out;
}
