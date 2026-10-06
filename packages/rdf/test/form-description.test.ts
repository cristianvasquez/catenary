import { describe, expect, it } from 'vitest';
import { describeQuads, descriptionCommand, descriptionKey, findRelation, formPredicates, primaryClass } from '@catenary/model';
import { describeInstance } from '../../model/test/doc-reference';
import { rdf } from '../src/terms';
import { formData } from '../src/queries';
import { DCT, DPROD, byLabel, doc, example, meta, run } from './helpers';
import { executeCommand } from '../src/commands';

const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

describe('SHACL form description', () => {
    it('the model graph triples give the same description as the read model', async () => {
        const [g, m] = [await example(), await meta()];
        const d = doc(g);
        const inst = d.instances[byLabel(g, 'Product usage data')];
        const ps = formPredicates(primaryClass(m, inst.types)!);
        expect(ps).toContain(LABEL);
        expect(ps).toContain(DPROD + 'inputPort');
        const fromDoc = describeInstance(d, inst, ps);
        expect(descriptionKey(describeQuads(g.modelTriples(), inst.uri, ps))).toBe(descriptionKey(fromDoc));
        expect(descriptionCommand(inst, fromDoc, fromDoc)).toBeUndefined();
    });

    it('the form data query gives the same description as the model graph; without shapes, no link candidates', async () => {
        const [g, m] = [await example(), await meta()];
        const d = doc(g);
        const inst = d.instances[byLabel(g, 'Product usage data')];
        const ps = formPredicates(primaryClass(m, inst.types)!);
        const data = await rdf.io.dataset.fromText('application/n-triples', formData(g, rdf.namedNode(inst.uri)));
        expect(descriptionKey(describeQuads(data, inst.uri, ps))).toBe(descriptionKey(describeQuads(g.modelTriples(), inst.uri, ps)));
        // Link candidates: the example has no shapes graph, so no property shape names a class (sh:class) and there are none.
        // properties.test.ts tests the candidates with shapes.
        expect(new Set([...data].map(q => q.subject.value))).toEqual(new Set([inst.uri]));
    });

    it('a form change becomes one command: fields, relations, label', async () => {
        const [g, m] = [await example(), await meta()];
        const d = doc(g);
        const id = byLabel(g, 'Product usage data');
        const inst = d.instances[id];
        const ps = formPredicates(primaryClass(m, inst.types)!);
        const s = rdf.namedNode(inst.uri);
        const api = d.instances[byLabel(g, 'Events API')];
        const query = d.instances[byLabel(g, 'Query service')];
        // Form output: other description, other label, input ports Events API + Query service (Metrics API removed).
        const quads = g.modelTriples().filter(q => !(q.subject.equals(s) && [DCT + 'description', LABEL, DPROD + 'inputPort'].includes(q.predicate.value)));
        quads.push(rdf.quad(s, rdf.namedNode(DCT + 'description'), rdf.literal('New text')));
        quads.push(rdf.quad(s, rdf.namedNode(LABEL), rdf.literal('Usage metrics ')));
        quads.push(rdf.quad(s, rdf.namedNode(DPROD + 'inputPort'), rdf.namedNode(api.uri)));
        quads.push(rdf.quad(s, rdf.namedNode(DPROD + 'inputPort'), rdf.namedNode(query.uri)));
        const after = describeQuads(quads, inst.uri, ps);

        const command = descriptionCommand(inst, describeInstance(d, inst, ps), after)!;
        expect(command.kind).toBe('setStatements');
        expect(Object.keys(command.kind === 'setStatements' ? command.values : {}).sort()).toEqual([DCT + 'description', LABEL, DPROD + 'inputPort'].sort());

        run(g, m, command);
        const d2 = doc(g);
        expect(d2.instances[id].label).toBe('Usage metrics');
        expect(d2.instances[id].fields[DCT + 'description']).toEqual([{ termType: 'Literal', value: 'New text' }]);
        expect(findRelation(d2, id, DPROD + 'inputPort', api.id)).toBeDefined();
        expect(findRelation(d2, id, DPROD + 'inputPort', query.id)).toBeDefined();
        expect(findRelation(d2, id, DPROD + 'inputPort', byLabel(g, 'Metrics API'))).toBeUndefined();
    });

    it('a relation that the shapes do not permit rejects the command', async () => {
        const [g, m] = [await example(), await meta()];
        const d = doc(g);
        const inst = d.instances[byLabel(g, 'Product usage data')];
        const agent = d.instances[byLabel(g, 'Data Product Owner')];
        const r = executeCommand(g, m, { kind: 'setStatements', id: inst.id, values: { [DPROD + 'inputPort']: [{ termType: 'NamedNode', value: agent.uri }] } });
        expect(r.ok).toBe(false);
    });
});
