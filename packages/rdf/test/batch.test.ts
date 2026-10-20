// A batch of edit commands is one transaction: one patch, one undo step, one write and one commit (manifest §5.2, §10.3).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { EditCommand, boxes, iriId } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { DATA, DCAT, DPM, SHAPES, openStore, tempWorkspace, writeWorkspace } from './helpers';

const VIEW = 'urn:name:Product%20context';
const QUERY_SERVICE = 'urn:name:Query%20service';
const EXPOSED = DPM + 'exposedThrough';

let store: ModelStore;
let ws: ReturnType<typeof tempWorkspace>;
beforeEach(async () => {
    ws = tempWorkspace({ 'shapes.ttl': SHAPES, 'data.ttl': DATA }, 'catenary-batch-');
    store = await openStore(writeWorkspace(ws.dir));
});

const ok = <R extends { ok: boolean; error?: string }>(r: R): R => { if (!r.ok) throw new Error(r.error); return r; };

/** Ten edits with IRIs: two datasets, their placement and bounds, a relation, a rename. */
const tenEdits = (): EditCommand[] => [
    { kind: 'createInstance', classIri: DCAT + 'Dataset', label: 'Batch one' },
    { kind: 'createInstance', classIri: DCAT + 'Dataset', label: 'Batch two' },
    { kind: 'addToView', view: VIEW, ids: ['$0', '$1'], at: { x: 0, y: 0 } },
    { kind: 'setBounds', view: VIEW, bounds: [{ id: '$0', x: 100, y: 100 }] },
    { kind: 'setBounds', view: VIEW, bounds: [{ id: '$1', x: 400, y: 100 }] },
    { kind: 'createRelation', subject: '$0', predicate: EXPOSED, object: QUERY_SERVICE },
    { kind: 'rename', id: '$1', label: 'Batch two renamed' },
    { kind: 'createNote', view: VIEW, text: 'A note', at: { x: 0, y: 400 } },
    { kind: 'createInstance', classIri: DCAT + 'Dataset', label: 'Batch three' },
    { kind: 'addToView', view: VIEW, ids: ['$8'], at: { x: 700, y: 100 } }
];

const quads = () => (store as unknown as { graph: { store: { size: number } } }).graph.store.size;
const labels = () => Object.values(store.reads.search()).map(h => h.label);

