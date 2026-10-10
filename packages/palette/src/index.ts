// The palette provider contract. A vocabulary plugin reads its declarations through the query port and gives the classes that the
// palette and the class picker offer. The host merges the classes of all plugins into the metamodel (@catenary/model): the first
// plugin that gives a class wins. All values are JSON.

import type { QueryPort } from '@catenary/query';

export interface PaletteClass {
    iri: string;
    /** Written label of the class. None: the host names it from its IRI. */
    name?: string;
    description?: string;
    /** Palette position (sh:order). None: after the ordered classes, by name. */
    order?: number;
    /** The resources that declare the class for this plugin (SHACL: its node shapes). */
    sources?: string[];
    /** What the plugin read but cannot give, as text for the user (SHACL: `knows: inverse path is not supported`). */
    notes?: string[];
}

export interface PaletteProvider {
    /** The plugin (`shacl`, `rdfs`): the same id in all its providers. */
    id: string;
    classes(port: QueryPort): PaletteClass[];
}
