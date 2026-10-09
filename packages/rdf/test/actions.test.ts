import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
        expect(a).toEqual(expect.arrayContaining(['catenary.deleteFromModel', 'catenary.openIn']));
        expect(a).not.toContain('catenary.removeFromView');
        expect(a).not.toContain('catenary.showAsEdge');
        // The same element selected on the canvas, by its placement: the view actions too, and the element actions are the same.
        const onCanvas = store.selectionActions({ view: view.id, ids: [card.id] });
        expect(onCanvas.items[0]).toMatchObject({ id: card.id, element, placed: true });
        const b = onCanvas.actions.map(x => x.id);
        expect(b).toContain('catenary.removeFromView');
        expect(b.filter(x => !['catenary.removeFromView', 'catenary.collect', 'catenary.uncollect'].includes(x))).toEqual(a);
    });

    it('a view as the item (an empty canvas selection, viewAsItem): Open in… has its view file and its canvas', async () => {
        const view = Object.values(docOf(store).views)[0];
        expect(state({ ids: [view.id], activeView: view.id }, 'catenary.openIn')).toEqual({ id: 'catenary.openIn', enabled: true });
        const targets = await store.openTargets(view.id);
        expect(targets.filter(t => t.presentation === 'Source').map(t => t.presentation === 'Source' && t.path)).toEqual([store.files.views.find(v => v.view === view.id)!.path]);
        expect(targets.filter(t => t.presentation === 'Canvas')).toEqual([{ presentation: 'Canvas', view: view.id, label: view.label }]);
    });

    it('Open in…: Source at the position of the element, Model of the files with a row, each Canvas that places it', async () => {
        const doc = docOf(store);
        const view = Object.values(doc.views).find(v => v.boxes.some(b => b.kind === 'card' && doc.instances[b.element]))!;
        const card = view.boxes.find(b => b.kind === 'card' && doc.instances[b.element])!;
        const element = card.kind === 'card' ? card.element : '';
        const targets = await store.openTargets(element);
        const source = targets.find(t => t.presentation === 'Source')!;
        expect(source).toMatchObject({ presentation: 'Source', path: join(dir, 'data.ttl'), line: expect.any(Number), column: 1 });
        expect(targets).toContainEqual({ presentation: 'Model', path: join(dir, 'data.ttl') });
        expect(targets).toContainEqual(expect.objectContaining({ presentation: 'Canvas', view: view.id }));
    });

    it('Open in → Source: a relation at its object, a property shape at its own entry, not at its node shape', async () => {
        const doc = docOf(store);
        const at = async (id: string) => (await store.openTargets(id)).find(t => t.presentation === 'Source') as { path: string; line: number; column: number };
        const textAt = (t: { path: string; line: number; column: number }) => readFileSync(t.path, 'utf8').split('\n')[t.line - 1].slice(t.column - 1);
        const relation = Object.values(doc.relations)[0];
        const object = doc.instances[relation.object].uri, text = textAt(await at(relation.id));
        expect(text.startsWith(`<${object}>`) || /^[\w-]*:\S/.test(text) && object.endsWith(text.split(/[\s,;.]/)[0].split(':')[1])).toBe(true);
        const property = Object.values(doc.shapes.properties)[0];
        const [p, owner] = [await at(property.id), await at(property.owner)];
        expect([p.line, p.column]).not.toEqual([owner.line, owner.column]);
        expect(p.line).toBeGreaterThanOrEqual(owner.line);
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

    it('every kind has Open in… with the files of its statements; Rename for named kinds, Edit Path for a property shape', async () => {
        const doc = docOf(store);
        const shape = Object.values(doc.shapes.nodeShapes)[0];
        const property = Object.values(doc.shapes.properties)[0];
        const relation = Object.values(doc.relations)[0];
        const view = Object.values(doc.views)[0];
        for (const id of [shape.id, property.id, relation.id, view.id, Object.keys(doc.instances)[0]]) {
            expect(state({ ids: [id] }, 'catenary.openIn')).toEqual({ id: 'catenary.openIn', enabled: true });
            const source = (await store.openTargets(id)).find(t => t.presentation === 'Source');
            expect(source).toMatchObject({ line: expect.any(Number) });
        }
        expect(ids({ ids: [shape.id] })).toContain('catenary.rename');
        expect(ids({ ids: [property.id] })).toEqual(expect.arrayContaining(['catenary.editPath', 'catenary.editTarget']));
        expect(ids({ ids: [property.id] })).not.toContain('catenary.rename');
        expect(ids({ ids: [shape.id, Object.keys(doc.instances)[0]] })).not.toContain('catenary.openIn');
        expect(ids({ ids: [view.id] })).toEqual(expect.arrayContaining(['catenary.openIn', 'catenary.duplicateView', 'catenary.rename', 'catenary.deleteFromModel']));
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
