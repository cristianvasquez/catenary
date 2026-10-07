import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NS, boxes } from '@catenary/model';
import { elementId } from '../src/ids';
import { renameElement } from '../src/elements';
import * as ops from '../src/ops';
import { project } from './project-full';
import { rdf } from '../src/terms';
import { canonical as canonicalOf, parseTrig, writeTrig } from '../src/trig';
import { validate } from '../src/validate';
import { DCT, MODEL, byLabel, doc, example, load, meta, value } from './helpers';

/** scripts/rdf-query.cjs: Oxigraph, a parser independent of the one that Catenary writes with. */
const rdfQuery = createRequire(join(process.cwd(), 'package.json'))('./scripts/rdf-query.cjs') as { rows(files: string | string[], query: string): Record<string, string>[] };

const canonical = async (text: string) => canonicalOf((await parseTrig(text)).quads);
const validateGraph = (g: Awaited<ReturnType<typeof load>>, m: Awaited<ReturnType<typeof meta>>) =>
    validate(g.modelTriples(), m, iri => (g.isInstance(rdf.namedNode(iri)) ? elementId(rdf.namedNode(iri)) : undefined));

describe('TriG round trip', () => {
    it('open then save with no change gives the same bytes; the dataset has no blank nodes', async () => {
        const g = await example();
        expect(project(g).warnings).toEqual([]);
        expect(g.quads().some(q => q.subject.termType === 'BlankNode' || q.object.termType === 'BlankNode')).toBe(false);
        const saved = await writeTrig(g.quads());
        expect(await writeTrig((await load(saved)).quads())).toBe(saved);
        expect(await canonical(saved)).toBe(await canonical(await writeTrig((await example()).quads())));
    });

    it('output does not depend on the order of the quads', async () => {
        const { quads } = await parseTrig(MODEL);
        const written = await writeTrig(quads);
        expect(await writeTrig([...quads].reverse())).toBe(written);
    });

    it('save, reload, save gives identical files after edits', async () => {
        const m = await meta();
        const g = await example();
        const v = value(ops.createView(g, 'Ownership'));
        const dp = byLabel(g, 'Product usage data');
        ops.addToView(g, v, dp, { x: 10.4, y: -20.6 });
        ops.addToView(g, v, byLabel(g, 'Data Product Owner'), { x: -600, y: 0 });
        const rel = Object.values(doc(g).relations).find(r => r.subject === dp && r.predicate.endsWith('dataProductOwner'))!;
        ops.hideEdge(g, v, rel.id, true);
        value(ops.setStatements(g, m, dp, {
            [DCT + 'description']: [{ termType: 'Literal', value: 'Line 1\nLine "2"', language: 'en' }],
            'http://ex.org/n': [{ termType: 'Literal', value: '4', datatype: 'http://www.w3.org/2001/XMLSchema#integer' }]
        }));
        value(ops.setUri(g, byLabel(g, 'Events API'), 'https://api.example.org/events'));
        value(ops.createRelation(g, m, byLabel(g, 'Agent / chatbot'), 'osg://vocab/data-product-draft#uses', byLabel(g, 'Reports - CSV')));

        const first = await writeTrig(g.quads());
        const back = await load(first);
        expect(await writeTrig(back.quads())).toBe(first);
        const d = doc(back);
        const view = d.views[byLabel(back, 'Ownership')];
        expect(view.edges).toHaveLength(1);
        expect(view.edges[0].hidden).toBe(true);
        expect(boxes(view, 'card').find(n => n.element === byLabel(back, 'Product usage data'))).toMatchObject({ x: 10, y: -21 });
    });

    it('keeps statements that the read model does not show (lossless)', async () => {
        const text = `<urn:name:model> {
            <urn:a> a <http://ex.org/C> ; <http://ex.org/p> [ <http://ex.org/q> 1 ] ;
                <http://www.w3.org/2000/01/rdf-schema#label> "A", "A2" .
            <urn:plain> <http://ex.org/p> "no type, no label" .
        }
        <urn:other> { <urn:x> <http://ex.org/p> <urn:y> . }`;
        const g = await load(text);
        const p = project(g);
        expect(Object.values(p.doc.instances).map(i => i.label)).toEqual(['A']);
        expect(p.warnings.length).toBeGreaterThan(0);
        renameElement(g, byLabel(g, 'A'), 'B');
        const out = await writeTrig(g.quads());
        const back = rdf.dataset((await parseTrig(out)).quads);
        expect(back.size).toBe(rdf.dataset((await parseTrig(text)).quads).size - 1);   // "A" and "A2" became "B"
        expect(out).toContain('no type, no label');
        expect(out).toContain('<urn:other>');
        expect(await canonical(await writeTrig(back))).toBe(await canonical(out));
    });

    it('groups: a view:Frame mark and its placement, read back; removing the last placement deletes the mark', async () => {
        const g = await example();
        expect(boxes(doc(g).views[byLabel(g, 'Product context')], 'group').map(x => x.label)).toEqual(
            ['Source systems', 'Consumer-facing contract', 'Consumers / applications']);
        const ctx = value(ops.createView(g, 'Grouped'));
        ops.addToView(g, ctx, byLabel(g, 'Query service'), { x: 0, y: 0 });
        value(ops.createGroup(g, ctx, 'Upstream sources', { x: -1150, y: -150, width: 670, height: 690 }));
        value(ops.createGroup(g, ctx, 'Consumer-facing contract', { x: 600, y: -150, width: 1350, height: 1240 }));
        const grp = boxes(doc(g).views[ctx], 'group')[1];
        value(ops.setViewElement(g, ctx, grp.id, { color: '6' }));
        expect(ops.createGroup(g, ctx, '  ', { x: 0, y: 0, width: 10, height: 10 }).ok).toBe(false);
        const first = await writeTrig(g.quads());
        const back = await load(first);
        expect(boxes(doc(back).views[byLabel(back, 'Grouped')], 'group').map(x => [x.label, x.color])).toEqual(
            [['Upstream sources', undefined], ['Consumer-facing contract', '6']]);
        expect(await writeTrig(back.quads())).toBe(first);
        value(ops.duplicateView(g, ctx));
        expect(boxes(doc(g).views[byLabel(g, 'Grouped copy')], 'group')).toHaveLength(2);
        const frames = () => g.match(null, rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(NS.view + 'Frame'), ops.viewTerm(g, ctx)).length;
        expect(frames()).toBe(2);
        ops.removeViewElements(g, ctx, [grp.id]);
        expect(boxes(doc(g).views[ctx], 'group')).toHaveLength(1);
        expect(boxes(doc(g).views[ctx], 'card')).toHaveLength(1);
        expect(frames()).toBe(1);
    });

    it('another parser (Oxigraph) reads the file: one model graph and one named graph per view', async () => {
        const g = await example();
        ops.createView(g, 'Empty view');
        const dir = mkdtempSync(join(tmpdir(), 'catenary-'));
        const file = join(dir, 'out.trig');
        writeFileSync(file, await writeTrig(g.quads()));
        const graphs = rdfQuery.rows(file, 'SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }').map(r => r.g);
        expect(graphs.sort()).toEqual(['urn:name:Empty%20view', 'urn:name:Product%20context', 'urn:name:model']);
    });
});

describe('validation', () => {
    it('the example is valid; removing a required field gives a shacl-engine violation', async () => {
        const m = await meta();
        const g = await example();
        expect(await validateGraph(g, m)).toEqual([]);
        const dp = byLabel(g, 'Product usage data');
        value(ops.setStatements(g, m, dp, { [DCT + 'description']: [] }));
        const v = await validateGraph(g, m);
        expect(v).toHaveLength(1);
        expect(v[0]).toMatchObject({ instance: dp, path: DCT + 'description', component: 'MinCount', message: 'A data product needs a description.' });
    });

    it('reports a wrong class on a relation target', async () => {
        const m = await meta();
        const g = await example();
        const dp = byLabel(g, 'Product usage data');
        const owner = ops.instanceTerm(g, byLabel(g, 'Data Product Owner'))!;
        g.set(owner, rdf.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), rdf.namedNode('http://ex.org/Other'));
        const v = await validateGraph(g, m);
        expect(v.some(x => x.instance === dp && x.component === 'Class')).toBe(true);
    });
});
