// The Related contract of the Links tab. A provider gives sections of elements that relate to the selected elements. The host owns
// the store, the element ids and the label rule. The provider owns its queries. All values are JSON.
// The explorer port comes from ./explorer.

import type { ExplorerPort } from './explorer';

/** One row of a Related section: an element that relates to the selection. */
export interface RelatedRow {
    /** Element id. Enter and double-click go to it. */
    element: string;
    /** No name: the host gives the label of the element. */
    name?: string;
    /** Short text after the name. */
    description?: string;
    tooltip?: string;
}

/** A top-level folder of the Links tab. */
export interface RelatedSection {
    /** Unique among the sections of the provider. */
    key: string;
    title: string;
    rows: RelatedRow[];
}

/** A section provider of the Links tab. */
export interface RelatedProvider {
    /** Prefix of the keys of the provider. No '/'. */
    id: string;
    /** The sections of the selected element ids. A section with no rows gives no folder. */
    related(port: ExplorerPort, elements: string[]): RelatedSection[];
}
