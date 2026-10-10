import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NTerm, Violation, nkey } from '@catenary/model';
import { OxigraphStore } from 'rdf-files';
import { ModelGraph, VALIDATION_GRAPH } from '../src/graph';
import { ModelStore, violationScope } from '../src/model-store';
import { LAYOUT_PREDICATES, readNotations, storeIndex, storeInput } from '../src/notations';
import { rdf } from '../src/terms';

const n = (l: string) => rdf.namedNode('urn:x:' + l);
const j = (l: string): NTerm => ({ termType: 'NamedNode', value: 'urn:x:' + l });

describe('storeInput: the engine input read around the terms that a view asks about', () => {
    it('gives each lookup of the whole store index: the union of the graphs without the report, without duplicates', () => {
        const g = new ModelGraph(new OxigraphStore());
        const quad = (s: string, p: string, o: string, graph = 'g1') => rdf.quad(n(s), n(p), o.startsWith('"') ? rdf.literal(o.slice(1)) : n(o), n(graph));
        for (const q of [quad('a', 'p', 'b'), quad('a', 'p', 'c'), quad('b', 'q', '"text'), quad('c', 'p', 'a'), quad('a', 'p', 'b', 'g2'), quad('d', 'r', 'a', 'g2')]) g.add(q.subject, q.predicate, q.object, q.graph);
        g.add(n('e'), n('p'), n('a'), rdf.namedNode(VALIDATION_GRAPH));
        const lazy = storeInput(g), whole = storeIndex(g);
        const keys = (ts: NTerm[]) => ts.map(nkey);
        for (const t of ['a', 'b', 'c', 'd', 'e'].map(j)) {
            for (const p of ['p', 'q', 'r'].map(l => 'urn:x:' + l)) {
                expect(keys(lazy.objects(t, p))).toEqual(keys(whole.objects(t, p)));
                expect(keys(lazy.subjects(p, t))).toEqual(keys(whole.subjects(p, t)));
            }
            expect(lazy.predicates(t).sort()).toEqual(whole.predicates(t).sort());
            expect(lazy.incoming(t).map(([p, ss]) => [p, keys(ss)]).sort()).toEqual(whole.incoming(t).map(([p, ss]) => [p, keys(ss)]).sort());
        }
        expect(keys(lazy.subjectsOfP('urn:x:p'))).toEqual(keys(whole.subjectsOfP('urn:x:p')));
        expect(keys(lazy.objectsOfP('urn:x:p'))).toEqual(keys(whole.objectsOfP('urn:x:p')));
        expect(keys(lazy.subjects('urn:x:q', { termType: 'Literal', value: 'text' }))).toEqual(['<urn:x:b>']);
        expect(keys(lazy.objects(j('e'), 'urn:x:p'))).toEqual([]);
    });
});

describe('the figures do not read the geometry of placements', () => {
    it('no built-in notation names a layout predicate', () => {
        const N = readNotations().index;
        const named = [...N.out.values()].flatMap(byP => [...byP].flatMap(([p, os]) => [p, ...os.map(o => o.value)]));
        expect(named.filter(t => LAYOUT_PREDICATES.has(t))).toEqual([]);
    });

    it('a layout change keeps the figure input; another change does not', () => {
        const g = new ModelGraph(new OxigraphStore());
        g.add(n('view'), rdf.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), rdf.namedNode('osg://vocab/view#View'), n('view'));
        const before = g.keys.data;
        g.add(n('p1'), rdf.namedNode('osg://vocab/view#x'), rdf.literal('10'), n('view'));
        g.add(n('e'), n('p'), rdf.literal('1'), rdf.namedNode(VALIDATION_GRAPH));
        expect(g.keys.data).toBe(before);
        g.add(n('p1'), rdf.namedNode('osg://vocab/view#element'), n('a'), n('view'));
        expect(g.keys.data).not.toBe(before);
    });
});

describe('ModelStore.viewFigures keeps the figures of a view over a move', () => {
    it('a move joins the same figures with the new placements; a rename derives them again', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'catenary-figures-'));
        cpSync(fileURLToPath(new URL('./fixtures/notation/', import.meta.url)), dir, { recursive: true });
        const store = new ModelStore();
        store.watching = false;
        try {
            expect(await store.open(join(dir, 'workspace.trig'))).toEqual({ ok: true });
            const viewId = Object.keys(store.reads.viewLabels())[0];
            const card = store.viewDoc(viewId).views[viewId].boxes.find(b => b.kind === 'card')!;
            const first = store.viewFigures(viewId)!;
            expect(store.execute({ kind: 'setBounds', view: viewId, bounds: [{ id: card.id, x: card.x + 40, y: card.y }] }).ok).toBe(true);
            const moved = store.viewFigures(viewId)!;
            expect(moved.derivation).toBe(first.derivation);
            expect(store.execute({ kind: 'rename', id: card.element, label: 'Renamed' }).ok).toBe(true);
            const renamed = store.viewFigures(viewId)!;
            expect(renamed.derivation).not.toBe(first.derivation);
            expect(renamed.derivation.figures.some(f => f.title === 'Renamed')).toBe(true);
        } finally {
            await store.idle();
            store.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('violationScope: the cards whose count of violations changed', () => {
    const v = (instance: string | undefined, shape: string | undefined, severity: Violation['severity'] = 'Violation'): Violation =>
        ({ instance, shape, focus: instance ?? '', severity, component: 'MinCount', message: '' });

    it('names the instances and property shapes with another count, not the others', () => {
        const before = [v('i1', 'p1'), v('i2', 'p1'), v('i3', 'p2', 'Warning')];
        const after = [v('i1', 'p1'), v('i2', 'p1'), v('i2', 'p2'), v('i3', 'p2', 'Info')];
        expect(violationScope(before, after)).toEqual({ views: [], elements: ['i2', 'p2'], shapes: false, layout: false });
    });

    it('a run that changes no count touches no card', () => {
        expect(violationScope([v('i1', 'p1')], [v('i1', 'p1')]).elements).toEqual([]);
    });
});
