import { describe, expect, it } from 'vitest';
import { relationsInView, boxes } from '@catenary/model';
import { readShapes } from '../src/shapes-read';
import { rdf } from '../src/terms';
import { viewRead } from '../src/view-read';
import { byLabel, doc, example } from './helpers';

describe('view read (SPARQL rows of one view)', () => {
    it('the read model of one view equals that view in the read model of the whole model', async () => {
        const g = await example();
        const full = doc(g);
        const shapes = readShapes(g.shapesAndVocabulary()).model;
        for (const view of Object.values(full.views)) {
            const part = viewRead({ g, shapes }, rdf.namedNode(view.uri));
            expect(Object.keys(part.views)).toEqual([view.id]);
            expect(part.views[view.id]).toEqual(view);
            const members = new Set(boxes(view, 'card').map(n => n.element));
            expect(Object.keys(part.instances).sort()).toEqual([...members].sort());
            for (const id of members) expect(part.instances[id]).toEqual(full.instances[id]);
            expect(Object.keys(part.relations).sort()).toEqual(relationsInView(full, view).map(r => r.id).sort());
        }
    });

    it('leaves out relations to instances that are not in the view', async () => {
        const g = await example();
        const full = doc(g);
        const ctx = full.views[byLabel(g, 'Product context')];
        const members = new Set(boxes(ctx, 'card').map(n => n.element));
        const outside = Object.values(full.relations).filter(r => members.has(r.subject) && !members.has(r.object));
        expect(outside.length).toBeGreaterThan(0);
        const part = viewRead({ g, shapes: readShapes(g.shapesAndVocabulary()).model }, rdf.namedNode(ctx.uri));
        for (const r of outside) expect(part.relations[r.id]).toBeUndefined();
        expect(Object.keys(part.relations).length).toBeGreaterThan(0);
    });
});
