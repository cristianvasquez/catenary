// Typings of untyped packages, private to this package: the public declarations (lib/*.d.ts) do not name these modules.

declare module 'rdf-ext' {
    const rdf: unknown;
    export default rdf;
}


declare module 'n3' {
    import type { Quad } from '@rdfjs/types';
    /** The N3.js parser (Turtle, TriG, N-Triples, N-Quads and N3), without streams. */
    export class Parser {
        constructor(options?: { baseIRI?: string; format?: string });
        parse(text: string): Quad[];
    }
}
