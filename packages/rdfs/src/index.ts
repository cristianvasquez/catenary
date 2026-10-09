// The Classes section of the Model explorer: each class of an rdf:type statement with its direct instances, nested by the
// rdfs:subClassOf statements of the data. No inference: an instance shows only under the classes that it states.

import { ExplorerPath, ExplorerPlugin, ExplorerPort, ExplorerRow, byName } from '@catenary/explorer';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const PREFIXES = `PREFIX rdf: <${RDF}> PREFIX rdfs: <${RDFS}>`;

interface Classes {
    /** Class -> its instances in scope. */
    members: Map<string, string[]>;
    /** Instance -> its classes. */
    types: Map<string, string[]>;
    /** Class -> its shown subclasses. */
    subs: Map<string, string[]>;
    /** Class -> its shown superclasses. */
    supers: Map<string, string[]>;
    /** The classes with an instance in scope and their superclasses. */
    shown: Set<string>;
    /** Shown classes without a shown superclass (and one class of each subclass cycle). */
    tops: string[];
    names: Map<string, string>;
}

const add = (m: Map<string, string[]>, k: string, v: string) => {
    const list = m.get(k);
    if (!list) m.set(k, [v]);
    else if (!list.includes(v)) list.push(v);
};

function classes(port: ExplorerPort): Classes {
    return port.memo('rdfs', () => {
        const members = new Map<string, string[]>(), types = new Map<string, string[]>();
        for (const r of port.select(`${PREFIXES} SELECT DISTINCT ?s ?c WHERE { ${port.graph('?s rdf:type ?c')} FILTER (isIRI(?s) && isIRI(?c)) }`)) {
            if (!port.inScope(r.s.value)) continue;
            add(members, r.c.value, r.s.value);
            add(types, r.s.value, r.c.value);
        }
        const declared = new Map<string, string[]>();
        for (const r of port.select(`${PREFIXES} SELECT DISTINCT ?c ?d WHERE { ${port.graph('?c rdfs:subClassOf ?d')} FILTER (isIRI(?c) && isIRI(?d) && ?c != ?d) }`)) {
            add(declared, r.c.value, r.d.value);
        }
        const shown = new Set(members.keys());
        for (const c of shown) for (const d of declared.get(c) ?? []) shown.add(d);
        const subs = new Map<string, string[]>(), supers = new Map<string, string[]>();
        for (const c of shown) for (const d of declared.get(c) ?? []) {
            add(subs, d, c);
            add(supers, c, d);
        }
        const tops = [...shown].filter(c => !supers.has(c));
        const reached = new Set<string>();
        const reach = (c: string) => {
            if (reached.has(c)) return;
            reached.add(c);
            for (const s of subs.get(c) ?? []) reach(s);
        };
        tops.forEach(reach);
        for (const c of shown) if (!reached.has(c)) {
            tops.push(c);
            reach(c);
        }
        const names = port.labels([...shown, ...types.keys()]);
        return { members, types, subs, supers, shown, tops, names };
    });
}

function classRow(port: ExplorerPort, data: Classes, c: string): ExplorerRow {
    const count = (data.subs.get(c)?.length ?? 0) + (data.members.get(c)?.length ?? 0);
    return { key: 'class:' + c, name: data.names.get(c)!, folder: count > 0, element: port.id(c), count, icon: 'symbol-class', tooltip: c };
}

function instanceRow(port: ExplorerPort, data: Classes, s: string): ExplorerRow {
    return { key: 'instance:' + s, name: data.names.get(s)!, folder: false, element: port.id(s), icon: 'symbol-object', tooltip: s };
}

/** The paths of class `c`: one for each chain of subclasses from a top row to it. */
function classPaths(data: Classes, c: string): string[][] {
    // Down from the top rows (a subclass cycle has one), only through the classes above `c`; a path repeats no class.
    const above = new Set<string>();
    const up = (x: string) => { if (!above.has(x)) { above.add(x); (data.supers.get(x) ?? []).forEach(up); } };
    up(c);
    const out: string[][] = [];
    const down = (path: string[]) => {
        const last = path[path.length - 1];
        if (last === c) return void out.push(path);
        for (const s of data.subs.get(last) ?? []) if (above.has(s) && !path.includes(s)) down([...path, s]);
    };
    for (const t of data.tops) if (above.has(t)) down([t]);
    return out;
}

const pathOf = (data: Classes, classes: string[], last?: string): ExplorerPath => ({
    keys: ['classes', ...classes.map(c => 'class:' + c), ...(last ? ['instance:' + last] : [])],
    name: ['Classes', ...classes.map(c => data.names.get(c)!)].join(' › ')
});

export const rdfsExplorer: ExplorerPlugin = {
    id: 'rdfs',

    sections(port) {
        const data = classes(port);
        return data.tops.length ? [{ key: 'classes', name: 'Classes', folder: true, count: data.tops.length, icon: 'symbol-class' }] : [];
    },

    children(port, key) {
        const data = classes(port);
        if (key === 'classes') return data.tops.map(c => classRow(port, data, c)).sort(byName);
        if (!key.startsWith('class:')) return [];
        const c = key.slice('class:'.length);
        return [
            ...(data.subs.get(c) ?? []).map(s => classRow(port, data, s)).sort(byName),
            ...(data.members.get(c) ?? []).map(s => instanceRow(port, data, s)).sort(byName)
        ];
    },

    items(port) {
        const data = classes(port);
        return [
            ...[...data.shown].map(c => ({ ...classRow(port, data, c), folder: false, description: 'Class' })),
            ...[...data.types].filter(([s]) => !data.shown.has(s))
                .map(([s, cs]) => ({ ...instanceRow(port, data, s), description: cs.map(c => data.names.get(c)).join(', ') }))
        ];
    },

    paths(port, iri) {
        const data = classes(port);
        const asClass = data.shown.has(iri) ? classPaths(data, iri).map(p => pathOf(data, p)) : [];
        const asInstance = (data.types.get(iri) ?? []).flatMap(c => classPaths(data, c).map(p => pathOf(data, p, iri)));
        return [...asClass, ...asInstance];
    }
};
