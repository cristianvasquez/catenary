// The read of the SHACL report graph (ADR 0007) for Problems and Properties. The report comes from the validator (validate.ts) through
// validation-runner.ts.

import { Classes, NS, Problem, Violation, localName, predicateName, primaryClass } from '@catenary/model';
import type { NamedNode, Term } from '@rdfjs/types';
import { ModelGraph, VALIDATION_GRAPH, cmp } from './graph';
import { elementId } from './ids';
import { construct, iri, labels, statements, things } from './sparql';
import { defaultMessage } from './validate';

/**
 * SPARQL filter: `v` is a predicate path, a node without a path operator and not a list. The structure decides, not the term type
 * (the store has no blank nodes). Use it inside the graph of `v`.
 */
export const PREDICATE_PATH = (v: string) => `FILTER (isIRI(${v}) && NOT EXISTS { ${v} ?_op ?_x FILTER (?_op IN (<${NS.sh}inversePath>, <${NS.sh}alternativePath>,
    <${NS.sh}zeroOrMorePath>, <${NS.sh}oneOrMorePath>, <${NS.sh}zeroOrOnePath>, <${NS.rdf}first>)) })`;

/**
 * The results of the report graph (ADR 0007), as `validate` gives them: a path only when the result path is a predicate; the message
 * of the shape (sh:resultMessage), else the default message of the component. Each result of an instance has the label (rdfs:label,
 * else skos:prefLabel, else from the IRI) and class name of the instance. `shapeId`: the property shape id of a source shape term.
 */
export function reportProblems(g: ModelGraph, meta: Classes, shapeId: (shape: Term) => string | undefined): Problem[] {
    return readResults(g, meta, '?r sh:focusNode ?f .', shapeId);
}

/** Shared report read for Problems and Properties. Report triples do not enter the data queries. */
export function readResults(g: ModelGraph, meta: Classes, pattern = '?r sh:focusNode ?f .',
    shapeId: (shape: Term) => string | undefined = () => undefined): Problem[] {
    const quads = construct(g, `CONSTRUCT { ?r ?p ?o } WHERE { GRAPH <${VALIDATION_GRAPH}> {
        ${pattern} ?r sh:focusNode ?focus ; ?p ?o .
        OPTIONAL { ?r sh:resultPath ?path ${PREDICATE_PATH('?path')} }
        FILTER (?p != sh:resultPath || ?o = ?path)
    } }`);
    const subjects = [...new Set(quads.map(q => q.subject.value))].sort(cmp);
    const values = (s: string, p: string) => quads.filter(q => q.subject.value === s && q.predicate.value === NS.sh + p).map(q => q.object).sort((a, b) => cmp(a.value, b.value));
    const focus = [...new Set(subjects.flatMap(s => values(s, 'focusNode').filter(t => t.termType === 'NamedNode').map(t => t.value)))];
    const typed = focus.length ? construct(g, `CONSTRUCT { ?s rdf:type ?type } WHERE {
        VALUES ?s { ${focus.map(iri).join(' ')} } { ${things()} }
    }`) : [];
    const known = new Set(typed.map(q => q.subject.value));
    const facts = statements(g, focus);
    const names = labels(g, focus);
    return subjects.map((s): Problem => {
        const f = values(s, 'focusNode')[0];
        const path = values(s, 'resultPath')[0]?.value;
        const source = values(s, 'sourceShape')[0];
        const shape = source ? shapeId(source) : undefined;
        const component = localName(values(s, 'sourceConstraintComponent')[0]?.value ?? '').replace(/ConstraintComponent$/, '');
        const severity = localName(values(s, 'resultSeverity')[0]?.value ?? NS.sh + 'Violation') as Violation['severity'];
        const pathName = path ? predicateName(meta, path) : undefined;
        const messages = values(s, 'resultMessage').map(t => t.value);
        const message = messages.join(' ') || defaultMessage(component, pathName, values(s, 'value')[0]?.value);
        const types = facts.filter(q => q.subject.value === f.value && q.predicate.value === NS.rdf + 'type').map(q => q.object.value).sort(cmp);
        return {
            instance: known.has(f.value) ? elementId(f as NamedNode) : undefined, focus: f.value, path,
            ...(shape ? { shape } : {}), pathName, severity, component, message,
            ...(known.has(f.value) ? {
                label: names.get(f.value)!, className: primaryClass(meta, types)?.name ?? (types.map(t => t.replace(/^.*[#/:]/, '')).join(', ') || 'no type')
            } : {})
        };
    }).sort((a, b) => cmp(a.focus, b.focus) || cmp(a.path ?? '', b.path ?? '') || cmp(a.message, b.message));
}
