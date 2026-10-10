import { describe, expect, it } from 'vitest';
import { NS } from '@catenary/model';
import { OxigraphStore } from 'rdf-files';
import { GraphChange, ModelGraph, VALIDATION_GRAPH } from '../src/graph';
import { shapeQueryScope } from '../src/shacl-targets';
import { shapesIndexOf } from '../src/shapes-read';
import { rdf } from '../src/terms';

const n = (s: string) => rdf.namedNode('urn:test:' + s);
const graph = () => new ModelGraph(new OxigraphStore());

describe('shared patch events', () => {
    it('law_patchEventScope: one committed transaction names its graphs and IRI elements', () => {
        const g = graph(), events: GraphChange[] = [];
        g.onDidChange(e => events.push(e));
        const { patch } = g.transact(x => {
            x.add(n('a'), n('p'), n('b'));
            x.add(n('b'), n('q'), rdf.literal('name'), n('view'));
            return { ok: true };
        });
        expect(events).toHaveLength(1);
        expect(events[0].patch).toBe(patch);
        expect(events[0].graphs).toEqual([g.model.value, n('view').value]);
        expect(events[0].elements).toEqual([n('a').value, n('b').value]);
        expect(g.keys.data).toBe(events[0]);
        expect(g.keys.persisted).toBe(events[0]);
        g.transact(() => ({ ok: true }));
        g.add(n('a'), n('p'), n('b'));
        expect(events).toHaveLength(1);
    });

    it('rejection restores quads and cache keys without publishing, even after an intermediate read', () => {
        const g = graph(), before = g.change, events: GraphChange[] = [];
        const index = shapesIndexOf(g);
        g.onDidChange(e => events.push(e));
        const { patch } = g.transact(x => {
            x.add(n('shape'), rdf.namedNode(NS.sh + 'targetClass'), n('Class'), n('shapes'));
            x.setShapesGraphs([n('shapes')]);
            expect(shapesIndexOf(x)).not.toBe(index);
            return { ok: false };
        });
        expect(patch).toEqual([]);
        expect(g.quads()).toEqual([]);
        expect(g.shapesGraphs()).toEqual([]);
        expect(g.change).toBe(before);
        expect(g.keys.shapes).toBe(before);
        expect(shapesIndexOf(g).model).toEqual(index.model);
        expect(events).toEqual([]);
    });

    it('undo and redo each publish one effective patch in application order', () => {
        const g = graph(), events: GraphChange[] = [];
        const { patch } = g.transact(x => {
            x.add(n('a'), n('p'), n('b'));
            x.add(n('b'), n('p'), n('c'));
            return { ok: true };
        });
        g.onDidChange(e => events.push(e));
        g.undo(patch);
        expect(events).toHaveLength(1);
        expect(events[0].patch.map(c => c.quad.subject.value)).toEqual(['urn:test:b', 'urn:test:a']);
        expect(events[0].patch.map(c => c.op)).toEqual(['remove', 'remove']);
        g.redo(patch);
        expect(events).toHaveLength(2);
        expect(events[1].patch).toEqual(patch);
        expect(events[1].sequence).toBeGreaterThan(events[0].sequence);
    });

    it('layout and report patches retain the inputs they cannot affect', () => {
        const g = graph();
        g.add(n('view'), rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(NS.view + 'View'), n('view'));
        const before = { ...g.keys };
        g.add(n('placement'), rdf.namedNode(NS.view + 'x'), rdf.literal('20'), n('view'));
        expect(g.change.layout).toBe(true);
        expect(g.keys.data).toBe(before.data);
        expect(g.keys.query).toBe(before.query);
        expect(g.keys.shapes).toBe(before.shapes);
        expect(g.keys.persisted).not.toBe(before.persisted);
        const persisted = g.keys.persisted;
        g.add(n('report'), n('p'), n('a'), rdf.namedNode(VALIDATION_GRAPH));
        expect(g.change.graphs).toEqual([VALIDATION_GRAPH]);
        expect(g.keys.persisted).toBe(persisted);
        expect(g.keys.data).toBe(before.data);
        expect(g.keys.query).toBe(before.query);
        expect(g.keys.shapes).toBe(before.shapes);
    });
    it('source graphs found by queries invalidate their scope before graph roles are registered', () => {
        const g = graph();
        expect(shapeQueryScope(g).data).toEqual([]);
        g.add(n('shape'), rdf.namedNode(NS.sh + 'targetClass'), n('Class'), n('source'));
        expect(shapeQueryScope(g)).toEqual({ data: [n('source').value], shapes: [n('source').value] });
        const before = g.keys.query;
        g.add(n('node'), rdf.namedNode(NS.view + 'x'), rdf.literal('2'), n('source'));
        expect(g.keys.query).not.toBe(before);
        expect(g.change.layout).toBe(false);
    });

});