describe('executeBatch (manifest §5.2)', () => {
    it('law_batchOneStep: ten edits are one undo step; one undo restores the dataset', () => {
        const before = quads();
        expect(store.canUndo).toBe(false);
        const r = ok(store.executeBatch(tenEdits()));
        expect(r.ok && r.results).toHaveLength(10);
        expect(labels()).toEqual(expect.arrayContaining(['Batch one', 'Batch two renamed', 'Batch three']));
        expect(store.canUndo).toBe(true);
        ok(store.undo());
        expect(store.canUndo).toBe(false);
        expect(quads()).toBe(before);
        expect(labels()).not.toContain('Batch one');
        ok(store.redo());
        expect(labels()).toEqual(expect.arrayContaining(['Batch one', 'Batch two renamed', 'Batch three']));
    });

    it('law_batchRefsResolve: "$N" is the result id of command N; the results give id and iri', () => {
        const r = ok(store.executeBatch(tenEdits()));
        if (!r.ok) throw new Error();
        const [one, two] = r.results;
        expect(one.iri).toBe('urn:name:Batch%20one');
        expect(one.id).toBe(iriId(one.iri!));
        const card = boxes(store.reads.view(iriId(VIEW))!, 'card').find(b => b.element === two.id);
        expect(card).toMatchObject({ x: 400, y: 100 });
        expect(store.knownId(r.results[5].id!)).toBe(true);
    });

    it('a reference to a later command, or to a command without an id, fails the batch', () => {
        const forward = store.executeBatch([{ kind: 'rename', id: '$1', label: 'X' }, { kind: 'createInstance', classIri: DCAT + 'Dataset', label: 'Y' }]);
        expect(forward).toMatchObject({ ok: false, index: 0 });
        expect(!forward.ok && forward.error).toContain('$1 refers to command 1');
        const noId = store.executeBatch([{ kind: 'setBounds', view: VIEW, bounds: [] }, { kind: 'rename', id: '$0', label: 'X' }]);
        expect(noId).toMatchObject({ ok: false, index: 1 });
        expect(store.canUndo).toBe(false);
    });

    it('law_batchRejectionRollsBack: an invalid command changes nothing; the result gives its index and error', () => {
        const before = quads();
        const edits = tenEdits();
        edits.splice(7, 0, { kind: 'rename', id: 'urn:name:Nothing%20here', label: 'X' });
        const r = store.executeBatch(edits);
        expect(r).toMatchObject({ ok: false, index: 7 });
        expect(!r.ok && r.error).toMatch(/^Command 7 \(rename\): .*urn:name:Nothing%20here/);
        expect(quads()).toBe(before);
        expect(labels()).not.toContain('Batch one');
        expect(store.canUndo).toBe(false);
        expect(store.dirty).toBe(false);
    });

    it('a command that is not an edit command fails the batch with its index', () => {
        const r = store.executeBatch([{ kind: 'createInstance', classIri: DCAT + 'Dataset', label: 'A' }, { label: 'B' } as unknown as EditCommand]);
        expect(r).toEqual({ ok: false, index: 1, error: 'Command 1: An edit command is a JSON object with a string kind.' });
    });

    it('a shape edit and then a relation that needs it: the relation sees the new shape; a rollback restores the metamodel', () => {
        const relation = (s: string, o: string): EditCommand => ({ kind: 'createRelation', subject: s, predicate: 'urn:test:owns', object: o });
        const shapes: EditCommand[] = [
            { kind: 'createNodeShape', label: 'Robot', targetClass: 'urn:test:Robot' },
            { kind: 'createPropertyShape', shape: '$0', path: { kind: 'iri', iri: 'urn:test:owns' }, range: { kind: 'class', class: 'urn:test:Part' } },
            { kind: 'createInstance', classIri: 'urn:test:Robot', label: 'R1' },
            { kind: 'createInstance', classIri: 'urn:test:Part', label: 'P1' }
        ];
        const classes = () => store.meta.classes.map(c => c.iri);
        // The same edits with a failure at the end: the metamodel has no Robot class after the rollback.
        expect(store.executeBatch([...shapes, relation('$2', '$3'), { kind: 'rename', id: 'urn:name:Nothing%20here', label: 'X' }])).toMatchObject({ ok: false, index: 5 });
        expect(classes()).not.toContain('urn:test:Robot');
        const r = ok(store.executeBatch([...shapes, relation('$2', '$3')]));
        expect(r.ok && r.results[4].id).toBeTruthy();
        expect(classes()).toContain('urn:test:Robot');
    });

    it('refuses moveElementsToFile, migrateData, two new views with a file, and a file reference to a view of the same batch', async () => {
        const refused = (commands: EditCommand[]) => { const r = store.executeBatch(commands); expect(r.ok, JSON.stringify(r)).toBe(false); return !r.ok ? r.error : ''; };
        expect(refused([{ kind: 'moveElementsToFile', source: 'data.ttl', destination: 'shapes.ttl', ids: [] }])).toContain('moveElementsToFile cannot run in a batch');
        expect(refused([{ kind: 'migrateData', migration: { kind: 'renamePredicate', from: 'urn:a', to: 'urn:b' } as never }])).toContain('migrateData cannot run in a batch');
        expect(refused([{ kind: 'createView', label: 'A', file: 'a.view.trig' }, { kind: 'createView', label: 'B' }])).toContain('more than one view');
        expect(refused([{ kind: 'createView', label: 'A' }, { kind: 'addFileReference', view: '$0', file: 'data.ttl', at: { x: 0, y: 0 } }]))
            .toContain('a view that the same batch creates');
        expect(store.canUndo).toBe(false);
        // One new view with a file is allowed.
        ok(store.executeBatch([{ kind: 'createView', label: 'A', file: 'a.view.trig' }, { kind: 'createNote', view: '$0', text: 'n', at: { x: 0, y: 0 } }]));
        await store.idle();
        expect(existsSync(ws.path('a.view.trig'))).toBe(true);
    });

    it('a view IRI change runs only as the single command of a batch; alone it keeps the view file at the edit, undo and redo', async () => {
        const viewFiles = () => store.files.views.map(v => v.path.slice(ws.dir.length + 1)).sort();
        const created = store.execute({ kind: 'createView', label: 'Plan' });
        if (!created.ok || !created.id) throw new Error(JSON.stringify(created));
        const plan = created.id;
        await store.idle();
        const files = viewFiles();
        expect(files).toEqual(['views/plan.view.trig', 'views/product-context.view.trig']);
        const text = () => files.map(f => ws.read(f));
        const before = { quads: quads(), text: text() };
        // A -> X, then B -> A: refused at command 0; nothing changes.
        const swap = store.executeBatch([{ kind: 'setUri', id: VIEW, uri: 'urn:name:moved' }, { kind: 'setUri', id: plan, uri: VIEW }]);
        expect(swap).toMatchObject({ ok: false, index: 0 });
        expect(!swap.ok && swap.error).toBe('Command 0 (setUri): This command changes the IRI of a view. Run a view IRI change as a single exec.');
        expect(store.executeBatch([{ kind: 'createNote', view: VIEW, text: 'n', at: { x: 0, y: 0 } }, { kind: 'setUri', id: plan, uri: 'urn:name:p2' }]))
            .toMatchObject({ ok: false, index: 1 });
        expect(quads()).toBe(before.quads);
        expect(store.canUndo).toBe(true);   // the createView step only
        await store.idle();
        expect(viewFiles()).toEqual(files);
        expect(text()).toEqual(before.text);
        // Alone in a batch: the view keeps its file at the edit, the undo and the redo.
        ok(store.executeBatch([{ kind: 'setUri', id: VIEW, uri: 'urn:name:moved' }]));
        await store.idle();
        expect(viewFiles()).toEqual(files);
        expect(ws.read('views/product-context.view.trig')).toContain('urn:name:moved');
        ok(store.undo());
        await store.idle();
        expect(viewFiles()).toEqual(files);
        expect(ws.read('views/product-context.view.trig')).not.toContain('urn:name:moved');
        expect(ws.read('views/product-context.view.trig')).toContain('<urn:name:Product%20context> {');
        expect(ws.read('views/plan.view.trig')).toContain('<urn:name:Plan> {');
        ok(store.redo());
        await store.idle();
        expect(viewFiles()).toEqual(files);
        expect(ws.read('views/product-context.view.trig')).toContain('urn:name:moved');
    });

    it('an empty batch changes nothing', () => {
        expect(store.executeBatch([])).toEqual({ ok: true, results: [] });
        expect(store.canUndo).toBe(false);
    });
});

