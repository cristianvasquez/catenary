// The SHACL and value-set elements of a view from the notation engine (notation-schema.ts in @catenary/model, ADR 0014): lines, rows,
// dashed edges of rows, "one of" boxes, value sets, simple cards. Placement edits with the engine: shapes-edit.test.ts.

import { describe, expect, it } from 'vitest';
import { ElementSchema, TYPES, elementOfId, idIri, iriId, memberListHeight, toSchema, viewFigures } from '@catenary/model';
import { ModelGraph } from '../src/graph';
import { readNotations, storeIndex } from '../src/notations';
import { project } from './project-full';
import { load, run } from './helpers';

const meta = { classes: [] };
const SHAPES = `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`;

/** A model with shapes (the graph of a shapes file) and data, and a view with the node shapes `cards`. */
async function setup(shapes: string, data = '', cards: string[] = []) {
    const g = await load(`${SHAPES}\n<urn:file:/tmp/s.ttl> { ${shapes} }\n<urn:name:model> { ${data} }`);
    const view = run(g, meta, { kind: 'createView', label: 'V' }) as string;
    cards.forEach((c, i) => run(g, meta, { kind: 'addToView', view, ids: [iriId(c)], at: { x: i * 600, y: 0 } }));
    return { g, view };
}
const schema = (g: ModelGraph, view: string): ElementSchema[] => toSchema(project(g).doc, meta, view, {
    showHidden: false, violations: [], notation: viewFigures(storeIndex(g), readNotations(), idIri(view)!)
}).children!;
const of = (g: ModelGraph, view: string, type: string) => schema(g, view).filter(e => e.type === type);
const element = (g: ModelGraph, view: string, id: unknown) => elementOfId(project(g).doc.views[view], id as string);

