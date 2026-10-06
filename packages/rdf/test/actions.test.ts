import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActionTarget, iriId } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { DATA, SHAPES, writeWorkspace, docOf } from './helpers';

const EXTRA = `<urn:x:thing> a <urn:x:Lonely> ; <http://www.w3.org/2000/01/rdf-schema#label> "Thing" .\n`;

let dir: string, store: ModelStore;
beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'catenary-actions-'));
    writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
    writeFileSync(join(dir, 'data.ttl'), DATA);
    writeFileSync(join(dir, 'extra.ttl'), EXTRA);
    store = new ModelStore();
    store.watching = false;
    expect(await store.open(writeWorkspace(dir))).toEqual({ ok: true });
});
afterEach(async () => {
    await store.idle();
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

const ids = (t: ActionTarget) => store.selectionActions(t).actions.map(a => a.id);
const state = (t: ActionTarget, id: string) => store.selectionActions(t).actions.find(a => a.id === id);

describe('Action model (spec/ui-manifest.hs §4)', () => {
    it('an element selected outside a canvas: element actions, no view actions (Del has no action)', () => {
        const doc = docOf(store);
        const view = Object.values(doc.views).find(v => v.boxes.some(b => b.kind === 'card'))!;
        const card = view.boxes.find(b => b.kind === 'card')!;
        const element = card.kind === 'card' ? card.element : '';
        const a = ids({ ids: [element] });
        expect(a).toEqual(expect.arrayContaining(['catenary.deleteFromModel', 'catenary.goToSource', 'catenary.selectInExplorer']));
        expect(a).not.toContain('catenary.removeFromView');
        expect(a).not.toContain('catenary.showAsEdge');
        // The same element selected on the canvas, by its placement: the view actions too, and the element actions are the same.
        const onCanvas = store.selectionActions({ view: view.id, ids: [card.id] });
        expect(onCanvas.items[0]).toMatchObject({ id: card.id, element, placed: true });
        const b = onCanvas.actions.map(x => x.id);
        expect(b).toContain('catenary.removeFromView');
        expect(b.filter(x => !['catenary.removeFromView', 'catenary.collect', 'catenary.uncollect'].includes(x))).toEqual(a);
    });

    it('a view as the item (an empty canvas selection, viewAsItem): Go to Source opens its view file', async () => {
        const view = Object.values(docOf(store).views)[0];
        expect(state({ ids: [view.id], activeView: view.id }, 'catenary.goToSource')).toEqual({ id: 'catenary.goToSource', enabled: true });
        expect((await store.sources(view.id)).map(s => s.path)).toEqual([store.files.views.find(v => v.view === view.id)!.path]);
    });

    it('Add to Current View: the active view is a parameter; disabled with a reason when the view places all', () => {
        const doc = docOf(store);
        const view = Object.values(doc.views).find(v => v.boxes.some(b => b.kind === 'card'))!;
        const card = view.boxes.find(b => b.kind === 'card')!;
        const element = card.kind === 'card' ? card.element : '';
        expect(state({ ids: [element] }, 'catenary.addToView')).toEqual({ id: 'catenary.addToView', enabled: false, reason: 'No view editor is open.' });
        expect(state({ ids: [element], activeView: view.id }, 'catenary.addToView')).toMatchObject({ enabled: false });
        const unplaced = Object.keys(doc.instances).find(id => !view.boxes.some(b => b.kind === 'card' && b.element === id))!;
        expect(state({ ids: [unplaced], activeView: view.id }, 'catenary.addToView')).toEqual({ id: 'catenary.addToView', enabled: true });
    });

    it('every kind has Go to Source with the files of its statements; Rename for named kinds, Edit Path for a property shape', async () => {
        const doc = docOf(store);
        const shape = Object.values(doc.shapes.nodeShapes)[0];
        const property = Object.values(doc.shapes.properties)[0];
        const relation = Object.values(doc.relations)[0];
        const view = Object.values(doc.views)[0];
        for (const id of [shape.id, property.id, relation.id, view.id, Object.keys(doc.instances)[0]]) {
            expect(state({ ids: [id] }, 'catenary.goToSource')).toEqual({ id: 'catenary.goToSource', enabled: true });
            const sources = await store.sources(id);
            expect(sources.length).toBeGreaterThan(0);
            expect(sources[0].line).toBeGreaterThan(0);
        }
        expect(ids({ ids: [shape.id] })).toContain('catenary.rename');
        expect(ids({ ids: [property.id] })).toEqual(expect.arrayContaining(['catenary.editPath', 'catenary.editTarget']));
        expect(ids({ ids: [property.id] })).not.toContain('catenary.rename');
        expect(ids({ ids: [shape.id, Object.keys(doc.instances)[0]] })).not.toContain('catenary.goToSource');
        expect(ids({ ids: [view.id] })).toEqual(expect.arrayContaining(['catenary.openView', 'catenary.duplicateView', 'catenary.rename', 'catenary.deleteFromModel']));
    });

    it('a class or an instance: Propose Node Shapes from Data when no node shape targets the class; disabled with a reason when one does', () => {
        const id = 'catenary.proposeShapes';
        expect(state({ ids: [iriId('urn:x:Lonely')] }, id)).toEqual({ id, enabled: true });
        expect(state({ ids: [iriId('urn:x:thing')] }, id)).toEqual({ id, enabled: true });
        const targeted = Object.values(docOf(store).shapes.nodeShapes).find(s => s.targetClass)!;
        expect(state({ ids: [iriId(targeted.targetClass!)] }, id)).toMatchObject({ enabled: false });
        const r = store.execute({ kind: 'proposeShapes', classes: ['urn:x:Lonely'] });
        if (!r.ok) throw new Error(r.error);
        const made = docOf(store).shapes.nodeShapes[r.id!];
        expect({ label: made.label, targetClass: made.targetClass }).toEqual({ label: 'Lonely', targetClass: 'urn:x:Lonely' });
        expect(state({ ids: [iriId('urn:x:Lonely')] }, id)).toMatchObject({ enabled: false });
        expect(state({ ids: [iriId('urn:x:thing')] }, id)).toBeUndefined();
    });

    it('an IRI with two kinds gets the actions of both', () => {
        const doc = docOf(store);
        const both = Object.keys(doc.shapes.nodeShapes).find(id => doc.instances[id]);
        if (!both) return;
        const items = store.selectionActions({ ids: [both] }).items;
        expect(items[0].kinds).toEqual(expect.arrayContaining(['shape', 'instance']));
    });
});