describe('a no-op (manifest §5.1 law_noopLeavesHistory, §5.2)', () => {
    const undoCount = () => (store as unknown as { history: { undoStack: unknown[] } }).history.undoStack.length;
    const placed = () => boxes(store.reads.view(iriId(VIEW))!, 'card')[0].element;
    const unchanged = (run: () => unknown, expected: object) => {
        const before = { undo: undoCount(), dirty: store.dirty, revision: store.revision, quads: quads() };
        expect(run()).toMatchObject(expected);
        expect({ undo: undoCount(), dirty: store.dirty, revision: store.revision, quads: quads() }).toEqual(before);
    };

    it('addToView of placed ids gives ok:true, changed:false; the undo count and the dirty flag do not change', () => {
        unchanged(() => store.execute({ kind: 'addToView', view: VIEW, ids: [placed()], at: { x: 0, y: 0 } }),
            { ok: true, changed: false, message: 'The instance is already in this view. An element appears at most once in each view.' });
        expect(store.canUndo).toBe(false);
    });

    it('delete of an absent id gives ok:true, changed:false; the undo count and the dirty flag do not change', () => {
        unchanged(() => store.execute({ kind: 'delete', ids: ['urn:name:Nothing%20here'] }), { ok: true, changed: false, message: 'Nothing to delete.' });
        expect(store.canUndo).toBe(false);
    });

    it('law_batchResultPerCommand: a batch with a no-op item and a real edit gives one undo step and two results; the no-op keeps its index', () => {
        const r = ok(store.executeBatch([
            { kind: 'addToView', view: VIEW, ids: [placed()], at: { x: 0, y: 0 } },
            { kind: 'createNote', view: VIEW, text: 'A note', at: { x: 0, y: 400 } }
        ]));
        expect(r.ok && r.results).toHaveLength(2);
        expect(r.ok && r.results[0]).toMatchObject({ ok: true, changed: false });
        expect(r.ok && r.results[1].changed).toBeUndefined();
        expect(undoCount()).toBe(1);
    });
});

describe('one batch, one commit (manifest §10.3)', () => {
    it('a batch of ten edits gives one Git commit', async () => {
        ok(await store.setSettings({ autoCommit: true }));
        await store.idle();
        const git = (...args: string[]) => execFileSync('git', args, { cwd: ws.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        git('init', '-q');
        git('config', 'user.name', 'Test');
        git('config', 'user.email', 'test@example.org');
        git('add', '-A');
        git('commit', '-q', '-m', 'start');
        store = await openStore(ws.path('workspace.trig'));
        const count = () => Number(git('rev-list', '--count', 'HEAD'));
        expect(count()).toBe(1);
        ok(store.executeBatch(tenEdits()));
        await store.idle();
        expect(count()).toBe(1);
        ok(await store.save());
        expect(count()).toBe(2);
        expect(git('log', '-1', '--format=%s')).toBe('Catenary: createInstance ×3, addToView ×2, setBounds ×2, createNote, createRelation, … (Product context)');
        expect(git('status', '--porcelain')).toBe('');
    });
});
