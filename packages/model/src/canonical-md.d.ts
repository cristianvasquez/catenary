declare module 'canonical-md' {
    export function nameToURI(label: string): { termType: 'NamedNode'; value: string };
    export function nameFromURI(term: { termType: 'NamedNode'; value: string }): string | null;
}
