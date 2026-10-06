// Resolve window selection IDs from RDF facts. The shapes index only translates existing UI identities.

import type { NamedNode } from '@rdfjs/types';
import { ElementKind, ModelSelection, NS, Selected, emptySelected, searchKind } from '@catenary/model';
import { ModelGraph } from './graph';
import { elementId, elementTerm, relationId, relationTriple } from './ids';
import type { ShapesIndex } from './shapes-read';
import { construct, connections, graphStatements, iri, statements, things } from './sparql';
import { rdf, termKey } from './terms';

const buckets: Record<ElementKind, keyof Pick<Selected, 'instances' | 'relations' | 'views' | 'groups' | 'notes' | 'references' | 'collections' | 'arrows' | 'shapes' | 'properties' | 'constraints' | 'valueSets'>> = {
    instance: 'instances', relation: 'relations', view: 'views', group: 'groups', note: 'notes', reference: 'references',
    collection: 'collections', arrow: 'arrows', shape: 'shapes', property: 'properties', constraint: 'constraints', valueSet: 'valueSets'
};
const marks: Record<string, ElementKind> = {
    [NS.view + 'Frame']: 'group', [NS.view + 'Note']: 'note', [NS.view + 'FileRef']: 'reference', [NS.view + 'EntityGroup']: 'collection'
};

/** Preserve placement IDs in `ids`, but resolve cards and edges to their element IDs in `elements`. */
export function selected(g: ModelGraph, index: ShapesIndex, selection: ModelSelection): Selected {
    const answer: Selected = { ...emptySelected(), view: undefined };
    const viewTerm = selection.view ? elementTerm(selection.view) : undefined;
    const viewData = viewTerm ? graphStatements(g, viewTerm.value) : [];
    if (viewTerm && viewData.some(q => q.subject.equals(viewTerm) && q.predicate.value === NS.rdf + 'type' && q.object.value === NS.view + 'View')) answer.view = selection.view;
    const scoped = answer.view ? viewData : [];
    const first = (s: string, p: string) => scoped.find(q => q.subject.value === s && q.predicate.value === p)?.object;
    const candidates = [...new Set(selection.ids)].map(id => {
        const term = elementTerm(id);
        const placed = term && scoped.some(q => q.subject.equals(term) && q.predicate.value === NS.rdf + 'type' && q.object.value === NS.view + 'Placement');
        return { id, term, target: placed ? first(term!.value, NS.view + 'element') : undefined, triple: placed ? first(term!.value, NS.rdf + 'reifies') : undefined };
    });
    const iris = [...new Set(candidates.flatMap(c => [c.target?.termType === 'NamedNode' ? c.target.value : c.term?.value].filter((s): s is string => !!s)))];
    const facts = statements(g, iris);
    const types = new Map<string, string[]>();
    if (iris.length) for (const q of construct(g, `CONSTRUCT { ?s rdf:type ?type } WHERE {
        VALUES ?s { ${iris.map(iri).join(' ')} } { ${things()} }
    }`)) types.set(q.subject.value, [...(types.get(q.subject.value) ?? []), q.object.value]);
    const identity = (s: string) => index.byTerm.get(termKey(rdf.namedNode(s))) ?? elementId(rdf.namedNode(s));
    const kind = (id: string, s?: string): ElementKind | undefined => {
        if (index.model.nodeShapes[id]) return 'shape';
        if (index.model.valueSets[id]) return 'valueSet';
        if (index.model.properties[id]) return 'property';
        if (index.model.constraints[id]) return 'constraint';
        const ts = s ? types.get(s) : undefined;
        if (!ts) return undefined;
        const k = searchKind(ts);
        return k === 'predicate' ? undefined : k;
    };
    for (const c of candidates) {
        let element = c.id;
        let k: ElementKind | undefined;
        if (c.target?.termType === 'NamedNode') {
            const targetTypes = facts.filter(q => q.subject.value === c.target!.value && q.predicate.value === NS.rdf + 'type').map(q => q.object.value);
            k = targetTypes.map(t => marks[t]).find(Boolean);
            if (!k && targetTypes.includes(NS.view + 'View')) k = 'reference';
            if (!k) { element = identity(c.target.value); k = kind(element, c.target.value); }
        } else {
            const triple = c.triple?.termType === 'Quad' && c.triple.subject.termType === 'NamedNode' && c.triple.object.termType === 'NamedNode'
                ? { s: c.triple.subject, p: c.triple.predicate as NamedNode, o: c.triple.object } : relationTriple(c.id);
            if (triple) {
                const { s, p, o } = triple;
                if (c.triple && p.value === NS.view + 'arrow') k = 'arrow';
                else if (construct(g, `CONSTRUCT { ${iri(s.value)} ${iri(p.value)} ${iri(o.value)} } WHERE {
                    ${connections(iri(s.value), iri(p.value), iri(o.value))}
                }`).length) { element = relationId(s, p, o); k = 'relation'; }
            } else k = kind(c.id, c.term?.value);
        }
        if (!k) continue;
        answer.ids.push(c.id);
        if (!answer.elements.includes(element)) {
            answer.elements.push(element);
            answer[buckets[k]].push(element);
        }
    }
    return answer;
}
