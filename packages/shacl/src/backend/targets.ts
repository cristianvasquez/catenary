import type { FocusNode, TargetKind, TargetMatch } from '../common';

export interface QueryTerm {
    termType: string;
    value: string;
    language?: string;
    datatype?: { value: string };
}

/** The host owns the RDF store and graph identities. This package owns the query. */
export interface TargetQueryPort {
    select(query: string): readonly Record<string, QueryTerm>[];
}

export interface TargetScope {
    shapes: readonly string[];
    data: readonly string[];
}

export interface TargetSelection {
    nodes?: readonly FocusNode[];
    shapes?: readonly string[];
}

const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

export function iri(value: string): string {
    if (/[<>"{}|^`\\\s\u0000-\u001f]/.test(value)) throw new Error('Invalid IRI in SHACL query.');
    return `<${value}>`;
}

export function term(node: FocusNode): string {
    if (node.termType === 'NamedNode') return iri(node.value);
    if (node.language && !/^[a-z]+(?:-[a-z0-9]+)*$/i.test(node.language)) throw new Error('Invalid literal language in SHACL query.');
    return JSON.stringify(node.value) + (node.language ? `@${node.language}` : node.datatype ? `^^${iri(node.datatype)}` : '');
}

export function focus(node: QueryTerm): FocusNode {
    if (node.termType !== 'NamedNode' && node.termType !== 'Literal') throw new Error('SHACL query returned an unsupported term.');
    return { termType: node.termType, value: node.value,
        ...(node.language ? { language: node.language } : node.datatype && node.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string' ? { datatype: node.datatype.value } : {}) };
}

/** One relation supplies both navigation directions. Graph unions also support split subclass chains. */
export function targetMatches(port: TargetQueryPort, scope: TargetScope, selection: TargetSelection): TargetMatch[] {
    if (!scope.shapes.length || !scope.data.length || selection.nodes?.length === 0 || selection.shapes?.length === 0) return [];
    const dataset = [...new Set(scope.data)].map(g => `FROM ${iri(g)}`).join(' ');
    const named = [...new Set(scope.shapes)].map(g => `FROM NAMED ${iri(g)}`).join(' ');
    const declaration = (predicate: string) => `GRAPH ?sg { ?shape sh:${predicate} ?target }`;
    const rows = port.select(`PREFIX sh: <${SH}> PREFIX rdf: <${RDF}> PREFIX rdfs: <${RDFS}>
        SELECT DISTINCT ?shape ?node ?kind ?target ${dataset} ${named} WHERE {
            ${selection.nodes ? `VALUES ?node { ${selection.nodes.map(term).join(' ')} }` : ''}
            ${selection.shapes ? `VALUES ?shape { ${selection.shapes.map(iri).join(' ')} }` : ''}
            {
                { ${declaration('targetClass')} ?node rdf:type/rdfs:subClassOf* ?target . BIND ("targetClass" AS ?kind) }
                UNION { GRAPH ?sg { ?shape a sh:NodeShape, rdfs:Class } BIND (?shape AS ?target)
                    ?node rdf:type/rdfs:subClassOf* ?target . BIND ("implicitClass" AS ?kind) }
                UNION { ${declaration('targetNode')} BIND (?target AS ?node) BIND ("targetNode" AS ?kind) }
                UNION { ${declaration('targetSubjectsOf')} ?node ?target ?object . BIND ("targetSubjectsOf" AS ?kind) }
                UNION { ${declaration('targetObjectsOf')} ?subject ?target ?node . BIND ("targetObjectsOf" AS ?kind) }
            }
            FILTER (isIRI(?shape))
        }`);
    const result = new Map<string, TargetMatch>();
    for (const row of rows) {
        const node = focus(row.node), target = focus(row.target);
        const key = JSON.stringify([row.shape.value, node]);
        const match = result.get(key) ?? { shape: row.shape.value, node, reasons: [] };
        match.reasons.push({ kind: row.kind.value as TargetKind, target });
        result.set(key, match);
    }
    for (const match of result.values()) match.reasons.sort((a, b) => a.kind.localeCompare(b.kind) || JSON.stringify(a.target).localeCompare(JSON.stringify(b.target)));
    return [...result.values()].sort((a, b) => a.shape.localeCompare(b.shape) || JSON.stringify(a.node).localeCompare(JSON.stringify(b.node)));
}
