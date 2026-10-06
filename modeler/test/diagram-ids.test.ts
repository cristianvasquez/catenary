import { describe, expect, it } from 'vitest';
import { Doc, ElementSchema, ModelSelection, View, emptyDoc, toSchema } from '@catenary/model';
import { selectionInView } from '../../packages/model/test/doc-reference';
import { diagramIds, selectionInDiagram } from '../src/browser/diagram/diagram-ids';

const box = { x: 0, y: 0, width: 100, height: 50 };
const card = (id: string, element: string) => ({ kind: 'card' as const, id, element, ...box });

/**
 * Instances a, b, c; relations a→b, a→c. View P: cards pa, pb, pc, placed edge pab, a→c hidden, group g, note n. View Q: cards qa, qb,
 * edge qab. Value sets s1, s2 with concept c in view S (c drawn as a card without a view node).
 */
function doc(): Doc {
    const d = emptyDoc();
    for (const id of ['a', 'b', 'c']) d.instances[id] = { id, label: id, types: [], uri: id, fields: {} };
    d.relations.ab = { id: 'ab', subject: 'a', predicate: 'p', object: 'b' };
    d.relations.ac = { id: 'ac', subject: 'a', predicate: 'p', object: 'c' };
    const view = (id: string, boxes: View['boxes'], edges: View['edges']): View => ({ id, label: id, uri: id, arrows: [], edges, boxes });
    d.views.P = view('P', [card('pa', 'a'), card('pb', 'b'), card('pc', 'c'), { kind: 'group', id: 'g', label: 'g', ...box }, { kind: 'note', id: 'n', text: 'n', ...box }],
        [{ id: 'pab', relation: 'ab' }, { relation: 'ac', hidden: true }]);
    d.views.Q = view('Q', [card('qa', 'a'), card('qb', 'b')], [{ id: 'qab', relation: 'ab' }]);
    for (const id of ['s1', 's2']) d.shapes.valueSets[id] = { id, uri: id, kind: 'scheme', label: id, file: '', members: [{ uri: 'c', label: 'c' }] };
    d.views.S = view('S', [card('ps1', 's1'), card('ps2', 's2')], []);
    return d;
}

const flat = (es: ElementSchema[]): ElementSchema[] => es.flatMap(e => [e, ...flat(e.children ?? [])]);

/** The ids of the graph of a view, as the view editor holds it. */
const graph = (d: Doc, viewId: string, showHidden = false) =>
    diagramIds(flat(toSchema(d, { classes: [] }, viewId, { showHidden, violations: [] }).children ?? []) as { id: string; element?: unknown }[]);

describe('placement ⇄ element from the diagram graph', () => {
    it('cards and placed edges translate; other ids stay', () => {
        const ids = graph(doc(), 'P');
        expect(['pa', 'pab', 'g', 'n', 'x'].map(ids.elementOf)).toEqual(['a', 'ab', 'g', 'n', 'x']);
        expect(['a', 'ab', 'ac', 'g', 'x'].map(ids.placementOf)).toEqual(['pa', 'pab', 'ac', 'g', 'x']);
        // A hidden edge (drawn with "show hidden"): the relation id.
        expect(graph(doc(), 'P', true).elementOf('ac')).toBe('ac');
    });

    it('selection in a view editor = selectionInView of the read model, on the ids that the graph has', () => {
        const d = doc();
        const selections: ModelSelection[] = [
            { view: 'P', ids: ['pa', 'pab', 'g', 'n'] }, { view: 'P', ids: ['pb', 'pc'] }, { view: 'Q', ids: ['qa', 'qab'] }, { ids: ['a', 'ab', 'ac'] },
            { ids: ['g', 'n'] }, { view: 'Q', ids: ['g'] }, { view: 'S', ids: ['c'] }, { ids: ['c', 's1'] }, { view: 'P', ids: ['a', 'ab'] }
        ];
        for (const showHidden of [false, true]) {
            const graphs = Object.fromEntries(Object.keys(d.views).map(v => [v, graph(d, v, showHidden)]));
            const other = (view: string, id: string) => graphs[view].elementOf(id);
            for (const s of selections) for (const v of Object.keys(d.views)) {
                expect(selectionInDiagram(graphs[v], s, v, other).sort(), `${JSON.stringify(s)} in ${v}`).toEqual(selectionInView(d, s, v).filter(id => graphs[v].has(id)).sort());
            }
        }
    });
});
