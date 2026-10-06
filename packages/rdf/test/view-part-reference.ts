// Reference for test/view-read.test.ts: the view part query before ADR 0007 step 5. The view editor read this part into a store
// and projected it (project.ts); view-read.ts now builds the same Doc from SPARQL rows. Test only.

import { NS } from '@catenary/model';
import type { NamedNode, Quad } from '@rdfjs/types';
import { ModelGraph, P, SKOS_TYPES } from '../src/graph';
import { rdf } from '../src/terms';

const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX view: <${NS.view}> PREFIX skos: <${NS.skos}> PREFIX sh: <${NS.sh}>`;

const iri = (t: NamedNode) => `<${t.value}>`;

/**
 * The quads that one view shows: its view graph, the identity statements of referenced views, and the model statements of its instances.
 * An IRI object that is an instance outside the view is left out (a relation to an element not shown).
 * A view that shows a shape element (a card whose term is a subject of a shapes graph, or a value set of the data file) also gets all
 * shapes graphs and the SKOS vocabulary of the data file (small; an edge can point to any shape, a value set card lists its concepts).
 */
export function viewPart(g: ModelGraph, view: NamedNode): Quad[] {
    const V = iri(view), M = iri(g.model);
    const element = rdf.namedNode(NS.view + 'element');
    // A shape element: a subject of a shapes graph, or a concept scheme or collection of the data file (a value set card).
    const valueSetTypes = SKOS_TYPES.filter(t => !t.value.endsWith('#Concept'));
    const showsShapes = g.match(null, element, null, view)
        .some(q => q.object.termType === 'NamedNode' && (g.match(q.object).some(x => g.isShapesGraph(x.graph))
            || valueSetTypes.some(t => g.match(q.object as NamedNode, P.type, t, g.model).length > 0)));
    // A member of an entity group of the view counts as placed (ADR 0014, C1).
    const member = (x: string, n: string) => `{ GRAPH ${V} { ?${n} a view:Placement ; view:element ?${n}g } GRAPH ?${n}mg { ?${n}g a view:EntityGroup ; view:member ?${x} } }`;
    const inView = (x: string) => `EXISTS { { GRAPH ${V} { ?n_${x} a view:Placement ; view:element ?${x} } } UNION ${member(x, `m_${x}`)} }`;
    const rows = g.store.select(`${PREFIXES}
        SELECT ?g ?s ?p ?o WHERE {
            { GRAPH ${V} { ?s ?p ?o } BIND(${V} AS ?g) }
            UNION
            { GRAPH ${V} { ?ref a view:Placement ; view:element ?target }
              GRAPH ?target { ?s a view:View ; ?p ?o }
              BIND(?target AS ?g) }
            UNION
            { GRAPH ${V} { ?m a view:Placement ; view:element ?s }
              GRAPH ?mg { ?s a ?mt ; ?p ?o }
              FILTER (?mg != ${V} && ?mt IN (view:Frame, view:Note, view:FileRef, view:EntityGroup))
              BIND(?mg AS ?g) }
            UNION
            { GRAPH ${V} { ?m2 a view:Placement ; view:element ?x }
              GRAPH ?mg { ?x a ?mt . ?s a view:View ; ?p ?o }
              FILTER (?mg != ${V} && ?mt IN (view:Frame, view:Note, view:FileRef, view:EntityGroup))
              BIND(?mg AS ?g) }
            UNION
            { GRAPH ${V} { ?ap rdf:reifies <<( ?s view:arrow ?o )>> }
              GRAPH ?ag { ?s view:arrow ?o }
              FILTER (?ag != ${V})
              BIND(view:arrow AS ?p) BIND(?ag AS ?g) }
            UNION
            { GRAPH ${V} { ?ap2 rdf:reifies <<( ?ax view:arrow ?ay )>> }
              GRAPH ?ag { ?ax view:arrow ?ay . ?s a view:View ; ?p ?o }
              FILTER (?ag != ${V})
              BIND(?ag AS ?g) }
            UNION
            { { GRAPH ${V} { ?n a view:Placement ; view:element ?s } } UNION ${member('s', 'ms')}
              GRAPH ${M} { ?s ?p ?o }
              FILTER (!isIRI(?o) || NOT EXISTS { GRAPH ${M} { ?o rdf:type|rdfs:label ?any } } || ${inView('o')})
              BIND(${M} AS ?g) }
        }`);
    const part = rows.map(r => rdf.quad(r.s as Quad['subject'], r.p as Quad['predicate'], r.o as Quad['object'], r.g as NamedNode));
    return showsShapes ? [...part, ...g.shapesAndVocabulary()] : part;
}

