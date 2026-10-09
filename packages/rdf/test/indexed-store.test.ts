import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NTerm, TripleIndex, Violation, nkey } from '@catenary/model';
import { OxigraphStore } from 'rdf-files';
import { ModelGraph, VALIDATION_GRAPH } from '../src/graph';
import { ModelStore, violationScope } from '../src/model-store';
import { IndexedStore, LAYOUT_PREDICATES, nquads, readNotations, storeIndex } from '../src/notations';
import { rdf } from '../src/terms';

/** The content of an index as plain data: subject -> predicate -> object keys, and the same for the inverse. */
function content(ix: TripleIndex) {
    const plain = (m: Map<string, Map<string, NTerm[]>>) =>
        Object.fromEntries([...m].sort(([a], [b]) => a < b ? -1 : 1).map(([k, byP]) => [k, Object.fromEntries([...byP].sort(([a], [b]) => a < b ? -1 : 1).map(([p, vs]) => [p, vs.map(nkey)]))]));
    const predicates = [...new Set([...ix.out.values()].flatMap(byP => [...byP.keys()]))].sort();
    return {
        out: plain(ix.out), inv: plain(ix.inv),
        byP: Object.fromEntries(predicates.map(p => [p, { s: ix.subjectsOfP(p).map(nkey), o: ix.objectsOfP(p).map(nkey) }]))
    };
}

const n = (l: string) => rdf.namedNode('urn:x:' + l);

describe('IndexedStore: the engine input in step with each change', () => {
    it('an index kept by adds and deletes equals an index built from all quads', () => {
        const store = new IndexedStore(new OxigraphStore());
        const g = new ModelGraph(store);
        const quad = (s: string, p: string, o: string, graph = 'g1') => rdf.quad(n(s), n(p), o.startsWith('"') ? rdf.literal(o.slice(1)) : n(o), n(graph));
        for (const q of [quad('a', 'p', 'b'), quad('a', 'p', 'c'), quad('b', 'q', '"text'), quad('c', 'p', 'a')]) store.add(q);
        const live = storeIndex(g);
        expect(storeIndex(g)).toBe(live);
        // The same triple in two graphs: the union keeps it until both graphs lose it.
        store.add(quad('a', 'p', 'b', 'g2'));
        store.add(quad('d', 'p', 'a'));
        store.add(quad('a', 'p', 'b'));
        store.delete(quad('a', 'p', 'b'));
        expect(live.has({ termType: 'NamedNode', value: 'urn:x:a' }, 'urn:x:p', { termType: 'NamedNode', value: 'urn:x:b' })).toBe(true);
        store.delete(quad('a', 'p', 'b', 'g2'));
        store.delete(quad('c', 'p', 'a'));
        store.delete(quad('missing', 'p', 'a'));
        store.add(rdf.quad(n('e'), n('p'), n('f'), rdf.namedNode(VALIDATION_GRAPH)));
        const rebuilt = new TripleIndex(nquads(g.quads().filter(q => q.graph.value !== VALIDATION_GRAPH)));
        expect(content(live)).toEqual(content(rebuilt));
        expect(content(live).out['<urn:x:a>']).toEqual({ 'urn:x:p': ['<urn:x:c>'] });
    });

    it('an array that a caller read keeps its values after a change', () => {
        const store = new IndexedStore(new OxigraphStore());
        const g = new ModelGraph(store);
        store.add(rdf.quad(n('a'), n('p'), n('b'), n('g')));
        const ix = storeIndex(g);
        const read = ix.objects({ termType: 'NamedNode', value: 'urn:x:a' }, 'urn:x:p');
        store.add(rdf.quad(n('a'), n('p'), n('c'), n('g')));
        store.delete(rdf.quad(n('a'), n('p'), n('b'), n('g')));
        expect(read.map(nkey)).toEqual(['<urn:x:b>']);
        expect(ix.objects({ termType: 'NamedNode', value: 'urn:x:a' }, 'urn:x:p').map(nkey)).toEqual(['<urn:x:c>']);
    });
});

describe('the figures do not read the geometry of placements', () => {
    it('no built-in notation names a layout predicate', () => {
        const N = readNotations().index;
        const named = [...N.out.values()].flatMap(byP => [...byP].flatMap(([p, os]) => [p, ...os.map(o => o.value)]));
        expect(named.filter(t => LAYOUT_PREDICATES.has(t))).toEqual([]);
    });

    it('a layout change keeps the figure input; another change does not', () => {
        const store = new IndexedStore(new OxigraphStore());
        const before = store.dataVersion;
        store.add(rdf.quad(n('p1'), rdf.namedNode('osg://vocab/view#x'), rdf.literal('10'), n('view')));
        store.add(rdf.quad(n('e'), n('p'), rdf.literal('1'), rdf.namedNode(VALIDATION_GRAPH)));
        expect(store.dataVersion).toBe(before);
        store.add(rdf.quad(n('p1'), rdf.namedNode('osg://vocab/view#element'), n('a'), n('view')));
        expect(store.dataVersion).toBeGreaterThan(before);
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
            const viewId = Object.keys(store.viewLabels())[0];
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
