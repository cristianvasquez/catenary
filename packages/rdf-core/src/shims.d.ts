// Typings of rdf-ext, private to this package (the same as packages/rdf/src/shims.d.ts). tsconfig.test.json uses the copy of packages/rdf.

declare module 'rdf-ext' {
    import type { BlankNode, DataFactory, DatasetCore, NamedNode, Quad, Term } from '@rdfjs/types';
    type T = Term | null | undefined;
    interface Dataset extends DatasetCore, Iterable<Quad> {
        size: number;
        add(q: Quad): this;
        addAll(quads: Iterable<Quad>): this;
        delete(q: Quad): this;
        has(q: Quad): boolean;
        match(s?: T, p?: T, o?: T, g?: T): Dataset;
        deleteMatches(s?: T, p?: T, o?: T, g?: T): this;
        toString(): string;
        /** Canonical N-Quads (URDNA2015). */
        toCanonical(): string;
    }
    /** grapoi pointer (subset). */
    interface Grapoi extends Iterable<Grapoi> {
        term: Term | undefined;
        terms: Term[];
        value: string | undefined;
        values: string[];
        out(predicates?: Term | Term[] | null, objects?: Term | Term[] | null): Grapoi;
        in(predicates?: Term | Term[] | null, subjects?: Term | Term[] | null): Grapoi;
        hasOut(predicates?: Term | Term[] | null, objects?: Term | Term[] | null): Grapoi;
        isList(): boolean;
        list(): Iterable<Grapoi> | undefined;
        filter(fn: (ptr: Grapoi) => boolean): Grapoi;
    }
    interface TermSet<T extends Term = Term> extends Iterable<T> {
        size: number;
        add(t: T): this;
        has(t: Term): boolean;
        delete(t: Term): boolean;
    }
    interface TermMap<K extends Term = Term, V = unknown> extends Iterable<[K, V]> {
        size: number;
        get(k: Term): V | undefined;
        set(k: K, v: V): this;
        has(k: Term): boolean;
        delete(k: Term): boolean;
        keys(): IterableIterator<K>;
        values(): IterableIterator<V>;
    }
    interface Env extends DataFactory {
        termSet<T extends Term = Term>(terms?: Iterable<T>): TermSet<T>;
        termMap<K extends Term = Term, V = unknown>(entries?: Iterable<[K, V]>): TermMap<K, V>;
        blankNode(value?: string): BlankNode;
        dataset(quads?: Iterable<Quad>): Dataset;
        grapoi(args: { dataset: DatasetCore; term?: Term; terms?: Term[]; graph?: Term }): Grapoi;
        namespace(base: string): ((local?: string) => NamedNode) & Record<string, NamedNode>;
        io: { dataset: { fromText(mediaType: string, text: string, args?: { baseIRI?: string }): Promise<Dataset>; toText(mediaType: string, dataset: DatasetCore): Promise<string> } };
    }
    const rdf: Env;
    export default rdf;
    export type { Dataset, Grapoi, TermMap, TermSet };
}
