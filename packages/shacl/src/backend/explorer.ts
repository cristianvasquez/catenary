// The Shapes section of the Model explorer: each node shape with its property shapes (sh:property and the members of sh:or,
// sh:xone and sh:and lists). The rows show the statements as they are written: a property shape by its sh:name, else its path.

import { ExplorerPath, ExplorerPlugin, ExplorerPort, ExplorerRow, byName } from '@catenary/explorer';
import { RDF, SH } from '@catenary/query';

const PREFIXES = `PREFIX sh: <${SH}> PREFIX rdf: <${RDF}>`;
const FACTS = ['path', 'name', 'datatype', 'class', 'node', 'minCount', 'maxCount', 'order'] as const;

interface Property { iri: string; facts: Partial<Record<typeof FACTS[number], string>> }

interface Shapes {
    /** Node shape in scope -> its property shapes. */
    shapes: Map<string, Property[]>;
    /** Property shape -> its node shapes. */
    owners: Map<string, string[]>;
    names: Map<string, string>;
}

function read(port: ExplorerPort): Shapes {
    return port.memo('shacl', () => {
        const shapes = new Map<string, Property[]>();
        for (const r of port.select(`${PREFIXES} SELECT DISTINCT ?s WHERE { { ${port.graph('?s rdf:type sh:NodeShape')} } UNION { ${port.graph('?s sh:property ?p')} } FILTER (isIRI(?s)) }`)) {
            if (port.inScope(r.s.value)) shapes.set(r.s.value, []);
        }
        const properties = new Map<string, Property>(), owners = new Map<string, string[]>();
        for (const r of port.select(`${PREFIXES} SELECT ?s ?p ?k ?v WHERE {
                ${port.graph('?s sh:property|((sh:or|sh:xone|sh:and)/rdf:rest*/rdf:first) ?p')}
                ${port.graph('?p sh:path ?path', '?g1')}
                OPTIONAL { ${port.graph('?p ?k ?v', '?g2')} VALUES ?k { ${FACTS.map(f => 'sh:' + f).join(' ')} } } }`)) {
            // Both in scope: a property shape that another file states is a reference only.
            const list = shapes.get(r.s.value);
            if (!list || !port.inScope(r.p.value)) continue;
            let p = properties.get(r.p.value);
            if (!p) properties.set(r.p.value, p = { iri: r.p.value, facts: {} });
            if (!list.includes(p)) list.push(p);
            const o = owners.get(p.iri) ?? [];
            if (!o.includes(r.s.value)) owners.set(p.iri, [...o, r.s.value]);
            if (r.k) p.facts[r.k.value.slice(SH.length) as typeof FACTS[number]] ??= r.v.value;
        }
        return { shapes, owners, names: port.labels([...shapes.keys(), ...properties.keys()]) };
    });
}

function shapeRow(port: ExplorerPort, data: Shapes, s: string): ExplorerRow {
    const count = data.shapes.get(s)!.length;
    return { key: 'shape:' + s, name: data.names.get(s)!, folder: count > 0, element: port.id(s), count, icon: 'symbol-ruler', tooltip: s };
}

/** The range and the cardinality of a property shape, as written: `string [1..*]`. */
function propertyRow(port: ExplorerPort, data: Shapes, p: Property): ExplorerRow {
    const { path, name, datatype, class: cls, node, minCount, maxCount } = p.facts;
    const range = [datatype, cls, node].filter((x): x is string => !!x).map(port.compact).join(' ');
    const card = minCount === undefined && maxCount === undefined ? '' : `[${minCount ?? 0}..${maxCount ?? '*'}]`;
    return {
        key: 'property:' + p.iri, name: name ?? (path && !path.startsWith('urn:skolem:') ? port.compact(path) : data.names.get(p.iri)!), folder: false, element: port.id(p.iri),
        icon: cls || node ? 'arrow-right' : 'symbol-field', description: [range, card].filter(Boolean).join(' ') || undefined, tooltip: p.iri
    };
}

/** sh:order as a number; none or not a number: last. */
const order = (p: Property) => { const n = Number(p.facts.order ?? NaN); return Number.isFinite(n) ? n : Infinity; };

export const shaclExplorer: ExplorerPlugin = {
    id: 'shacl',

    sections(port) {
        const { shapes } = read(port);
        return shapes.size ? [{ key: 'shapes', name: 'Shapes', folder: true, count: shapes.size, icon: 'symbol-ruler' }] : [];
    },

    children(port, key) {
        const data = read(port);
        if (key === 'shapes') return [...data.shapes.keys()].map(s => shapeRow(port, data, s)).sort(byName);
        if (!key.startsWith('shape:')) return [];
        const rows = (data.shapes.get(key.slice('shape:'.length)) ?? []).map(p => ({ p, row: propertyRow(port, data, p) }));
        return rows.sort((a, b) => order(a.p) - order(b.p) || byName(a.row, b.row)).map(r => r.row);
    },

    items(port) {
        const data = read(port);
        const properties = new Map<string, Property>();
        for (const list of data.shapes.values()) for (const p of list) properties.set(p.iri, p);
        return [
            ...[...data.shapes.keys()].map(s => ({ ...shapeRow(port, data, s), folder: false, description: 'Node shape' })),
            ...[...properties.values()].map(p => ({ ...propertyRow(port, data, p), description: data.owners.get(p.iri)!.map(s => data.names.get(s)).join(', ') }))
        ];
    },

    paths(port, iri) {
        const data = read(port);
        const path = (shape: string, property?: string): ExplorerPath => ({
            keys: ['shapes', 'shape:' + shape, ...(property ? ['property:' + property] : [])], name: 'Shapes › ' + data.names.get(shape)
        });
        if (data.shapes.has(iri)) return [path(iri)];
        return (data.owners.get(iri) ?? []).filter(s => data.shapes.has(s)).map(s => path(s, iri));
    }
};
