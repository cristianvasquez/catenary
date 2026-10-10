// The Model explorer plugin contract. A plugin gives its top sections and the children of its own keys. The host owns the store,
// the graph identities, the label rule, the element ids and the file scope. The plugin owns its queries. All values are JSON.
// This package has no dependencies. Other contracts of the vocabulary packages: query.ts (the query port), schema.ts (schema rules).

import type { QueryPort, QueryTerm } from './query';

export * from './query';
export * from './schema';

/** One row of the Model explorer. */
export interface ExplorerRow {
    /** Unique among the children of one parent. The host adds the plugin id in front of it. */
    key: string;
    name: string;
    /** The row has children (`children` of its key). */
    folder: boolean;
    /** Element id: the selection of the row. A folder can also be an element (a class, a node shape). */
    element?: string;
    /** The number of children. */
    count?: number;
    /** Codicon name. */
    icon?: string;
    /** Short text after the name. */
    description?: string;
    tooltip?: string;
}

/** A path to the row of an element: keys from a section to the row; `name`: the folder names, for a choice between paths. */
export interface ExplorerPath { keys: string[]; name: string }

export type ExplorerTerm = QueryTerm;

/** What the host gives to a plugin for one request: the query port, and the ids and scope of the explorer. */
export interface ExplorerPort extends QueryPort {
    /** The short form of an IRI with the prefixes of the workspace (`dcat:dataset`). */
    compact(iri: string): string;
    /** The element id of an IRI. */
    id(iri: string): string;
    /** True when the subject is in the scope of the request (the file of the Model document). */
    inScope(iri: string): boolean;
    /** Keeps a value for this scope until the dataset changes. */
    memo<T>(key: string, compute: () => T): T;
}

/** A section provider of the Model explorer. */
export interface ExplorerPlugin {
    /** Prefix of the keys of the plugin. No '/'. */
    id: string;
    /** The top rows. A section with no rows in scope gives no row. */
    sections(port: ExplorerPort): ExplorerRow[];
    /** The children of a key of this plugin, in display order. */
    children(port: ExplorerPort, key: string): ExplorerRow[];
    /** All element rows of the plugin in scope, for the filter. `description`: where the row is. One row per element. */
    items(port: ExplorerPort): ExplorerRow[];
    /** The paths to the rows of an IRI. */
    paths(port: ExplorerPort, iri: string): ExplorerPath[];
}

/** Rows by name, case-insensitive. */
export function byName(a: ExplorerRow, b: ExplorerRow): number {
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key);
}
