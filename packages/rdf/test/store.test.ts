import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NS, boxes, cardOf, iriId } from '@catenary/model';
import { ModelChange, ModelStore } from '../src/model-store';
import * as validation from '../src/validate';
import { DATA, DCT, SHAPES, writeWorkspace, docOf } from './helpers';

const workspaces: string[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): { dir: string; a: string; b: string } {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-store-'));
    workspaces.push(dir);
    writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
    writeWorkspace(dir, 'a.trig');
    writeFileSync(join(dir, 'data.ttl'), DATA);
    // Another workspace: its own folder (a nested workspace is not part of a).
    mkdirSync(join(dir, 'b'));
    writeFileSync(join(dir, 'b', 'b.trig'), '<urn:name:workspace> { <urn:name:workspace> a <osg://vocab/workspace#Workspace> . }\n');
    writeFileSync(join(dir, 'b', 'b.ttl'), '<urn:b> a <http://ex.org/B> ; <http://www.w3.org/2000/01/rdf-schema#label> "Only in B" .\n');
    return { dir, a: join(dir, 'a.trig'), b: join(dir, 'b', 'b.trig') };
}

// Run the validation debounce and await its async work without wall-clock sleeps.
const settled = () => vi.runAllTimersAsync();

describe('model store', () => {
    it('the read host uses the current graph and file after each open', async () => {
        const { a, b } = workspace();
        const store = new ModelStore();
        store.watching = false;
        expect(store.reads.search()).toEqual([]);
        expect(store.reads.explorerChildren()).toEqual({ rows: [], total: 0 });
        expect((await store.open(a)).ok).toBe(true);
        expect(store.reads.search().length).toBeGreaterThan(0);
        expect(store.reads.instancesNamed('Only in B')).toEqual([]);
        const view = Object.keys(docOf(store).views)[0];
        expect(store.reads.viewDescription(view)).toBe('');
        expect((await store.open(b)).ok).toBe(true);
        expect(store.reads.instancesNamed('Only in B')).toEqual([iriId('urn:b')]);
        expect(store.reads.knownClasses()).toContainEqual({ iri: 'http://ex.org/B' });
        expect(store.reads.viewDescription(view)).toBeUndefined();
        expect(store.reads.viewLabels()).toEqual({});
    });

    it('law_viewDescriptionStorage: saves Markdown in the view file, reads Properties, and undoes one edit', async () => {
        const { a } = workspace();
        const store = new ModelStore();
        await store.open(a);
        const view = Object.keys(docOf(store).views)[0];
        const text = '# Explanation\n\n- **Bold** and _italic_\n\n```text\n<example>\n```\n';
        expect(store.reads.properties(view)).toMatchObject({ kind: 'view', description: '' });
        expect(store.execute({ kind: 'setViewDescription', view, text, expectedText: '' }).ok).toBe(true);
        expect(store.reads.view(view)?.description).toBe(text);
        expect(store.reads.properties(view)).toMatchObject({ description: text });
        store.undo();
        expect(store.reads.properties(view)).toMatchObject({ description: '' });
        store.redo();
        expect(store.reads.properties(view)).toMatchObject({ description: text });
        expect((await store.save()).ok).toBe(true);
        expect((await store.open(a)).ok).toBe(true);
        expect(store.reads.properties(view)).toMatchObject({ description: text });
        expect(store.execute({ kind: 'setViewDescription', view, text: '', expectedText: text }).ok).toBe(true);
        expect(store.reads.view(view)?.description).toBeUndefined();
        store.undo();
        expect(store.reads.properties(view)).toMatchObject({ description: text });
        const copy = store.execute({ kind: 'duplicateView', id: view });
        expect(copy.ok).toBe(true);
        if (!copy.ok) throw new Error(copy.error);
        expect(store.reads.properties(copy.id!)).toMatchObject({ description: text });
    });

    it('reports a view IRI change as a moved view id, for the edit, its undo and its redo', async () => {
        const { a } = workspace();
        const store = new ModelStore();
        await store.open(a);
        const old = Object.keys(docOf(store).views)[0];
        const r = store.execute({ kind: 'setUri', id: old, uri: 'https://ex.org/view' });
        if (!r.ok) throw new Error(r.error);
        expect(store.snapshot().movedIds).toEqual({ [old]: r.id });
        store.undo();
        expect(store.snapshot().movedIds).toEqual({ [r.id!]: old });
        store.redo();
        expect(store.snapshot().movedIds).toEqual({ [old]: r.id });
        store.execute({ kind: 'createView', label: 'Other' });
        expect(store.snapshot().movedIds).toEqual({});
    });

    it('reports an instance IRI change as a moved id, for the edit and its undo', async () => {
        const { a } = workspace();
        const store = new ModelStore();
        await store.open(a);
        const old = Object.keys(docOf(store).instances)[0];
        const r = store.execute({ kind: 'setUri', id: old, uri: 'https://ex.org/moved' });
        if (!r.ok) throw new Error(r.error);
        expect(store.snapshot().movedIds).toEqual({ [old]: r.id });
        store.undo();
        expect(store.snapshot().movedIds).toEqual({ [r.id!]: old });
    });

    it('a save and an open that overlap run one after the other: the save goes to the old files, the new model stays clean', async () => {
        const { dir, a, b } = workspace();
        const store = new ModelStore();
        expect((await store.open(a)).ok).toBe(true);
        expect(store.execute({ kind: 'createView', label: 'Unsaved' }).ok).toBe(true);
        const save = store.save();
        const open = store.open(b);
        expect((await save).ok).toBe(true);
        expect((await open).ok).toBe(true);
        expect(store.file).toBe(b);
        expect(store.dirty).toBe(false);
        expect(readFileSync(join(dir, 'views', 'unsaved.view.trig'), 'utf8')).toContain('Unsaved');
        expect(existsSync(join(dir, 'b', 'views'))).toBe(false);
        expect(Object.values(docOf(store).instances).map(i => i.label)).toEqual(['Only in B']);
    });

    it('law_placementPatchStaysInView, law_viewPatchWritesOneFile: a placement change touches the view graph and writes the view file only', async () => {
        const { a, dir } = workspace();
        const store = new ModelStore();
        store.watching = false;
        await store.open(a);
        await store.idle();
        const view = Object.values(docOf(store).views).find(v => boxes(v, 'card').length > 1)!;
        const card = boxes(view, 'card')[0];
        const texts = (): Record<string, string> => Object.fromEntries(readdirSync(dir, { recursive: true, encoding: 'utf8' })
            .filter(f => /\.(ttl|trig)$/.test(f)).map(f => [f, readFileSync(join(dir, f), 'utf8')]));
        const before = texts();
        const events: ModelChange[] = [];
        store.onDidChange(e => events.push(e));
        const placement = (command: Parameters<ModelStore['execute']>[0]) => {
            events.length = 0;
            expect(store.execute(command)).toMatchObject({ ok: true });
            expect(events.map(e => e.reason)).toEqual(['edit']);
            const [e] = events;
            expect(e.patch!.length).toBeGreaterThan(0);
            expect(e.patch!.map(c => c.quad.graph.value)).toEqual(e.patch!.map(() => view.uri));
            expect(e.scope).toMatchObject({ views: [view.id], elements: [], shapes: false });
            return e.scope!;
        };
        expect(placement({ kind: 'setBounds', view: view.id, bounds: [{ id: card.id, x: card.x + 50, y: card.y + 50, width: 700 }] }).layout).toBe(true);
        expect(placement({ kind: 'setViewElements', view: view.id, ids: [card.id], patch: { color: '#00ff00', display: 'simple' } }).layout).toBe(true);
        expect(placement({ kind: 'removeFromView', view: view.id, ids: [card.id] }).layout).toBe(false);
        expect(placement({ kind: 'addToView', view: view.id, ids: [card.element], at: { x: 0, y: 0 } }).layout).toBe(false);
        await settled();
        await store.idle();
        const after = texts();
        const changed = Object.keys(before).filter(f => before[f] !== after[f]);
        expect(changed).toHaveLength(1);
        expect(after[changed[0]]).toContain(`<${view.uri}>`);
    });

    it('a validation result that is older than the last model edit is dropped', async () => {
        const { a } = workspace();
        const store = new ModelStore();
        await store.open(a);
        await settled();
        expect(store.violations).toEqual([]);
        const dp = Object.values(docOf(store).instances).find(i => i.label === 'Product usage data')!.id;
        let finish!: (result: validation.ValidationReport) => void;
        const stale = new Promise<validation.ValidationReport>(resolve => { finish = resolve; });
        const validate = vi.spyOn(validation, 'validate').mockReturnValueOnce(stale);
        const reasons: string[] = [];
        store.onDidChange(e => reasons.push(e.reason));
        // Hold one validation result while a newer edit repairs the model.
        store.execute({ kind: 'setStatements', id: dp, values: { [DCT + 'description']: [] } });
        await vi.advanceTimersByTimeAsync(250);
        expect(validate).toHaveBeenCalledTimes(1);
        store.execute({ kind: 'setStatements', id: dp, values: { [DCT + 'description']: [{ termType: 'Literal', value: 'Back.' }] } });
        finish({ results: [{ focus: docOf(store).instances[dp].uri, component: NS.sh + 'MinCountConstraintComponent', severity: NS.sh + 'Violation', messages: ['Stale result'] }], report: [] });
        await stale;
        expect(store.violations).toEqual([]);
        expect(reasons).not.toContain('validation');
        await settled();
        expect(store.violations).toEqual([]);
        store.execute({ kind: 'setStatements', id: dp, values: { [DCT + 'description']: [] } });
        await settled();
        expect(store.violations).toHaveLength(1);
    });

    it('a layout edit does not start a validation', async () => {
        const { a } = workspace();
        const store = new ModelStore();
        await store.open(a);
        await settled();
        const reasons: string[] = [];
        store.onDidChange(e => reasons.push(e.reason));
        const view = Object.values(docOf(store).views)[0];
        store.execute({ kind: 'setViewElements', view: view.id, ids: [boxes(view, 'card')[0].id], patch: { x: 1234 } });
        await settled();
        expect(reasons).toEqual(['edit']);
        expect(store.dirty).toBe(true);
        store.undo();
        expect(store.dirty).toBe(false);
    });

    it('setColor colors all cards, edges and groups of the selection in one undo step', async () => {
        const { a } = workspace();
        const store = new ModelStore();
        await store.open(a);
        const view = Object.values(docOf(store).views)[0];
        const cards = boxes(view, 'card').map(n => n.element);
        const relations = Object.keys(docOf(store).relations);
        expect(store.execute({ kind: 'setViewElements', view: view.id, ids: [...cards, ...relations], patch: { color: '4' } }).ok).toBe(true);
        const v = docOf(store).views[view.id];
        expect(boxes(v, 'card').every(n => n.color === '4')).toBe(true);
        expect(v.edges.filter(e => relations.includes(e.relation)).every(e => e.color === '4')).toBe(true);
        store.undo();
        expect(boxes(docOf(store).views[view.id], 'card').every(n => n.color === cardOf(view, n.element)?.color)).toBe(true);
        store.redo();
        store.execute({ kind: 'setViewElements', view: view.id, ids: cards, patch: { color: '' } });
        expect(boxes(docOf(store).views[view.id], 'card').every(n => !n.color)).toBe(true);
    });

    it('undo and redo restore content and dirty state; a failed command adds no undo step', async () => {
        const { a } = workspace();
        const store = new ModelStore();
        await store.open(a);
        expect(store.execute({ kind: 'createView', label: ' bad' }).ok).toBe(false);
        expect(store.canUndo).toBe(false);
        store.execute({ kind: 'createView', label: 'V2' });
        expect(Object.values(docOf(store).views).map(v => v.label)).toContain('V2');
        store.undo();
        expect(Object.values(docOf(store).views).map(v => v.label)).not.toContain('V2');
        expect(store.dirty).toBe(false);
        store.redo();
        expect(store.dirty).toBe(true);
    });
});

