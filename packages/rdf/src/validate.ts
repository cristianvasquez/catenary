// SHACL validation of the model graph with shacl-engine.

import { Classes, NS, Problem, Violation, localName, predicateName, primaryClass } from '@catenary/model';
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import { Validator } from 'shacl-engine';
import { ModelGraph, VALIDATION_GRAPH, cmp } from './graph';
import { elementId } from './ids';
import { skolemize } from './skolem';
import type { Metamodel } from './shapes';
import { rdf } from './terms';
import { construct, iri, labels, statements, things } from './sparql';

/**
 * Validate the triples of the model graph against the shapes.
 * `instanceId` gives the element id of a focus node IRI (undefined if it is not an instance); `shapeId` the property shape id of a
 * source shape term.
 */
export async function validate(triples: Quad[], meta: Metamodel, instanceId: (iri: string) => string | undefined,
    shapeId: (shape: Term) => string | undefined = () => undefined): Promise<Violation[]> {
    return (await validateWithReport(triples, meta, instanceId, shapeId)).violations;
}

/**
 * SPARQL filter: `v` is a predicate path, a node without a path operator and not a list. The structure decides, not the term type
 * (the store has no blank nodes). Use it inside the graph of `v`.
 */
export const PREDICATE_PATH = (v: string) => `FILTER (isIRI(${v}) && NOT EXISTS { ${v} ?_op ?_x FILTER (?_op IN (<${NS.sh}inversePath>, <${NS.sh}alternativePath>,
    <${NS.sh}zeroOrMorePath>, <${NS.sh}oneOrMorePath>, <${NS.sh}zeroOrOnePath>, <${NS.rdf}first>)) })`;

/** `validate`, and the SHACL report as quads of `VALIDATION_GRAPH`. The blank nodes of the report get skolem IRIs (skolem.ts). */
export async function validateWithReport(triples: Quad[], meta: Metamodel, instanceId: (iri: string) => string | undefined,
    shapeId: (shape: Term) => string | undefined = () => undefined): Promise<{ violations: Violation[]; report: Quad[] }> {
    if (meta.dataset.size === 0) return { violations: [], report: [] };
    const { results, report } = await shaclReport(meta.dataset, [...triples, ...inSchemeTriples(meta)]);
    return { violations: violationsOf(results, meta, instanceId, shapeId), report: reportQuads(report) };
}

/** The concepts are in the shapes files: a scheme shape (sh:node, skos:inScheme sh:hasValue S) needs their schemes in the data. */
export function inSchemeTriples(meta: Metamodel): Quad[] {
    return (meta.concepts ?? []).flatMap(c => c.schemes.map(s => rdf.quad(rdf.namedNode(c.iri), rdf.namedNode(NS.skos + 'inScheme'), rdf.namedNode(s))));
}

/** A result of a SHACL report as plain values (a worker thread can send it): IRIs and literal values, not terms. */
export interface ShaclResult {
    focus: string;
    /** The predicate of a result path that is one predicate, else undefined. */
    path?: string;
    component: string;
    severity: string;
    messages: string[];
    value?: string;
    /** The source shape: an IRI (the store has no blank nodes). */
    source?: string;
}

/** Run shacl-engine: the results as plain values and the report dataset. Pure: the worker thread runs it too (validation-worker.ts). */
export async function shaclReport(shapes: Iterable<Quad>, data: Iterable<Quad>): Promise<{ results: ShaclResult[]; report: Quad[] }> {
    const validator = new Validator(rdf.dataset([...shapes]), { factory: rdf });
    const report = await validator.validate({ dataset: rdf.dataset([...data]) });
    const results = report.results.map((r): ShaclResult => {
        const step = r.path?.length === 1 && r.path[0].start !== 'object' ? r.path[0] : undefined;
        const source = r.shape?.ptr?.term;
        const value = r.value?.value ?? r.value?.term?.value;
        return {
            focus: r.focusNode?.value ?? r.focusNode?.term?.value ?? '', path: step?.predicates?.[0]?.value,
            component: r.constraintComponent?.value ?? '', severity: r.severity?.value ?? NS.sh + 'Violation',
            messages: r.message?.map(m => m.value) ?? [], ...(value !== undefined ? { value } : {}),
            ...(source?.termType === 'NamedNode' ? { source: source.value } : {})
        };
    });
    return { results, report: [...report.dataset] };
}

/** The violations of the results, sorted by focus node and path. */
export function violationsOf(results: ShaclResult[], meta: Metamodel, instanceId: (iri: string) => string | undefined,
    shapeId: (shape: Term) => string | undefined = () => undefined): Violation[] {
    const violations = results.map((r): Violation => {
        const component = localName(r.component).replace(/ConstraintComponent$/, '');
        const severity = localName(r.severity) as Violation['severity'];
        const pathName = r.path ? predicateName(meta, r.path) : undefined;
        const message = r.messages.join(' ') || defaultMessage(component, pathName, r.value);
        const shape = r.source ? shapeId(rdf.namedNode(r.source)) : undefined;
        return { instance: instanceId(r.focus), focus: r.focus, path: r.path, ...(shape ? { shape } : {}), pathName, severity, component, message };
    });
    return violations.sort((a, b) => a.focus.localeCompare(b.focus) || (a.path ?? '').localeCompare(b.path ?? ''));
}

/** The report dataset as quads of VALIDATION_GRAPH, its blank nodes replaced by IRIs (skolem.ts). */
export function reportQuads(report: Iterable<Quad>): Quad[] {
    const graph = rdf.namedNode(VALIDATION_GRAPH);
    return skolemize([...report]).quads.map(q => rdf.quad(q.subject, q.predicate, q.object, graph));
}

/** The message of a result without sh:resultMessage. */
export function defaultMessage(component: string, pathName?: string, value?: string): string {
    const on = pathName ? ` "${pathName}"` : '';
    switch (component) {
        case 'MinCount': return `Required${on} is missing.`;
        case 'MaxCount': return `Too many values for${on}.`;
        case 'Class': return `Value of${on} has the wrong class${value ? `: ${value}` : ''}.`;
        case 'Datatype': return `Value of${on} has the wrong datatype.`;
        case 'In': return `Value of${on} is not in the permitted list.`;
        default: return `${component} constraint failed${on}.`;
    }
}

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
