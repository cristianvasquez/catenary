// The Model explorer (ADR 0006): the sections of the explorer plugins (@catenary/explorer) on this store. A plugin query runs only
// when the frontend asks for the children of a key. Keys: '<plugin id>/<plugin key>'.

import type { ExplorerPlugin, ExplorerPort } from '@catenary/explorer';
import { rdfsExplorer } from '@catenary/rdfs';
import { shaclExplorer } from '@catenary/shacl/backend';
import { EXPLORER_PAGE, ExplorerPage, ExplorerPath, ExplorerRow, fuzzyMatch } from '@catenary/model';

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
