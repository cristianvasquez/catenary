// The validator (spec/manifest.hs §9 validator): SHACL with shacl-engine, data quads and shape quads in, the report out. Pure: it reads
// nothing from the store or the workspace. ModelStore builds the input (validation-data.ts), validation-runner.ts writes the report graph,
// and the worker thread runs the same function (validation-worker.ts). The report read of the panels is in report-read.ts.

import { Classes, NS, Violation, localName, predicateName } from '@catenary/model';
import type { Quad, Term } from '@rdfjs/types';
import { Validator } from 'shacl-engine';
import { skolemize } from './skolem';
import { rdf } from './terms';

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

/** What the validator gives: the results as plain values, and the report as triples with skolem IRIs for its blank nodes (skolem.ts). */
export interface ValidationReport {
    results: ShaclResult[];
    report: Quad[];
}

/** Validate `data` against `shapes` (graphs are ignored). No shapes: an empty report (§9 law_validatorNoShapes). */
export async function validate(data: Iterable<Quad>, shapes: Iterable<Quad>): Promise<ValidationReport> {
    const shapeQuads = [...shapes];
    if (!shapeQuads.length) return { results: [], report: [] };
    const validator = new Validator(rdf.dataset(shapeQuads), { factory: rdf });
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
    return { results, report: skolemize([...report.dataset]).quads.map(q => rdf.quad(q.subject, q.predicate, q.object)) };
}

/**
 * The violations of the results, sorted by focus node and path. `meta` names the paths; `instanceId` gives the element id of a focus
 * node IRI (undefined if it is not an instance); `shapeId` the property shape id of a source shape term.
 */
export function violationsOf(results: ShaclResult[], meta: Classes, instanceId: (iri: string) => string | undefined,
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
