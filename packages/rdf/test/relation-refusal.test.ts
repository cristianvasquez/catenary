// A refused relation names the classes, the predicate and the shapes of the subject; canRelate gives the same facts without an edit
// (spec/manifest.hs §6.2 law_refusalNamesShapes, §11.1).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { iriId, reconnectProblem, relationIdOf } from '@catenary/model';
import { DATA, DCAT, DPM, SHAPES, docOf, openStore, tempWorkspace, writeWorkspace } from './helpers';

const QUERY = 'urn:name:Query%20service', METRICS = 'urn:name:Metrics%20API', DATASET = 'urn:name:Product%20events%20dataset';
const EXPOSED = DPM + 'exposedThrough';

async function demo() {
    const { dir } = tempWorkspace({}, 'catenary-refusal-');
    writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
    writeFileSync(join(dir, 'data.ttl'), DATA);
    writeWorkspace(dir);
    return openStore(join(dir, 'workspace.trig'));
}

describe('relation refusal on the demo workspace', () => {
    it('createRelation names the subject classes, the predicate and a node shape; canRelate gives the same facts', async () => {
        const store = await demo();
        const refused = store.execute({ kind: 'createRelation', subject: iriId(QUERY), predicate: EXPOSED, object: iriId(METRICS) });
        if (refused.ok) throw new Error('the relation was created');
        expect(refused.error).toMatch(/^No shape or RDFS rule permits \S+exposedThrough\S* from "Query service" \(dcat:DataService\) to "Metrics API" \(dcat:DataService\)\./);
        expect(refused.error).toContain('Shapes of the subject: "Data Service".');

        const can = store.reads.canRelate(iriId(QUERY), EXPOSED, iriId(METRICS));
        if (can.ok) throw new Error('canRelate permits it');
        expect(can).toMatchObject({ error: refused.error, subjectClasses: [DCAT + 'DataService'], objectClasses: [DCAT + 'DataService'], predicate: EXPOSED });
        expect(can.shapes).toEqual([{ id: iriId('osg://shapes/data-product-draft#DataService'), label: 'Data Service', targetClass: DCAT + 'DataService' }]);

        const permitted = store.reads.canRelate(iriId(DATASET), EXPOSED, iriId(METRICS));
        expect(permitted.ok).toBe(true);
        expect(permitted.permitted.map(r => r.path)).toContain(EXPOSED);
        expect(store.reads.canRelate(iriId(QUERY), EXPOSED, iriId('urn:name:Nothing'))).toMatchObject({ ok: false, error: 'A relation connects two instances.' });
    });

    it('the graph (createRelation, reconnectRelation) and the Doc (reconnectProblem) give the same text', async () => {
        const store = await demo();
        const id = relationIdOf(DATASET, EXPOSED, QUERY);
        const doc = docOf(store), r = doc.relations[id];
        expect(r).toBeDefined();
        // The source of "Product events dataset → Query service" moves to Metrics API: the relation Metrics API → Query service.
        const created = store.execute({ kind: 'createRelation', subject: iriId(METRICS), predicate: EXPOSED, object: iriId(QUERY) });
        if (created.ok) throw new Error('the relation was created');
        expect(created.error).toContain('from "Metrics API" (dcat:DataService) to "Query service" (dcat:DataService)');
        expect(reconnectProblem(store.meta, doc, r, 'source', iriId(METRICS))).toBe(created.error);
        expect(store.execute({ kind: 'reconnectRelation', relation: id, end: 'source', to: iriId(METRICS) })).toMatchObject({ ok: false, error: created.error });
    });
});