describe('patch notification integration', () => {
    it('law_eventVersion: edit and replay notify once with the same event that keys the snapshot', async () => {
        const { a } = workspace(), store = new ModelStore();
        store.watching = false;
        try {
            expect((await store.open(a)).ok).toBe(true);
            const changes: import('../src/model-store').ModelChange[] = [];
            store.onDidChange(change => {
                if (['edit', 'undo', 'redo'].includes(change.reason)) {
                    expect(store.snapshot().revision).toBe(change.event.sequence);
                    changes.push(change);
                }
            });
            expect(store.execute({ kind: 'createView', label: 'Event view' }).ok).toBe(true);
            expect(changes).toHaveLength(1);
            expect(changes[0].patch).toBe(changes[0].event.patch);
            expect(store.undo().ok).toBe(true);
            expect(changes).toHaveLength(2);
            expect(changes[1].patch).toEqual([...changes[0].patch!].reverse().map(c => ({ op: c.op === 'add' ? 'remove' : 'add', quad: c.quad })));
            expect(changes[1].patch).toBe(changes[1].event.patch);
            expect(store.redo().ok).toBe(true);
            expect(changes).toHaveLength(3);
            await store.idle();
            const revision = store.snapshot().revision;
            await store.save();
            expect(store.snapshot().revision).toBe(revision);
        } finally { store.close(); }
    });

    it('law_readWarningsCurrent and law_placementWarningExplains: refresh placement warnings after data arrival, removal and undo (kata d8w7)', async () => {
        const { a, dir } = workspace(), store = new ModelStore();
        store.watching = false;
        writeFileSync(join(dir, 'warnings.view.trig'), `<urn:warning:view> {
            <urn:warning:view> a <${NS.view}View>; <${NS.rdfs}label> "Warnings" .
            <urn:warning:placement> a <${NS.view}Placement>; <${NS.view}view> <urn:warning:view>; <${NS.view}element> <urn:warning:resource> .
        }`);
        const warning = 'Warnings: placement of urn:warning:resource has no supported card presentation, kept in the file, not shown';
        const warnings = () => store.snapshot().warnings.filter(w => w.startsWith('Warnings:'));
        try {
            expect((await store.open(a)).ok).toBe(true);
            expect(warnings()).toEqual([warning]);
            expect(store.execute({ kind: 'rename', id: iriId('urn:warning:view'), label: 'Renamed' }).ok).toBe(true);
            expect(store.snapshot().warnings).toContain(warning.replace('Warnings:', 'Renamed:'));
            expect(store.snapshot().warnings).not.toContain(warning);
            expect(store.undo().ok).toBe(true);
            expect(warnings()).toEqual([warning]);
            expect(store.redo().ok).toBe(true);
            expect(store.snapshot().warnings).toContain(warning.replace('Warnings:', 'Renamed:'));
            expect(store.undo().ok).toBe(true);
            await store.idle();
            writeFileSync(join(dir, 'arrival.ttl'), `<urn:warning:resource> a <urn:warning:Class>; <${NS.rdfs}label> "Arrived" .`);
            await store.syncFromDisk();
            expect(warnings()).toEqual([]);
            expect(store.execute({ kind: 'delete', ids: [iriId('urn:warning:resource')] }).ok).toBe(true);
            // Deletion also removes placements. Undo restores the resource and its placement.
            expect(warnings()).toEqual([]);
            expect(store.undo().ok).toBe(true);
            expect(warnings()).toEqual([]);
            await store.idle();
            rmSync(join(dir, 'arrival.ttl'));
            await store.syncFromDisk();
            expect(warnings()).toEqual([warning]);
            expect(store.snapshot().warnings.some(w => w.includes('was removed on disk'))).toBe(true);
        } finally { await store.idle(); store.close(); }
    });

    it('file reload and unload notify their effective patches without entering undo or dirty state', async () => {
        const { a, dir } = workspace(), store = new ModelStore();
        store.watching = false;
        try {
            expect((await store.open(a)).ok).toBe(true);
            await store.idle();
            const changes: import('../src/model-store').ModelChange[] = [];
            store.onDidChange(c => { if (c.reason === 'files') changes.push(c); });
            writeFileSync(join(dir, 'new.ttl'), '<urn:event:new> <urn:event:p> "first" .\n');
            await store.syncFromDisk();
            expect(changes).toHaveLength(1);
            expect(changes[0].event.patch.some(c => c.op === 'add' && c.quad.subject.value === 'urn:event:new')).toBe(true);
            expect(store.snapshot()).toMatchObject({ canUndo: false, dirty: false });
            writeFileSync(join(dir, 'new.ttl'), '<urn:event:new> <urn:event:p> "second" .\n');
            await store.syncFromDisk();
            expect(changes).toHaveLength(2);
            expect(changes[1].event.patch.filter(c => c.quad.subject.value === 'urn:event:new').map(c => c.op)).toEqual(['remove', 'add']);
            rmSync(join(dir, 'new.ttl'));
            await store.syncFromDisk();
            expect(changes).toHaveLength(3);
            expect(changes[2].event.patch.some(c => c.op === 'remove' && c.quad.subject.value === 'urn:event:new')).toBe(true);
            expect(store.snapshot()).toMatchObject({ canUndo: false, dirty: false });
            await store.idle();
        } finally { store.close(); }
    });
});
