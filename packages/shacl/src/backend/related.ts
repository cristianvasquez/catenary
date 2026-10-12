// The "Same target class" section of the Links tab (ui-manifest §8.8 sameTargetClass): the other node shapes that target a class of
// the selected node shapes. Purpose: find shapes to merge. Target forms: sh:targetClass, and the implicit class target (the node
// shape is also an rdfs:Class or owl:Class). Subclass targets and sh:targetNode overlap are not in it (open.md).

import { ExplorerPort, OWL, RDF, RDFS, RelatedProvider, RelatedRow, SH } from '@catenary/contracts';

const PREFIXES = `PREFIX sh: <${SH}> PREFIX rdf: <${RDF}> PREFIX rdfs: <${RDFS}> PREFIX owl: <${OWL}>`;

/**
 * Node shape -> its target classes, by both target forms. One query for the request. A node shape as the host reads it
 * (shapes-read.ts): rdf:type sh:NodeShape, a target, sh:node, sh:property or a logical constraint, or the object of sh:node, and no
 * sh:path. The object of sh:node needs a target class here, so it has statements.
 */
function targetClasses(port: ExplorerPort): Map<string, Set<string>> {
    return port.memo('shacl-target-classes', () => {
        const classes = new Map<string, Set<string>>();
        for (const r of port.select(`${PREFIXES} SELECT DISTINCT ?s ?c WHERE {
                { ${port.graph('?s rdf:type sh:NodeShape', '?g1')} }
                UNION { ${port.graph('?s sh:targetClass|sh:targetSubjectsOf|sh:targetObjectsOf|sh:targetNode|sh:node|sh:property|sh:or|sh:xone|sh:and|sh:not ?x', '?g1')} }
                UNION { ${port.graph('?r sh:node ?s', '?g1')} }
                { ${port.graph('?s sh:targetClass ?c', '?g2')} }
                UNION { ${port.graph('?s rdf:type ?k', '?g2')} VALUES ?k { rdfs:Class owl:Class } BIND (?s AS ?c) }
                FILTER NOT EXISTS { ${port.graph('?s sh:path ?path', '?g3')} }
                FILTER (isIRI(?s) && isIRI(?c)) }`)) {
            const set = classes.get(r.s.value) ?? classes.set(r.s.value, new Set()).get(r.s.value)!;
            set.add(r.c.value);
        }
        return classes;
    });
}

/** The node shapes that share a target class with the selected shapes, without the selected shapes. Shape -> the shared classes. */
function sameTargetClass(classes: Map<string, Set<string>>, selected: Set<string>): Map<string, string[]> {
    const wanted = new Set([...classes].filter(([s]) => selected.has(s)).flatMap(([, cs]) => [...cs]));
    const found = new Map<string, string[]>();
    for (const [s, cs] of classes) {
        if (selected.has(s)) continue;
        const shared = [...cs].filter(c => wanted.has(c)).sort();
        if (shared.length) found.set(s, shared);
    }
    return found;
}

export const shaclRelated: RelatedProvider = {
    id: 'shacl',

    related(port, elements) {
        const classes = targetClasses(port);
        const ids = new Set(elements);
        const selected = new Set([...classes.keys()].filter(s => ids.has(port.id(s))));
        if (!selected.size) return [];
        // The port gives no file of a graph: the description has the class only.
        const rows: RelatedRow[] = [...sameTargetClass(classes, selected)].sort(([a], [b]) => a.localeCompare(b))
            .map(([s, shared]) => ({ element: port.id(s), description: shared.map(port.compact).join(', '), tooltip: s }));
        return rows.length ? [{ key: 'same-target-class', title: 'Same target class', rows }] : [];
    }
};
