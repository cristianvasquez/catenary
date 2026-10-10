import { afterEach, describe, expect, it } from 'vitest';
import { Classes, NS } from '@catenary/model';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from 'rdf-files';
import { MODEL_GRAPH, ModelGraph, VALIDATION_GRAPH, cmp } from '../src/graph';
import { elementId } from '../src/ids';
import { readResults, reportProblems } from '../src/report-read';
import { TracedStore, tracer } from '../src/trace';
import { rdf } from '../src/terms';

afterEach(() => { while (tracer.on) tracer.setClient(false); });

const n = (v: string) => rdf.namedNode(v);
const sh = (local: string) => n(NS.sh + local);
const CLASS = 'urn:x:Thing', PATH = 'urn:x:name', SHAPE = 'urn:x:ThingShape-name';
const meta: Classes = { classes: [{ iri: CLASS, name: 'Thing', shapes: [SHAPE], fields: [], relations: [], unsupported: [], color: '1', labelInShape: false }] };

/**
 * A model of `instances` typed instances (one more without a type), and a report of `results` results: one per instance in turn,
 * alternating a MinCount result on the path (with two messages) and a Class result without a path (sh:value, no message).
 */
function dataset(instances: number, results: number): Quad[] {
    const model = n(MODEL_GRAPH), report = n(VALIDATION_GRAPH), out: Quad[] = [];
    const focus = (i: number) => n(`urn:x:i${String(i).padStart(4, '0')}`);
    for (let i = 0; i < instances; i++) {
        out.push(rdf.quad(focus(i), n(NS.rdf + 'type'), n(CLASS), model), rdf.quad(focus(i), n(NS.rdfs + 'label'), rdf.literal(`Thing ${i}`), model));
    }
    out.push(rdf.quad(focus(instances), n(PATH), rdf.literal('untyped'), model));
    for (let r = 0; r < results; r++) {
        const s = n(`urn:skolem:r${r}`), f = focus(r % (instances + 1));
        out.push(rdf.quad(s, n(NS.rdf + 'type'), sh('ValidationResult'), report), rdf.quad(s, sh('focusNode'), f, report),
            rdf.quad(s, sh('sourceShape'), n(SHAPE), report), rdf.quad(s, sh('resultSeverity'), sh(r % 3 ? 'Violation' : 'Warning'), report));
        if (r % 2) {
            out.push(rdf.quad(s, sh('sourceConstraintComponent'), sh('MinCountConstraintComponent'), report), rdf.quad(s, sh('resultPath'), n(PATH), report),
                rdf.quad(s, sh('resultMessage'), rdf.literal('Second'), report), rdf.quad(s, sh('resultMessage'), rdf.literal('First'), report));
        } else {
            out.push(rdf.quad(s, sh('sourceConstraintComponent'), sh('ClassConstraintComponent'), report), rdf.quad(s, sh('value'), n('urn:x:other'), report));
        }
    }
    return out;
}

describe('report read', () => {
    // The per-result scan of the report quads before this read took 16 s here: the timeout of the test detects it.
    it('reads several hundred results with four queries, in the order focus node, path, message', { timeout: 5000 }, () => {
        const instances = 300, results = 640;
        const g = new ModelGraph(new TracedStore(new OxigraphStore(dataset(instances, results))));
        tracer.setClient(true);
        const shapeId = (t: { value: string }) => t.value === SHAPE ? 'shape-id' : undefined;
        const problems = reportProblems(g, meta, shapeId);
        const queries = tracer.take().spans.filter(s => s.kind === 'sparql');
        expect(queries).toHaveLength(4);
        expect(problems).toHaveLength(results);
        // The order: focus node, then path, then message. The untyped focus node (the last one) has no instance, label or class name.
        const key = (p: { focus: string; path?: string; message: string }) => [p.focus, p.path ?? '', p.message];
        expect(problems.map(key)).toEqual([...problems.map(key)].sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2])));
        const typed = problems.filter(p => p.instance), untyped = problems.filter(p => !p.instance);
        expect(typed).toHaveLength(results - untyped.length);
        expect(untyped.length).toBeGreaterThan(0);
        for (const p of untyped) expect(p).toEqual({ instance: undefined, focus: 'urn:x:i0300', path: p.path, shape: 'shape-id', pathName: p.pathName, severity: p.severity, component: p.component, message: p.message });
        // The results of one focus node (results 1, 302 and 603): no path before a path, the messages joined in order, then the subject order.
        const one = elementId(n('urn:x:i0001'));
        expect(problems.filter(p => p.focus === 'urn:x:i0001')).toEqual([
            { instance: one, focus: 'urn:x:i0001', path: undefined, shape: 'shape-id', pathName: undefined, severity: 'Violation',
                component: 'Class', message: 'Value of has the wrong class: urn:x:other.', label: 'Thing 1', className: 'Thing' },
            { instance: one, focus: 'urn:x:i0001', path: PATH, shape: 'shape-id', pathName: 'name', severity: 'Violation',
                component: 'MinCount', message: 'First Second', label: 'Thing 1', className: 'Thing' },
            { instance: one, focus: 'urn:x:i0001', path: PATH, shape: 'shape-id', pathName: 'name', severity: 'Warning',
                component: 'MinCount', message: 'First Second', label: 'Thing 1', className: 'Thing' }
        ]);
        expect(problems.filter(p => p.severity === 'Warning')).toHaveLength(Math.ceil(results / 3));
        // The same read with a pattern of the Properties panel: the results of one focus node.
        expect(readResults(g, meta, '?r sh:focusNode <urn:x:i0001> .', shapeId)).toEqual(problems.filter(p => p.focus === 'urn:x:i0001'));
    });

    it('is empty without a report', () => {
        const g = new ModelGraph(new TracedStore(new OxigraphStore(dataset(3, 0))));
        tracer.setClient(true);
        expect(reportProblems(g, meta, () => undefined)).toEqual([]);
        expect(tracer.take().spans.filter(s => s.kind === 'sparql')).toHaveLength(1);
    });
});