describe('SHACL elements from the notation engine', () => {
    it('draws object targeting from the object-end shape and draws node-level constraints', async () => {
        const { g, view } = await setup(`
            <urn:source> a sh:NodeShape ; sh:property <urn:property> ; sh:node <urn:shared> .
            <urn:property> sh:path <urn:p> ; sh:node <urn:object> .
            <urn:object> a sh:NodeShape . <urn:shared> a sh:NodeShape .
            <urn:target> sh:targetObjectsOf <urn:p> .`, '', ['urn:source', 'urn:object', 'urn:shared', 'urn:target']);
        const edges = of(g, view, TYPES.TARGETING);
        const object = edges.find(e => e.name === 'objects of <urn:p>')!;
        expect([element(g, view, object.sourceId), element(g, view, object.targetId)]).toEqual([iriId('urn:object'), iriId('urn:target')]);
        const node = edges.find(e => e.name === 'sh:node')!;
        expect([element(g, view, node.sourceId), element(g, view, node.targetId)]).toEqual([iriId('urn:source'), iriId('urn:shared')]);
        expect(of(g, view, TYPES.SHAPE).find(c => c.element === iriId('urn:target'))!.subtitle).toBe('objects of p');
    });

    it('labels an object-target connector from its property owner when no object-end shape exists', async () => {
        const { g, view } = await setup(`<urn:source> a sh:NodeShape ; sh:property <urn:property> .
            <urn:property> sh:path <urn:p> . <urn:target> sh:targetObjectsOf <urn:p> .`, '', ['urn:source', 'urn:target']);
        expect(of(g, view, TYPES.TARGETING).map(e => e.name)).toEqual(['objects of <urn:p>']);
    });

    it('draws a self-targeting connector', async () => {
        const { g, view } = await setup(`
            <urn:self> a sh:NodeShape ; sh:targetSubjectsOf <urn:status> ; sh:property <urn:property> .
            <urn:property> sh:path <urn:status> .`, '', ['urn:self']);
        const edges = of(g, view, TYPES.TARGETING);
        expect(edges).toHaveLength(1);
        expect(edges[0].sourceId).toBe(edges[0].targetId);
        expect(element(g, view, edges[0].sourceId)).toBe(iriId('urn:self'));
    });

    it('draws a derived edge from a property to a shape that targets its subjects', async () => {
        const { g, view } = await setup(`
            <urn:source> a sh:NodeShape ; sh:property <urn:property> .
            <urn:property> sh:path <urn:status> .
            <urn:target> a sh:NodeShape ; sh:targetSubjectsOf <urn:first>, <urn:status> .`, '', ['urn:source', 'urn:target']);
        const edge = of(g, view, TYPES.TARGETING);
        expect(edge).toHaveLength(1);
        expect([element(g, view, edge[0].sourceId), element(g, view, edge[0].targetId)]).toEqual([iriId('urn:source'), iriId('urn:target')]);
        expect(edge[0].name).toBe('<urn:status>');
        expect(of(g, view, TYPES.SHAPE).find(c => c.element === iriId('urn:target'))!.subtitle).toBe('subjects of first or status');
    });

    it('law_subjectTargetUnion: draws connectors for every matching predicate and shows class and subject targets', async () => {
        const { g, view } = await setup(`
            <urn:source> a sh:NodeShape ; sh:property <urn:p1>, <urn:p2> .
            <urn:p1> sh:path <urn:first> . <urn:p2> sh:path <urn:second> .
            <urn:target> a sh:NodeShape ; sh:targetClass <urn:Class> ; sh:targetSubjectsOf <urn:first>, <urn:second> .`, '', ['urn:source', 'urn:target']);
        expect(of(g, view, TYPES.TARGETING).map(e => e.name).sort()).toEqual(['<urn:first>', '<urn:second>']);
        expect(of(g, view, TYPES.SHAPE).find(c => c.element === iriId('urn:target'))!.subtitle).toBe('Class · subjects of first or second');
    });

    it('numbers the lanes of the lines between two cards; a self-line has its own lanes', async () => {
        const { g, view } = await setup(`
            <urn:a> a sh:NodeShape ; sh:property <urn:ab1>, <urn:aa1>, <urn:ac>, <urn:ab2>, <urn:aa2> .
            <urn:b> a sh:NodeShape ; sh:property <urn:ba> . <urn:c> a sh:NodeShape .
            <urn:ab1> sh:path <urn:p1> ; sh:node <urn:b> . <urn:ab2> sh:path <urn:p2> ; sh:node <urn:b> . <urn:ba> sh:path <urn:p3> ; sh:node <urn:a> .
            <urn:aa1> sh:path <urn:p4> ; sh:node <urn:a> . <urn:aa2> sh:path <urn:p5> ; sh:node <urn:a> . <urn:ac> sh:path <urn:p6> ; sh:node <urn:c> .`,
        '', ['urn:a', 'urn:b', 'urn:c']);
        // The cards arrive: every line between them is placed (rule 11).
        const edges = of(g, view, TYPES.PROPERTY);
        expect(edges).toHaveLength(6);
        const pair = (e: ElementSchema) => [element(g, view, e.sourceId), element(g, view, e.targetId)].sort().join(' ');
        const lanes = new Map<string, number[]>();
        for (const e of edges) lanes.set(pair(e), [...(lanes.get(pair(e)) ?? []), e.lane as number]);
        expect(Object.fromEntries([...lanes].map(([k, v]) => [k, v.sort()]))).toEqual({
            [[iriId('urn:a'), iriId('urn:b')].sort().join(' ')]: [0, 1, 2], [`${iriId('urn:a')} ${iriId('urn:a')}`]: [0, 1], [[iriId('urn:a'), iriId('urn:c')].sort().join(' ')]: [0]
        });
    });

    it('a row whose end is shown has a dashed edge; a line has none', async () => {
        const { g, view } = await setup(`<urn:a> a sh:NodeShape ; sh:property <urn:ab> . <urn:b> a sh:NodeShape . <urn:ab> sh:path <urn:p> ; sh:node <urn:b> .`, '', ['urn:a', 'urn:b']);
        expect(of(g, view, TYPES.PROPERTY).map(e => e.id)).toEqual([iriId('urn:ab')]);
        expect(of(g, view, TYPES.LATENT)).toEqual([]);
        run(g, meta, { kind: 'removeFromView', view, ids: [iriId('urn:ab')] });
        expect(of(g, view, TYPES.PROPERTY)).toEqual([]);
        expect(of(g, view, TYPES.LATENT).map(e => [e.id, element(g, view, e.targetId)])).toEqual([[iriId('urn:ab') + '_latent', iriId('urn:b')]]);
        expect(of(g, view, TYPES.SHAPE).find(c => c.element === iriId('urn:a'))!.children!.map(r => [r.id, r.range])).toEqual([[iriId('urn:ab'), '→ b']]);
    });

    it('Show as Edge on a sh:not member gives its line with the tag «not»', async () => {
        const { g, view } = await setup(`<urn:a> a sh:NodeShape ; sh:not <urn:n> . <urn:b> a sh:NodeShape . <urn:n> sh:path <urn:q> ; sh:node <urn:b> .`, '', ['urn:a', 'urn:b']);
        run(g, meta, { kind: 'removeFromView', view, ids: [iriId('urn:n')] });
        expect(of(g, view, TYPES.PROPERTY)).toEqual([]);
        run(g, meta, { kind: 'showAsEdge', view, id: iriId('urn:n'), at: { x: 600, y: 0 } });
        expect(of(g, view, TYPES.PROPERTY).map(e => [e.id, element(g, view, e.targetId)])).toEqual([[iriId('urn:n'), iriId('urn:b')]]);
    });

    it('a class with two node shapes: the line ends at the one that the view shows', async () => {
        const { g, view } = await setup(`<urn:a> a sh:NodeShape ; sh:property <urn:ap> . <urn:ap> sh:path <urn:p> ; sh:class <urn:P> .
            <urn:s1> a sh:NodeShape ; sh:targetClass <urn:P> . <urn:s2> a sh:NodeShape ; sh:targetClass <urn:P> .`, '', ['urn:a', 'urn:s2']);
        expect(of(g, view, TYPES.PROPERTY).map(e => element(g, view, e.targetId))).toEqual([iriId('urn:s2')]);
        run(g, meta, { kind: 'removeFromView', view, ids: [iriId('urn:ap')] });
        run(g, meta, { kind: 'showAsEdge', view, id: iriId('urn:ap'), at: { x: 600, y: 0 } });
        expect(of(g, view, TYPES.PROPERTY).map(e => element(g, view, e.targetId))).toEqual([iriId('urn:s2')]);
        expect(of(g, view, TYPES.SHAPE).map(c => c.element).sort()).toEqual([iriId('urn:a'), iriId('urn:s2')].sort());
    });

    it('draws an "or" range as a "one of" box: rows for alternatives without a line, a line to an alternative whose card arrives', async () => {
        const { g, view } = await setup(`
            <urn:a> a sh:NodeShape ; sh:property <urn:p> . <urn:b> a sh:NodeShape ; sh:targetClass <urn:B> . <urn:h> a sh:NodeShape ; sh:targetClass <urn:H> .
            <urn:p> sh:path <urn:path> ; sh:or ( <urn:alt1> <urn:alt2> <urn:alt3> ) .
            <urn:alt1> sh:class <urn:B> . <urn:alt2> sh:class <urn:H> . <urn:alt3> sh:datatype xsd:date .`, '', ['urn:a']);
        run(g, meta, { kind: 'showAsEdge', view, id: iriId('urn:p'), at: { x: 600, y: 0 } });
        const box = () => of(g, view, TYPES.ONE_OF)[0];
        expect(box()).toMatchObject({ id: iriId('urn:p') + '_leaf', size: { width: 320, height: memberListHeight(3) } });
        expect((box().members as { label: string; takeOut: string }[]).map(r => [r.label, r.takeOut])).toEqual([['B', iriId('urn:b')], ['H', iriId('urn:h')], ['xsd:date', '']]);
        expect(of(g, view, TYPES.PROPERTY)).toMatchObject([{ id: iriId('urn:p'), targetId: iriId('urn:p') + '_leaf' }]);
        // The card of B arrives: the line of its alternative is placed; B is no longer a row.
        run(g, meta, { kind: 'addToView', view, ids: [iriId('urn:b')], at: { x: 1200, y: 0 } });
        expect((box().members as { label: string }[]).map(r => r.label)).toEqual(['H', 'xsd:date']);
        expect(of(g, view, TYPES.ALTERNATIVE).map(e => [e.id, e.sourceId, element(g, view, e.targetId)])).toEqual([[`${iriId('urn:p')}_leaf_or_${iriId('urn:alt1')}`, iriId('urn:p') + '_leaf', iriId('urn:b')]]);
        // A move or a resize of the box places its list term; the property line keeps no geometry.
        run(g, meta, { kind: 'setBounds', view, bounds: [{ id: iriId('urn:p') + '_leaf', x: 700, y: 300, width: 400, height: 500 }] });
        expect(box()).toMatchObject({ position: { x: 700, y: 300 }, size: { width: 400, height: 500 } });
    });

    // An alternative with sh:node (and no property shapes of its own) is a line of the "one of" box, not a card of its own (shapes.ttl,
    // shn:Card). Two boxes with the same alternative each draw their line to its card; a removal gives the rows back (ui-manifest §2.9).
    it('a sh:node alternative: its card arrives with a line from each "one of" box; a removal gives the rows back', async () => {
        const { g, view } = await setup(`
            <urn:concept> a sh:NodeShape ; sh:property <urn:refs>, <urn:parts> .
            <urn:refs> sh:path <urn:references> ; sh:or ( [ sh:node <urn:res> ] [ sh:node <urn:ref> ] ) .
            <urn:parts> sh:path <urn:hasPart> ; sh:or ( [ sh:node <urn:res> ] [ sh:node <urn:ref> ] ) .
            <urn:res> a sh:NodeShape . <urn:ref> a sh:NodeShape .`, '', ['urn:concept']);
        run(g, meta, { kind: 'showAsEdge', view, id: iriId('urn:refs'), at: { x: 600, y: 0 } });
        run(g, meta, { kind: 'showAsEdge', view, id: iriId('urn:parts'), at: { x: 600, y: 400 } });
        const rows = () => Object.fromEntries(of(g, view, TYPES.ONE_OF).map(b => [b.id, (b.members as { takeOut: string }[]).map(r => r.takeOut)]));
        const lines = () => of(g, view, TYPES.ALTERNATIVE).map(e => [e.sourceId, element(g, view, e.targetId)]).sort();
        const refs = iriId('urn:refs') + '_leaf', parts = iriId('urn:parts') + '_leaf';
        expect(rows()).toEqual({ [refs]: [iriId('urn:res'), iriId('urn:ref')], [parts]: [iriId('urn:res'), iriId('urn:ref')] });
        // Only the alternatives are lines: the node shapes of the alternatives get no card of their own.
        expect(of(g, view, TYPES.SHAPE).map(c => c.element)).toEqual([iriId('urn:concept')]);
        run(g, meta, { kind: 'addToView', view, ids: [iriId('urn:res')], at: { x: 1200, y: 0 } });
        expect(lines()).toEqual([[parts, iriId('urn:res')], [refs, iriId('urn:res')]]);
        expect(rows()).toEqual({ [refs]: [iriId('urn:ref')], [parts]: [iriId('urn:ref')] });
        // The card leaves: its lines leave, the rows come back.
        run(g, meta, { kind: 'removeFromView', view, ids: [iriId('urn:res')] });
        expect(lines()).toEqual([]);
        expect(rows()).toEqual({ [refs]: [iriId('urn:res'), iriId('urn:ref')], [parts]: [iriId('urn:res'), iriId('urn:ref')] });
        // The property goes back to a row: its box leaves with its own alternative lines (they start at the box, they do not keep it).
        run(g, meta, { kind: 'addToView', view, ids: [iriId('urn:res')], at: { x: 1200, y: 0 } });
        run(g, meta, { kind: 'removeFromView', view, ids: [iriId('urn:refs')] });
        expect(Object.keys(rows())).toEqual([parts]);
        expect(lines()).toEqual([[parts, iriId('urn:res')]]);
        expect(of(g, view, TYPES.SHAPE).find(c => c.element === iriId('urn:concept'))!.children!.map(r => r.id)).toEqual([iriId('urn:refs')]);
    });

    it('draws a value set with its concepts; a concept with its own card is no row', async () => {
        const { g, view } = await setup(`
            <urn:a> a sh:NodeShape ; sh:property <urn:p> . <urn:p> sh:path <urn:path> ; sh:node <urn:inKeys> .
            <urn:inKeys> sh:property [ sh:path skos:inScheme ; sh:hasValue <urn:keys> ] .`,
        `<urn:keys> a skos:ConceptScheme ; skos:prefLabel "Keys" . <urn:k1> a skos:Concept ; skos:prefLabel "K1" ; skos:inScheme <urn:keys> .
         <urn:k2> a skos:Concept ; skos:prefLabel "K2" ; skos:inScheme <urn:keys> .`, ['urn:a']);
        run(g, meta, { kind: 'showAsEdge', view, id: iriId('urn:p'), at: { x: 600, y: 0 } });
        const set = () => of(g, view, TYPES.VALUESET)[0];
        expect(set()).toMatchObject({ element: iriId('urn:keys'), name: 'Keys' });
        expect((set().members as { uri: string }[]).map(m => m.uri)).toEqual(['urn:k1', 'urn:k2']);
        expect(of(g, view, TYPES.PROPERTY).map(e => element(g, view, e.targetId))).toEqual([iriId('urn:keys')]);
        run(g, meta, { kind: 'addToView', view, ids: [iriId('urn:k1')], at: { x: 900, y: 300 } });
        expect((set().members as { uri: string }[]).map(m => m.uri)).toEqual(['urn:k2']);
        // The line goes back to a row: the value set that the line brought (view:keptByLines) leaves with it.
        run(g, meta, { kind: 'removeFromView', view, ids: [iriId('urn:p')] });
        expect(of(g, view, TYPES.VALUESET)).toEqual([]);
    });

    it('a simple node shape card has its class line and no rows; the rows grow with the card text scale', async () => {
        const { g, view } = await setup(`<urn:s> a sh:NodeShape ; sh:targetClass <urn:C> ; sh:property <urn:p> . <urn:p> sh:path <urn:path> ; sh:datatype xsd:string .`, '', ['urn:s']);
        const card = (scale = 1) => toSchema(project(g).doc, meta, view, {
            showHidden: false, violations: [], cardScale: scale, notation: viewFigures(storeIndex(g), readNotations(), idIri(view)!)
        }).children!.find(e => e.type === TYPES.SHAPE)!;
        expect(card()).toMatchObject({ display: 'detailed', size: { height: 84 + 28 + 28 + 8 } });
        expect(card().children!.map(c => c.id)).toEqual([iriId('urn:p')]);
        expect(card(2)).toMatchObject({ size: { height: 2 * (84 + 28 + 28 + 8) } });
        run(g, meta, { kind: 'setViewElements', view, ids: [card().id], patch: { display: 'simple' } });
        // A simple card keeps its stored height (at least the header).
        expect(card()).toMatchObject({ className: 'NodeShape', display: 'simple', size: { height: Math.max(84, 120) } });
        expect(card().children).toEqual([]);
    });

    it('an instance card: rows of the property shapes with a value; a link to an instance outside the view is a row', async () => {
        const { g, view } = await setup(`<urn:PersonShape> a sh:NodeShape ; sh:targetClass <urn:Person> ; sh:property <urn:name>, <urn:knows>, <urn:age> .
            <urn:name> sh:path <urn:name> ; sh:datatype xsd:string . <urn:age> sh:path <urn:age> ; sh:datatype xsd:integer .
            <urn:knows> sh:path <urn:knows> ; sh:class <urn:Person> .`,
        `<urn:ann> a <urn:Person> ; rdfs:label "Ann" ; <urn:name> "Ann A." ; <urn:knows> <urn:bob> .
         <urn:bob> a <urn:Person> ; rdfs:label "Bob" .`);
        run(g, meta, { kind: 'addToView', view, ids: [iriId('urn:ann')], at: { x: 0, y: 0 } });
        const card = () => of(g, view, TYPES.CARD).find(c => c.element === iriId('urn:ann'))!;
        // No row for age (no value). Bob is not in the view: the link is a row.
        expect(card().lines).toEqual(['knows: Bob', 'name: Ann A.']);
        // Bob arrives: the link is a line (placeConnectors), not a row.
        run(g, meta, { kind: 'addToView', view, ids: [iriId('urn:bob')], at: { x: 600, y: 0 } });
        expect(card().lines).toEqual(['name: Ann A.']);
        expect(of(g, view, TYPES.RELATION)).toHaveLength(1);
    });
});
