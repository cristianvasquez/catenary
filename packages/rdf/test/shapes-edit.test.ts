import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cardinalityText, formatPath, nextCardinality, parsePath, propertyNodeId, termIri, toSchema, verbalizeConstraint, verbalizeProperty, boxes, elementOfId, idIri, iriId, viewFigures } from '@catenary/model';
import { readNotations, storeIndex } from '../src/notations';
import { executeCommand } from '../src/commands';
import { ModelGraph, fileGraphIri } from '../src/graph';
import { OxigraphStore } from 'rdf-files';
import { project } from './project-full';
import { viewRead } from '../src/view-read';
import { migrationCount } from '../src/shape-ops';
import { SKOLEM_BASE, skolemize } from '../src/skolem';
import { canonical } from '../src/trig';
import { rdf } from '../src/terms';
import { emptyMetamodel, metamodelFromQuads } from '../src/shapes';
import { S } from '../src/shapes-read';
import { elementId } from '../src/ids';
const NS_SKOS = 'http://www.w3.org/2004/02/skos/core#';
import { DCAT, DCT, parseQuads, run } from './helpers';

const TTL = readFileSync(new URL('./fixtures/dcat-shapes.ttl', import.meta.url), 'utf8');
const FILE = '/tmp/dcat-shapes.ttl';
const EX = 'http://example.org/shapes#';
const GRAPH = rdf.namedNode(fileGraphIri(FILE));

/** The shapes file as the store reads it: blank nodes replaced by IRIs (see skolem.ts). */
async function load(data = ''): Promise<ModelGraph> {
    const g = new ModelGraph(new OxigraphStore());
    g.setShapesGraphs([...g.shapesGraphs(), GRAPH]);
    for (const q of skolemize(await parseQuads(TTL)).quads) g.store.add(rdf.quad(q.subject, q.predicate, q.object, GRAPH));
    for (const q of data ? await parseQuads(data) : []) g.store.add(rdf.quad(q.subject, q.predicate, q.object, g.model));
    return g;
}
const shapesOf = (g: ModelGraph) => project(g).doc.shapes;
const shapeId = (g: ModelGraph, iri: string) => Object.values(shapesOf(g).nodeShapes).find(s => s.uri === iri)!.id;
const prop = (g: ModelGraph, owner: string, path: string) => Object.values(shapesOf(g).properties)
    .find(p => p.owner === shapeId(g, owner) && formatPath(p.path) === path)!;
const exec = (g: ModelGraph, c: Parameters<typeof executeCommand>[2]) => run(g, emptyMetamodel(), c);
/** The diagram of a view: the read model of the whole model and the figures of the notation engine. */
const schema = (g: ModelGraph, view: string) => toSchema(project(g).doc, { classes: [] }, view, {
    showHidden: false, violations: [], notation: viewFigures(storeIndex(g), readNotations(), idIri(view)!)
}).children!;
/** Blank nodes of the shapes graph: only the path expressions of the file (sequence and alternative path) stay. */
const blanks = (g: ModelGraph) => new Set(g.match(null, null, null, GRAPH).flatMap(q => [q.subject, q.object]).filter(t => t.termType === 'BlankNode').map(t => t.value)).size;
const shapesCanonical = (g: ModelGraph) => canonical(g.match(null, null, null, GRAPH).map(q => rdf.quad(q.subject, q.predicate, q.object)));

describe('shapes graphs to the shapes read model', () => {
    it('replaces subject targets across source graphs without copying retained values', async () => {
        const g = await load();
        const second = rdf.namedNode(fileGraphIri('/tmp/extra-shapes.ttl'));
        g.setShapesGraphs([...g.shapesGraphs(), second]);
        const shape = rdf.namedNode(EX + 'Dataset');
        const first = rdf.namedNode(EX + 'first'), kept = rdf.namedNode(EX + 'kept');
        g.add(shape, S.targetSubjectsOf, first, GRAPH);
        g.add(shape, S.targetSubjectsOf, kept, second);
        const id = elementId(shape);
        const { patch } = g.transact(x => executeCommand(x, emptyMetamodel(), {
            kind: 'setNodeShape', id, patch: { targetSubjectsOf: [kept.value, EX + 'new'] }
        }));
        expect(g.match(shape, S.targetSubjectsOf, first)).toHaveLength(0);
        expect(g.match(shape, S.targetSubjectsOf, kept).map(q => q.graph.value)).toEqual([second.value]);
        expect(g.match(shape, S.targetSubjectsOf, rdf.namedNode(EX + 'new'), GRAPH)).toHaveLength(1);
        g.undo(patch);
        expect(g.match(shape, S.targetSubjectsOf, first, GRAPH)).toHaveLength(1);
        expect(g.match(shape, S.targetSubjectsOf, kept, second)).toHaveLength(1);
        exec(g, { kind: 'setNodeShape', id, patch: { targetSubjectsOf: [] } });
        expect(g.match(shape, S.targetSubjectsOf)).toHaveLength(0);
    });

    it('reads node shapes, ranges, complex paths and the sh:or constraint', async () => {
        const g = await load();
        const s = shapesOf(g);
        expect(Object.values(s.nodeShapes).map(n => n.label).sort()).toEqual(['Catalogue', 'Data asset', 'Linguistic system', 'Software agent']);
        expect(prop(g, EX + 'Dataset', 'dcat:theme').range).toEqual({ kind: 'scheme', schemes: ['http://example.org/vocab#product-domain'] });
        expect(prop(g, EX + 'Dataset', 'dcat:theme').nodeKind).toBe('IRI');
        expect(prop(g, EX + 'Dataset', 'dct:language').range).toEqual({ kind: 'class', class: DCT + 'LinguisticSystem' });
        expect(prop(g, EX + 'Dataset', 'dcat:qualifiedRelation/prov:agent').range).toEqual({ kind: 'node', shape: shapeId(g, EX + 'SoftwareAgent') });
        expect(prop(g, EX + 'Dataset', 'dct:isPartOf|dct:hasPart').range.kind).toBe('node');
        expect(prop(g, EX + 'Dataset', 'dct:issued').raw).toEqual(['sh:uniqueLang "true"']);
        const or = Object.values(s.constraints)[0];
        expect(or.operator).toBe('or');
        expect(or.members.map(m => formatPath(s.properties[m].path)).sort()).toEqual(['dcat:keyword', 'dct:description']);
        expect(verbalizeConstraint(s, or)).toBe('Each Data asset has either one or more dct:description (rdf:langString) or one or more dcat:keyword (xsd:string) (or).');
        expect(verbalizeProperty(s, prop(g, EX + 'Dataset', 'dct:title'))).toBe('Each Data asset has exactly one dct:title, each a xsd:string.');
    });

    it('replaces every blank node by a skolem IRI, path expressions too', async () => {
        const g = await load();
        const s = shapesOf(g);
        expect(blanks(g)).toBe(0);
        expect(prop(g, EX + 'Dataset', 'dct:title').uri?.startsWith(SKOLEM_BASE)).toBe(true);
        // The nested scheme shape is not a node shape of the model.
        expect(Object.values(s.nodeShapes).some(n => n.uri.startsWith(SKOLEM_BASE))).toBe(false);
        expect(Object.values(s.valueSets).map(v => [v.kind, v.label, v.members.map(m => m.label)])).toEqual([['scheme', 'Product domain', ['Product analytics']]]);
    });

    it('maps sh:targetSubjectsOf without treating its predicate as a class', async () => {
        const g = await load(`<${EX}subject> <${EX}status> "active" .`);
        const shape = rdf.namedNode(EX + 'StatusSubject');
        const predicate = rdf.namedNode(EX + 'status');
        g.add(shape, S.type, S.NodeShape, GRAPH);
        g.add(shape, S.targetSubjectsOf, predicate, GRAPH);
        g.add(shape, S.targetSubjectsOf, rdf.namedNode(EX + 'phase'), GRAPH);
        const id = elementId(shape);

        expect(shapesOf(g).nodeShapes[id]).toMatchObject({ uri: shape.value, targetSubjectsOf: [EX + 'phase', predicate.value] });
        expect(shapesOf(g).nodeShapes[id].targetClass).toBeUndefined();
        expect(shapesOf(g).nodeShapes[id].raw).not.toContain(`sh:targetSubjectsOf <${predicate.value}>`);
        const view = exec(g, { kind: 'createView', label: 'Subject targets' }) as string;
        exec(g, { kind: 'addToView', view, ids: [id], at: { x: 0, y: 0 } });
        expect(schema(g, view).filter(x => x.type === 'node:shape').map(x => x.element)).toEqual([id]);

        exec(g, { kind: 'setNodeShape', id, patch: { targetSubjectsOf: [EX + 'phase'] } });
        expect(g.match(shape, S.targetSubjectsOf, predicate, GRAPH)).toHaveLength(0);
        expect(g.match(shape, S.targetSubjectsOf, rdf.namedNode(EX + 'phase'), GRAPH)).toHaveLength(1);
        exec(g, { kind: 'setNodeShape', id, patch: { targetSubjectsOf: [EX + 'phase', EX + 'status', EX + 'status'] } });
        expect(shapesOf(g).nodeShapes[id].targetSubjectsOf).toEqual([EX + 'phase', EX + 'status']);
        expect(shapesOf(g).nodeShapes[id].raw.some(r => r.startsWith('sh:targetSubjectsOf'))).toBe(false);
        exec(g, { kind: 'setNodeShape', id, patch: { targetSubjectsOf: [] } });
        expect(g.match(shape, S.targetSubjectsOf, null, GRAPH)).toHaveLength(0);
    });


    it('keeps the shapes graphs out of the views and the view warnings', async () => {
        const g = await load();
        const p = project(g);
        expect(Object.keys(p.doc.views)).toEqual([]);
        expect(p.warnings.filter(w => w.includes('urn:file:'))).toEqual([]);
    });
});

describe('shape edits', () => {
    it('creates a node shape in the primary shapes graph; one view shows node shapes and instances', async () => {
        const g = await load(`<urn:d1> a <${DCAT}Dataset> ; <${DCT}title> "One" .`);
        const view = exec(g, { kind: 'createView', label: 'Catalog' }) as string;
        const id = exec(g, { kind: 'createNodeShape', label: 'Role', view, at: { x: 0, y: 0 } }) as string;
        const d = project(g).doc;
        expect(boxes(d.views[view], 'card').map(n => n.element)).toEqual([id]);
        expect(d.shapes.nodeShapes[id]).toMatchObject({ label: 'Role', file: FILE });
        const instance = Object.values(d.instances).find(i => i.uri === 'urn:d1')!.id;
        exec(g, { kind: 'addToView', view, ids: [instance], at: { x: 400, y: 0 } });
        const kids = schema(g, view);
        expect(kids.filter(k => k.type === 'node:shape').map(k => k.element)).toEqual([id]);
        expect(kids.filter(k => k.type === 'node:card').map(k => k.element)).toEqual([instance]);
    });

    it('a rename with a target class names a node shape and sets its target class', async () => {
        const g = await load('');
        const id = exec(g, { kind: 'createNodeShape', label: 'unnamed shape 1' }) as string;
        exec(g, { kind: 'rename', id, label: 'Role', targetClass: termIri('Role')! });
        expect(shapesOf(g).nodeShapes[id]).toMatchObject({ label: 'Role', targetClass: termIri('Role') });
    });

    it('a node shape IRI gets " shape" once: a label that ends with " shape" gets no second one', async () => {
        const g = await load('');
        const one = exec(g, { kind: 'createNodeShape', label: 'Distribution' }) as string;
        const two = exec(g, { kind: 'createNodeShape', label: 'Item shape' }) as string;
        const shapes = project(g).doc.shapes.nodeShapes;
        expect(shapes[one].uri).toBe('urn:name:Distribution%20shape');
        expect(shapes[two]).toMatchObject({ label: 'Item shape', uri: 'urn:name:Item%20shape' });
    });

    it('a shape wins: an IRI that is a node shape and an instance is a shape card', async () => {
        const g = await load(`<${EX}Dataset> a <${DCAT}Dataset> ; <${DCT}title> "Punned" .`);
        const dataset = shapeId(g, EX + 'Dataset');
        expect(project(g).doc.instances[dataset]).toBeDefined();
        const view = exec(g, { kind: 'createView', label: 'V' }) as string;
        exec(g, { kind: 'addToView', view, ids: [dataset], at: { x: 0, y: 0 } });
        const kids = schema(g, view);
        expect(kids.filter(k => k.element === dataset).map(k => k.type)).toEqual(['node:shape']);
    });

    it('draws properties as rows until shown as lines; an unplaced constraint is a row group; a hub places its member lines', async () => {
        const g = await load();
        const view = exec(g, { kind: 'createView', label: 'Detail' }) as string;
        const dataset = shapeId(g, EX + 'Dataset'), agent = shapeId(g, EX + 'SoftwareAgent');
        exec(g, { kind: 'addToView', view, ids: [dataset], at: { x: 0, y: 0 } });
        const kids = () => schema(g, view);
        const rows = () => kids().find(k => k.type === 'node:shape' && k.name === 'Data asset')!.children!.filter(c => c.type === 'label:row').map(r => (r as { id: string }).id);
        // Edge ends are diagram ids: a card is its placement; compare by its element.
        const edges = () => kids().filter(k => k.type === 'edge:property').map(e => [e.name, elementOfId(project(g).doc.views[view], e.targetId as string)]);
        // The card arrives (rule 11): its property to itself (isPartOf|hasPart) is a line, and the hub of its sh:or, whose member lines end
        // at private pills (one per line). The other properties (theme, a scheme, too) are rows.
        const or = Object.values(shapesOf(g).constraints)[0];
        const hub = () => kids().filter(k => k.type === 'node:logic').map(k => [k.id, (k.members as string[]).slice().sort()]);
        expect(edges().map(e => e[0]).sort()).toEqual(['dcat:keyword', 'dct:description', 'dct:isPartOf|dct:hasPart']);
        expect(hub()).toEqual([[or.id, or.members.slice().sort()]]);
        expect(kids().filter(k => k.type === 'node:leaf' && k.private)).toHaveLength(2);
        expect(rows().length).toBe(6);
        // The software agent arrives: the relation to it is a line to its card.
        exec(g, { kind: 'addToView', view, ids: [agent], at: { x: 900, y: 50 } });
        expect(edges()).toContainEqual(['dcat:qualifiedRelation/prov:agent', agent]);
        // Del on a member line removes the hub unit: the constraint is a row group (its row, then its members).
        exec(g, { kind: 'removeFromView', view, ids: [or.members[0]] });
        expect(hub()).toEqual([]);
        expect(rows()).toContain(or.id);
        expect(rows()).toEqual(expect.arrayContaining(or.members));
        // Show as Line of the constraint (⇥ on the row group): the hub unit again.
        exec(g, { kind: 'showAsEdge', view, id: or.id, at: { x: 700, y: 300 } });
        expect(hub()).toEqual([[or.id, or.members.slice().sort()]]);
        expect(rows()).not.toContain(or.id);
        // A datatype end is private: such a property is a row, Show as Line refuses it.
        const title = prop(g, EX + 'Dataset', 'dct:title');
        expect(() => exec(g, { kind: 'showAsEdge', view, id: title.id, at: { x: 700, y: 400 } })).toThrow(/datatype/);
        expect(rows()).toContain(title.id);
        // Show the theme (a scheme) as an edge: one step adds the property node and the scheme card (with its concepts) at the point.
        const scheme = Object.keys(shapesOf(g).valueSets)[0];
        const theme = Object.values(shapesOf(g).properties).find(p => formatPath(p.path) === 'dcat:theme')!;
        const { patch } = g.transact(x => executeCommand(x, emptyMetamodel(), { kind: 'showAsEdge', view, id: theme.id, at: { x: 600, y: 600 } }));
        expect(edges()).toContainEqual(['dcat:theme', scheme]);
        expect(rows()).not.toContain(theme.id);
        const card = kids().find(k => k.element === scheme)!;
        expect(card).toMatchObject({ type: 'node:valueset', kind: 'scheme', name: 'Product domain' });
        expect(boxes(project(g).doc.views[view], 'card').find(b => b.element === scheme)).toBeDefined();
        g.undo(patch);
        expect(rows()).toContain(theme.id);
        expect(kids().find(k => k.element === scheme)).toBeUndefined();
    });

    it('a scheme card anchored by its only edge leaves the view with the edge; a card with another edge stays', async () => {
        const g = await load();
        const view = exec(g, { kind: 'createView', label: 'V' }) as string;
        const dataset = shapeId(g, EX + 'Dataset'), agent = shapeId(g, EX + 'SoftwareAgent');
        exec(g, { kind: 'addToView', view, ids: [dataset, agent], at: { x: 0, y: 0 } });
        const scheme = Object.keys(shapesOf(g).valueSets)[0];
        const theme = prop(g, EX + 'Dataset', 'dcat:theme');
        const cards = () => boxes(project(g).doc.views[view], 'card').map(b => b.element);
        // One edge to the scheme card: back to a row, the card leaves (one undo step).
        exec(g, { kind: 'showAsEdge', view, id: theme.id, at: { x: 600, y: 600 } });
        expect(cards()).toContain(scheme);
        const { patch } = g.transact(x => executeCommand(x, emptyMetamodel(), { kind: 'removeFromView', view, ids: [propertyNodeId(theme)] }));
        expect(cards()).not.toContain(scheme);
        g.undo(patch);
        expect(cards()).toContain(scheme);
        // A second property to the same scheme, also an edge: the card has two edges and stays when one returns to a row.
        g.store.add(rdf.quad(rdf.namedNode(EX + 'SoftwareAgent'), rdf.namedNode('http://www.w3.org/ns/shacl#property'), rdf.namedNode(EX + 'agentTheme'), GRAPH));
        g.store.add(rdf.quad(rdf.namedNode(EX + 'agentTheme'), rdf.namedNode('http://www.w3.org/ns/shacl#path'), rdf.namedNode(DCAT + 'theme'), GRAPH));
        for (const q of g.match(rdf.namedNode(theme.uri!), rdf.namedNode('http://www.w3.org/ns/shacl#node'), null, GRAPH)) g.store.add(rdf.quad(rdf.namedNode(EX + 'agentTheme'), q.predicate, q.object, GRAPH));
        g.invalidate();
        const agentTheme = prop(g, EX + 'SoftwareAgent', 'dcat:theme');
        expect(agentTheme.range).toEqual(theme.range);
        exec(g, { kind: 'showAsEdge', view, id: agentTheme.id, at: { x: 600, y: 600 } });
        exec(g, { kind: 'removeFromView', view, ids: [propertyNodeId(theme)] });
        expect(cards()).toContain(scheme);
        exec(g, { kind: 'removeFromView', view, ids: [propertyNodeId(agentTheme)] });
        expect(cards()).not.toContain(scheme);
    });

    it('shows a node-range property as an edge to its node shape card: the card joins the view once', async () => {
        const g = await load();
        const view = exec(g, { kind: 'createView', label: 'V' }) as string;
        const dataset = shapeId(g, EX + 'Dataset'), agent = shapeId(g, EX + 'SoftwareAgent');
        exec(g, { kind: 'addToView', view, ids: [dataset], at: { x: 0, y: 0 } });
        const agentRel = prop(g, EX + 'Dataset', 'dcat:qualifiedRelation/prov:agent');
        exec(g, { kind: 'showAsEdge', view, id: agentRel.id, at: { x: 900, y: 50 } });
        const cards = () => boxes(project(g).doc.views[view], 'card').map(b => b.element);
        expect(cards()).toContain(agent);
        const kids = schema(g, view);
        expect(kids.filter(k => k.type === 'edge:property').map(e => [e.id, elementOfId(project(g).doc.views[view], e.targetId as string)])).toContainEqual([agentRel.id, agent]);
        expect(kids.filter(k => k.type === 'node:leaf' && k.id.startsWith(propertyNodeId(agentRel)))).toEqual([]);
    });

    it('a card that arrives: its properties to and from the cards of the view become edges, in the same undo step', async () => {
        const g = await load();
        const view = exec(g, { kind: 'createView', label: 'V' }) as string;
        const dataset = shapeId(g, EX + 'Dataset'), agent = shapeId(g, EX + 'SoftwareAgent');
        exec(g, { kind: 'addToView', view, ids: [agent], at: { x: 900, y: 0 } });
        const agentRel = prop(g, EX + 'Dataset', 'dcat:qualifiedRelation/prov:agent');
        const edges = () => schema(g, view)
            .filter(k => k.type === 'edge:property').map(e => [e.id, elementOfId(project(g).doc.views[view], e.targetId as string)]);
        const { patch } = g.transact(x => executeCommand(x, emptyMetamodel(), { kind: 'addToView', view, ids: [dataset], at: { x: 0, y: 0 } }));
        expect(edges()).toContainEqual([agentRel.id, agent]);
        g.undo(patch);
        expect(boxes(project(g).doc.views[view], 'card').map(b => b.element)).toEqual([agent]);
        // Incoming: the owner is in the view, the target arrives.
        exec(g, { kind: 'removeFromView', view, ids: [agent] });
        exec(g, { kind: 'addToView', view, ids: [dataset], at: { x: 0, y: 0 } });
        expect(edges()).not.toContainEqual([agentRel.id, agent]);
        exec(g, { kind: 'addToView', view, ids: [agent], at: { x: 900, y: 0 } });
        expect(edges()).toContainEqual([agentRel.id, agent]);
        // Show as Row: a row until the next arrival.
        exec(g, { kind: 'removeFromView', view, ids: [propertyNodeId(agentRel)] });
        expect(edges()).not.toContainEqual([agentRel.id, agent]);
        expect(boxes(project(g).doc.views[view], 'card').map(b => b.element)).toContain(agent);
    });

    it('a target that leaves the view: its edges become rows; a new property between two cards of the view is an edge', async () => {
        const g = await load();
        const view = exec(g, { kind: 'createView', label: 'V' }) as string;
        const dataset = shapeId(g, EX + 'Dataset'), agent = shapeId(g, EX + 'SoftwareAgent');
        exec(g, { kind: 'addToView', view, ids: [dataset, agent], at: { x: 0, y: 0 } });
        const agentRel = prop(g, EX + 'Dataset', 'dcat:qualifiedRelation/prov:agent');
        const placed = () => boxes(project(g).doc.views[view], 'card').map(b => b.element);
        expect(placed()).toContain(propertyNodeId(agentRel));
        exec(g, { kind: 'removeFromView', view, ids: [agent] });
        expect(placed()).not.toContain(propertyNodeId(agentRel));
        exec(g, { kind: 'addToView', view, ids: [agent], at: { x: 900, y: 0 } });
        const created = exec(g, { kind: 'createPropertyShape', shape: agent, path: { kind: 'iri', iri: EX + 'peer' }, range: { kind: 'node', shape: dataset } }) as string;
        expect(placed()).toContain(propertyNodeId(shapesOf(g).properties[created]));
    });

    it('a class pill is the element of its IRI: one per view; Show as Line places only its line; an arrival from elsewhere places all', async () => {
        const g = await load();
        const view = exec(g, { kind: 'createView', label: 'V' }) as string;
        const dataset = shapeId(g, EX + 'Dataset'), agent = shapeId(g, EX + 'SoftwareAgent');
        exec(g, { kind: 'addToView', view, ids: [dataset, agent], at: { x: 0, y: 0 } });
        // Two properties with one class that no node shape targets; the pill is not in the view, so they are rows.
        const cls = EX + 'Code';
        const ids = [[dataset, 'code'], [agent, 'agentCode']].map(([shape, name]) =>
            exec(g, { kind: 'createPropertyShape', shape, path: { kind: 'iri', iri: EX + name }, range: { kind: 'class', class: cls } }) as string);
        const coded = ids.map(id => shapesOf(g).properties[id]);
        const pill = iriId(cls);
        const card = () => boxes(project(g).doc.views[view], 'card').find(b => b.element === pill);
        const kids = () => schema(g, view);
        expect(card()).toBeUndefined();
        const edgesToPill = () => kids().filter(k => k.type === 'edge:property' && k.targetId === card()?.id).map(k => k.id).sort();
        // Show as Line places the pill from the property: it does not arrive. Only that property is a line; the other row has a dashed edge.
        exec(g, { kind: 'showAsEdge', view, id: coded[0].id, at: { x: 700, y: 300 } });
        expect(edgesToPill()).toEqual([ids[0]]);
        expect(kids().filter(k => k.type === 'edge:latent').map(k => k.id)).toContain(ids[1] + '_latent');
        // Back to a row: the pill leaves with its last line (nt:keptByLines).
        exec(g, { kind: 'removeFromView', view, ids: [propertyNodeId(coded[0])] });
        expect(card()).toBeUndefined();
        // The pill arrives from elsewhere (Add to View, paste): every property of the view with this class is a line to it. One pill.
        exec(g, { kind: 'addToView', view, ids: [pill], at: { x: 700, y: 300 } });
        expect(edgesToPill()).toEqual(ids.slice().sort());
        expect(kids().filter(k => k.type === 'node:leaf' && k.id === card()!.id)).toHaveLength(1);
        // The read model of one view (the canvas and layout read it) places the pill as the read model of the whole model does.
        const whole = project(g).doc.views[view];
        expect(viewRead({ g, shapes: shapesOf(g) }, rdf.namedNode(whole.uri)).views[view]).toEqual(whole);
        exec(g, { kind: 'removeFromView', view, ids: [propertyNodeId(coded[0])] });
        expect(card()).toBeDefined();
        exec(g, { kind: 'removeFromView', view, ids: [propertyNodeId(coded[1])] });
        expect(card()).toBeUndefined();
    });

    it('a pill leaves with the owner cards of its last edges; a new IRI of a property keeps its row', async () => {
        const g = await load();
        const view = exec(g, { kind: 'createView', label: 'V' }) as string;
        const dataset = shapeId(g, EX + 'Dataset'), agent = shapeId(g, EX + 'SoftwareAgent');
        exec(g, { kind: 'addToView', view, ids: [dataset, agent], at: { x: 0, y: 0 } });
        const placed = () => boxes(project(g).doc.views[view], 'card').map(b => b.element);
        // A row whose target is in the view: a new IRI of the property is not a new property, so it stays a row.
        const agentRel = prop(g, EX + 'Dataset', 'dcat:qualifiedRelation/prov:agent');
        exec(g, { kind: 'removeFromView', view, ids: [propertyNodeId(agentRel)] });
        const renamed = exec(g, { kind: 'setUri', id: agentRel.id, uri: EX + 'agentRelation' }) as string;
        expect(placed()).not.toContain(propertyNodeId(shapesOf(g).properties[renamed]));
        // The only line to a class pill loses its owner card: the line goes and the pill leaves.
        const code = exec(g, { kind: 'createPropertyShape', shape: agent, path: { kind: 'iri', iri: EX + 'code' }, range: { kind: 'class', class: EX + 'Code' } }) as string;
        exec(g, { kind: 'showAsEdge', view, id: code, at: { x: 700, y: 300 } });
        expect(placed()).toContain(iriId(EX + 'Code'));
        exec(g, { kind: 'removeFromView', view, ids: [agent] });
        expect(placed()).not.toContain(iriId(EX + 'Code'));
        expect(placed()).not.toContain(propertyNodeId(shapesOf(g).properties[code]));
    });

    it('a shared property: the id of either owner shows it as a line and puts it back (one placement)', async () => {
        const g = await load();
        const dataset = shapeId(g, EX + 'Dataset'), agent = shapeId(g, EX + 'SoftwareAgent');
        const title = prop(g, EX + 'Dataset', 'dct:language');
        g.add(rdf.namedNode(EX + 'SoftwareAgent'), S.property, rdf.namedNode(title.uri!), GRAPH);
        const view = exec(g, { kind: 'createView', label: 'V' }) as string;
        exec(g, { kind: 'addToView', view, ids: [dataset, agent], at: { x: 0, y: 0 } });
        const alias = Object.values(shapesOf(g).properties).find(p => p.uri === title.uri && p.id !== title.id)!;
        const edges = () => schema(g, view)
            .filter(c => c.type === 'edge:property' && (c.id === title.id || c.id === alias.id)).map(c => elementOfId(project(g).doc.views[view], c.sourceId as string)).sort();
        exec(g, { kind: 'showAsEdge', view, id: alias.id, at: { x: 700, y: 0 } });
        expect(edges()).toEqual([dataset, agent].sort());
        exec(g, { kind: 'removeFromView', view, ids: [propertyNodeId(alias)] });
        expect(edges()).toEqual([]);
    });

    it('returning a shared property restores all containing cards in this view only, with one undo patch and no shapes change', async () => {
        const g = await load();
        const dataset = shapeId(g, EX + 'Dataset'), agent = shapeId(g, EX + 'SoftwareAgent');
        const title = prop(g, EX + 'Dataset', 'dct:language');
        g.add(rdf.namedNode(EX + 'SoftwareAgent'), S.property, rdf.namedNode(title.uri!), GRAPH);
        const views = ['V1', 'V2'].map(label => exec(g, { kind: 'createView', label }) as string);
        for (const view of views) {
            exec(g, { kind: 'addToView', view, ids: [dataset, agent], at: { x: 0, y: 0 } });
            exec(g, { kind: 'showAsEdge', view, id: title.id, at: { x: 700, y: 0 } });
        }
        const before = await shapesCanonical(g);
        const shared = new Set(Object.values(shapesOf(g).properties).filter(p => p.uri === title.uri).map(p => p.id));
        expect(shared.size).toBe(2);
        const rows = (view: string) => schema(g, view)
            .filter(c => c.children?.some(r => r.type === 'label:row' && shared.has(r.id))).map(c => c.element).sort();
        expect(rows(views[0])).toEqual([]);
        const { patch } = g.transact(x => executeCommand(x, emptyMetamodel(), { kind: 'removeFromView', view: views[0], ids: [title.id] }));
        expect(rows(views[0])).toEqual([dataset, agent].sort());
        expect(rows(views[1])).toEqual([]);
        expect(await shapesCanonical(g)).toBe(before);
        g.undo(patch);
        expect(rows(views[0])).toEqual([]);
        g.redo(patch);
        expect(rows(views[0])).toEqual([dataset, agent].sort());
        expect(await shapesCanonical(g)).toBe(before);
    });

    it('set IRI of a node shape, a property shape and a value set: shapes graphs and views follow, the data does not', async () => {
        const g = await load(`<urn:d1> a <${EX}Dataset> ; <${DCT}title> "One" .`);
        const dataset = shapeId(g, EX + 'Dataset');
        const view = exec(g, { kind: 'createView', label: 'V' }) as string;
        exec(g, { kind: 'addToView', view, ids: [dataset], at: { x: 0, y: 0 } });
        const { result, patch } = g.transact(x => executeCommand(x, emptyMetamodel(), { kind: 'setUri', id: dataset, uri: EX + 'DatasetShape' }));
        const moved = result.ok ? result.value as string : '';
        expect(shapesOf(g).nodeShapes[moved]?.uri).toBe(EX + 'DatasetShape');
        // The card and the edge of its property to itself; a new IRI is not an arrival, so no other edge is added.
        const self = Object.values(shapesOf(g).properties).find(p => p.owner === moved && p.range.kind === 'node' && p.range.shape === moved)!;
        expect(boxes(project(g).doc.views[view], 'card').map(n => n.element).sort()).toEqual([moved, propertyNodeId(self)].sort());
        // The data keeps its class; the old IRI was the implicit target class: a migration is proposed.
        expect(g.match(rdf.namedNode('urn:d1'), null, rdf.namedNode(EX + 'Dataset')).length).toBe(1);
        expect(g.proposed.map(p => p.change)).toEqual([{ kind: 'renameClass', from: EX + 'Dataset', to: EX + 'DatasetShape' }]);
        g.undo(patch);
        expect(shapesOf(g).nodeShapes[dataset]?.uri).toBe(EX + 'Dataset');

        const title = prop(g, EX + 'Dataset', 'dct:title');
        const renamed = exec(g, { kind: 'setUri', id: title.id, uri: EX + 'title' }) as string;
        expect(shapesOf(g).properties[renamed]).toMatchObject({ uri: EX + 'title', owner: dataset });
        const minted = exec(g, { kind: 'setUri', id: renamed, uri: '' }) as string;
        expect(shapesOf(g).properties[minted].uri).toBe(EX + 'Dataset-title');
        expect(() => exec(g, { kind: 'setUri', id: minted, uri: EX + 'Dataset' })).toThrow(/already used/);

        const area = Object.values(shapesOf(g).valueSets).find(v => v.uri === 'http://example.org/vocab#product-domain')!;
        const users = () => Object.values(shapesOf(g).properties).filter(p => p.range.kind === 'scheme').map(p => p.range);
        const before = users().length;
        const areaId = exec(g, { kind: 'setUri', id: area.id, uri: EX + 'areas' }) as string;
        expect(shapesOf(g).valueSets[areaId]?.uri).toBe(EX + 'areas');
        // The ranges that pointed at the scheme point at the new IRI.
        expect(users().filter(r => r.kind === 'scheme' && r.schemes.includes(EX + 'areas'))).toHaveLength(before);
    });

    it('renames a path, proposes the data migration, and applies it to instances of the target class', async () => {
        const g = await load(`<urn:d1> a <${DCAT}Dataset> ; <${DCT}title> "One" . <urn:c1> a <${DCAT}Catalog> ; <${DCT}title> "Cat" .`);
        const title = prop(g, EX + 'Dataset', 'dct:title');
        const { result, patch } = g.transact(x => executeCommand(x, emptyMetamodel(), {
            kind: 'setPropertyShape', id: title.id, patch: { path: { kind: 'iri', iri: DCT + 'alternative' } }
        }));
        expect(result.ok && patch.length).toBeTruthy();
        expect(g.proposed.map(p => p.change)).toEqual([{ kind: 'renamePredicate', classIri: DCAT + 'Dataset', from: DCT + 'title', to: DCT + 'alternative' }]);
        const change = g.proposed[0].change;
        expect(migrationCount(g, change)).toBe(1);
        exec(g, { kind: 'migrateData', migration: change });
        expect(g.match(rdf.namedNode('urn:d1'), rdf.namedNode(DCT + 'alternative')).length).toBe(1);
        // The catalogue keeps dct:title: it is not an instance of the target class.
        expect(g.match(rdf.namedNode('urn:c1'), rdf.namedNode(DCT + 'title')).length).toBe(1);
    });

    it('groups two edges into sh:or and ungroups them back to the same statements', async () => {
        const g = await load();
        const before = shapesCanonical(g);
        const hasData = prop(g, EX + 'Dataset', '<http://example.org/vocab#hasData>'), language = prop(g, EX + 'Dataset', 'dct:language');
        const cid = exec(g, { kind: 'groupProperties', ids: [hasData.id, language.id] }) as string;
        const s = shapesOf(g);
        expect(s.constraints[cid].members.sort()).toEqual([hasData.id, language.id].sort());
        expect(s.properties[hasData.id].constraint).toBe(cid);
        exec(g, { kind: 'setConstraint', id: cid, operator: 'xone' });
        const xone = Object.values(shapesOf(g).constraints).find(c => c.operator === 'xone')!;
        exec(g, { kind: 'ungroup', id: xone.id });
        expect(shapesCanonical(g)).toBe(before);
    });

    it('grouping two shown lines places the hub of the new constraint; ungrouping removes the hub placement', async () => {
        const g = await load();
        const view = exec(g, { kind: 'createView', label: 'V' }) as string;
        exec(g, { kind: 'addToView', view, ids: [shapeId(g, EX + 'Dataset')], at: { x: 0, y: 0 } });
        const language = prop(g, EX + 'Dataset', 'dct:language'), theme = prop(g, EX + 'Dataset', 'dcat:theme');
        for (const p of [language, theme]) exec(g, { kind: 'showAsEdge', view, id: p.id, at: { x: 700, y: 0 } });
        const logic = () => schema(g, view).filter(k => k.type === 'node:logic').map(k => k.id).sort();
        expect(logic()).toHaveLength(1);
        // The new list can take the position of the old one (rule 12, by member text): the old hub placement moves with its list.
        const cid = exec(g, { kind: 'groupProperties', ids: [language.id, theme.id] }) as string;
        expect(logic()).toEqual(Object.keys(shapesOf(g).constraints).sort());
        expect(logic()).toHaveLength(2);
        // The members are drawn by the hub: they have no placement of their own.
        expect(boxes(project(g).doc.views[view], 'card').map(b => b.element)).not.toContain(propertyNodeId(shapesOf(g).properties[language.id]));
        exec(g, { kind: 'ungroup', id: cid });
        expect(logic()).toHaveLength(1);
    });

    it('adds an edge to an existing constraint, takes it out again, and deletes a member', async () => {
        const g = await load();
        const or = Object.values(shapesOf(g).constraints)[0];
        const title = prop(g, EX + 'Dataset', 'dct:title');
        exec(g, { kind: 'groupProperties', ids: [or.id, title.id] });
        expect(Object.values(shapesOf(g).constraints)[0].members.length).toBe(3);
        exec(g, { kind: 'takeOutOfConstraint', id: title.id });
        expect(Object.values(shapesOf(g).constraints)[0].members.length).toBe(2);
        // A list with one member left is dissolved.
        exec(g, { kind: 'delete', ids: [Object.values(shapesOf(g).constraints)[0].members[0]] });
        expect(Object.values(shapesOf(g).constraints)).toEqual([]);
    });

    it('creates a property shape with an IRI (simple paths only), changes range and cardinality, and deletes a node shape with its references', async () => {
        const g = await load();
        const before = blanks(g);
        const agent = shapeId(g, EX + 'SoftwareAgent'), dataset = shapeId(g, EX + 'Dataset');
        const inverse = executeCommand(g, emptyMetamodel(), { kind: 'createPropertyShape', shape: agent, path: (parsePath('^prov:wasAttributedTo') as { path: never }).path, range: { kind: 'any' } });
        expect(inverse.ok).toBe(false);
        const pid = exec(g, { kind: 'createPropertyShape', shape: agent, path: { kind: 'iri', iri: 'http://www.w3.org/ns/prov#wasAttributedTo' }, range: { kind: 'node', shape: dataset } }) as string;
        const p = shapesOf(g).properties[pid];
        expect(g.match(rdf.namedNode(EX + 'SoftwareAgent-wasAttributedTo'), null, null, GRAPH).length).toBeGreaterThan(0);
        expect(cardinalityText(p.minCount, p.maxCount)).toBe('0..*');
        const next = exec(g, { kind: 'setPropertyShape', id: pid, patch: { ...nextCardinality(p.minCount, p.maxCount), range: { kind: 'datatype', datatype: 'http://www.w3.org/2001/XMLSchema#string' } } }) as string;
        expect(next).toBe(pid);
        expect(shapesOf(g).properties[pid]).toMatchObject({ maxCount: 1, range: { kind: 'datatype' } });
        exec(g, { kind: 'setPropertyShape', id: pid, patch: { languageIn: ['en', 'de'] } });
        expect(blanks(g)).toBe(before);
        exec(g, { kind: 'delete', ids: [agent] });
        const after = shapesOf(g);
        expect(after.nodeShapes[agent]).toBeUndefined();
        // Its property shape and list cells go with it.
        expect(g.match(null, null, null, GRAPH).some(q => q.subject.value.startsWith(EX + 'SoftwareAgent'))).toBe(false);
        // The sh:node reference to the deleted shape is gone: the edge has no range any more.
        expect(prop(g, EX + 'Dataset', 'dcat:qualifiedRelation/prov:agent').range).toEqual({ kind: 'any' });
    });

    it('logical constraints are lists with IRI cells', async () => {
        const g = await load();
        const before = blanks(g);
        const title = prop(g, EX + 'Dataset', 'dct:title'), language = prop(g, EX + 'Dataset', 'dct:language');
        const cid = exec(g, { kind: 'groupProperties', ids: [title.id, language.id], operator: 'and' }) as string;
        expect(shapesOf(g).constraints[cid].members.sort()).toEqual([title.id, language.id].sort());
        expect(g.match(rdf.namedNode(EX + 'Dataset'), rdf.namedNode('http://www.w3.org/ns/shacl#and'), null, GRAPH)[0].object.value).toBe(EX + 'Dataset-and');
        expect(blanks(g)).toBe(before);
    });

    it('a scheme and a concept of the data file dropped from the Model explorer get cards', async () => {
        const g = await load();
        const status = exec(g, { kind: 'createValueSet', valueSet: 'scheme', label: 'Status' }) as string;
        exec(g, { kind: 'addConcept', set: status, label: 'Draft' });
        const view = exec(g, { kind: 'createView', label: 'V' }) as string;
        // The explorer sends the value set id of the scheme and the instance id of the concept.
        const { doc } = project(g);
        const draftIri = doc.shapes.valueSets[status].members[0].uri;
        const concept = Object.values(doc.instances).find(i => i.uri === draftIri)!.id;
        exec(g, { kind: 'addToView', view, ids: [status, concept], at: { x: 0, y: 0 } });
        expect(boxes(project(g).doc.views[view], 'card').map(n => n.element).sort()).toEqual([status, concept].sort());
    });

    it('value sets: a scheme and a collection as targets, concepts added, renamed and removed, IRIs only', async () => {
        const g = await load();
        const before = blanks(g);
        const view = exec(g, { kind: 'createView', label: 'V' }) as string;
        const status = exec(g, { kind: 'createValueSet', valueSet: 'scheme', label: 'Status', view, at: { x: 0, y: 0 } }) as string;
        const draft = exec(g, { kind: 'addConcept', set: status, label: 'Draft' }) as string;
        exec(g, { kind: 'addConcept', set: status, label: 'Final' });
        const colors = exec(g, { kind: 'createValueSet', valueSet: 'collection', label: 'Open states' }) as string;
        exec(g, { kind: 'addConcept', set: colors, uri: draft });
        const title = prop(g, EX + 'Dataset', 'dct:title');
        exec(g, { kind: 'setPropertyShape', id: title.id, patch: { range: { kind: 'scheme', schemes: [shapesOf(g).valueSets[status].uri] } } });
        const lang = prop(g, EX + 'Dataset', 'dct:language');
        exec(g, { kind: 'setPropertyShape', id: lang.id, patch: { range: { kind: 'collection', collection: shapesOf(g).valueSets[colors].uri } } });
        let s = shapesOf(g);
        expect(s.properties[title.id].range).toEqual({ kind: 'scheme', schemes: [s.valueSets[status].uri] });
        expect(s.properties[lang.id].range).toEqual({ kind: 'collection', collection: s.valueSets[colors].uri });
        expect(s.valueSets[status].members.map(m => m.label)).toEqual(['Draft', 'Final']);
        expect(boxes(project(g).doc.views[view], 'card').map(n => n.element)).toEqual([status]);
        // The member shape lists the members; a new member joins the list.
        const memberIn = () => {
            const shape = g.match(null, rdf.namedNode(DCT + 'source'), rdf.namedNode(s.valueSets[colors].uri), GRAPH)[0].subject;
            const out: string[] = [];
            for (let h = g.object(shape, rdf.namedNode('http://www.w3.org/ns/shacl#in'), GRAPH); h && h.value !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil'; h = g.object(h, rdf.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#rest'), GRAPH)) {
                out.push(g.object(h, rdf.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#first'), GRAPH)!.value);
            }
            return out;
        };
        expect(memberIn()).toEqual([draft]);
        const extra = exec(g, { kind: 'addConcept', set: colors, label: 'Review' }) as string;
        expect(memberIn().sort()).toEqual([draft, extra].sort());
        exec(g, { kind: 'rename', id: iriId(draft), label: 'Drafting' });
        s = shapesOf(g);
        expect(s.valueSets[status].members.map(m => m.label)).toEqual(['Drafting', 'Final']);
        // Removed from the scheme: the concept is deleted, and leaves the collection too.
        exec(g, { kind: 'removeConcept', set: status, uri: draft });
        expect(memberIn()).toEqual([extra]);
        expect(executeCommand(g, emptyMetamodel(), { kind: 'delete', ids: [status] }).ok).toBe(false);
        expect(blanks(g)).toBe(before);
    });

    it('adds broader concepts in the graph of the concepts (the data file), preserves other parents, and supports undo/redo', async () => {
        const g = await load();
        const set = exec(g, { kind: 'createValueSet', valueSet: 'scheme', label: 'Subjects' }) as string;
        const child = exec(g, { kind: 'addConcept', set, label: 'Child' }) as string;
        const parent = exec(g, { kind: 'addConcept', set, label: 'Parent' }) as string;
        const other = exec(g, { kind: 'addConcept', set, label: 'Other parent' }) as string;
        const command = { kind: 'setConceptBroader' as const, uri: child, broader: parent };
        const parents = () => shapesOf(g).valueSets[set].members.find(m => m.uri === child)!.broader;
        const { result, patch } = g.transact(x => executeCommand(x, emptyMetamodel(), command));
        expect(result.ok).toBe(true);
        expect(parents()).toEqual([parent]);
        expect(patch.every(q => q.quad.graph.equals(g.model))).toBe(true);
        g.undo(patch);
        expect(parents()).toEqual([]);
        g.redo(patch);
        expect(parents()).toEqual([parent]);
        const duplicate = g.transact(x => executeCommand(x, emptyMetamodel(), command));
        expect(duplicate.patch).toEqual([]);
        exec(g, { ...command, broader: other });
        expect(parents()).toEqual([parent, other].sort());
        exec(g, { kind: 'removeConcept', set, uri: parent });
        expect(parents()).toEqual([other]);
    });

    it('rejects missing concepts, self links and cycles, including inverse links in another shapes graph', async () => {
        const g = await load();
        const set = exec(g, { kind: 'createValueSet', valueSet: 'scheme', label: 'Subjects' }) as string;
        const a = exec(g, { kind: 'addConcept', set, label: 'A' }) as string;
        const b = exec(g, { kind: 'addConcept', set, label: 'B' }) as string;
        const c = exec(g, { kind: 'addConcept', set, label: 'C' }) as string;
        exec(g, { kind: 'setConceptBroader', uri: a, broader: b });
        // b -> c expressed with skos:narrower in a second shapes file.
        const other = rdf.namedNode(fileGraphIri('/tmp/other-shapes.ttl'));
        g.setShapesGraphs([...g.shapesGraphs(), other]);
        g.store.add(rdf.quad(rdf.namedNode(c), rdf.namedNode('http://www.w3.org/2004/02/skos/core#narrower'), rdf.namedNode(b), other));
        for (const [uri, broader] of [[a, a], [b, a], [c, a], [a, 'urn:missing'], ['urn:missing', a]]) {
            const { result, patch } = g.transact(x => executeCommand(x, emptyMetamodel(), { kind: 'setConceptBroader', uri, broader }));
            expect(result.ok).toBe(false);
            expect(patch).toEqual([]);
        }
    });

    it('undoes a shape edit with the store patch', async () => {
        const g = await load();
        const shape = rdf.namedNode(EX + 'Dataset');
        g.add(shape, S.targetSubjectsOf, rdf.namedNode(EX + 'status'), GRAPH);
        const before = shapesCanonical(g);
        const { patch } = g.transact(x => executeCommand(x, emptyMetamodel(), { kind: 'setNodeShape', id: shapeId(x, EX + 'Dataset'), patch: { targetSubjectsOf: [EX + 'phase', EX + 'other'] } }));
        expect(shapesCanonical(g)).not.toBe(before);
        g.undo(patch);
        expect(shapesCanonical(g)).toBe(before);
    });

    it('a target class change: sh:class references to the old class follow, unless another node shape still targets it', async () => {
        const g = await load();
        const dataset = shapeId(g, EX + 'Dataset');
        const { patch } = g.transact(x => executeCommand(x, emptyMetamodel(), { kind: 'setNodeShape', id: dataset, patch: { targetClass: EX + 'Data' } }));
        expect(prop(g, EX + 'Catalog', 'dcat:dataset').range).toEqual({ kind: 'class', class: EX + 'Data' });
        g.undo(patch);
        expect(prop(g, EX + 'Catalog', 'dcat:dataset').range).toEqual({ kind: 'class', class: DCAT + 'Dataset' });
        // A second shape with the old target class: the references stay with it.
        exec(g, { kind: 'createNodeShape', label: 'Other dataset', targetClass: DCAT + 'Dataset' });
        exec(g, { kind: 'setNodeShape', id: dataset, patch: { targetClass: EX + 'Data' } });
        expect(prop(g, EX + 'Catalog', 'dcat:dataset').range).toEqual({ kind: 'class', class: DCAT + 'Dataset' });
    });

    it('concepts in the data file: new schemes and concepts are instances; a scheme property relates to its concepts only', async () => {
        const g = await load(`<urn:p> a <${DCAT}Dataset> ; <${DCT}title> "P" .`);
        const status = exec(g, { kind: 'createValueSet', valueSet: 'scheme', label: 'Status' }) as string;
        const draft = exec(g, { kind: 'addConcept', set: status, label: 'Draft' }) as string;
        const statusUri = shapesOf(g).valueSets[status].uri;
        // In the model graph, not in the shapes graph; the concept is an instance labelled by skos:prefLabel.
        expect(g.match(rdf.namedNode(draft), null, null, GRAPH)).toEqual([]);
        expect(g.match(rdf.namedNode(draft), null, null, g.model).length).toBe(3);
        const doc = project(g).doc;
        expect(Object.values(doc.instances).find(i => i.uri === draft)).toMatchObject({ label: 'Draft', types: [NS_SKOS + 'Concept'] });
        // A scheme property of Dataset; the metamodel (shapes + vocabulary of the data) has a relation to the concepts of Status.
        const dataset = shapeId(g, EX + 'Dataset');
        exec(g, { kind: 'createPropertyShape', shape: dataset, path: { kind: 'iri', iri: 'urn:name:status' }, range: { kind: 'scheme', schemes: [statusUri] } });
        const meta = metamodelFromQuads([...g.shapesTriples(), ...g.vocabularyQuads()]);
        const rel = meta.classes.find(c => c.iri === DCAT + 'Dataset')!.relations.find(r => r.path === 'urn:name:status')!;
        expect(rel).toMatchObject({ targetClass: NS_SKOS + 'Concept', valueSet: statusUri, values: [draft] });
        const pId = Object.values(project(g).doc.instances).find(i => i.uri === 'urn:p')!.id;
        const draftId = Object.values(project(g).doc.instances).find(i => i.uri === draft)!.id;
        expect(run(g, meta, { kind: 'createRelation', subject: pId, predicate: 'urn:name:status', object: draftId })).toBeDefined();
        // A concept of another scheme is refused.
        const other = exec(g, { kind: 'createValueSet', valueSet: 'scheme', label: 'Other' }) as string;
        const stray = exec(g, { kind: 'addConcept', set: other, label: 'Stray' }) as string;
        const strayId = Object.values(project(g).doc.instances).find(i => i.uri === stray)!.id;
        const refused = executeCommand(g, meta, { kind: 'createRelation', subject: pId, predicate: 'urn:name:status', object: strayId });
        expect(refused.ok).toBe(false);
        // A new concept from the link picker: in the scheme, related in one command (the metamodel list is older than the concept).
        const made = executeCommand(g, meta, { kind: 'createRelation', subject: pId, predicate: 'urn:name:status', object: { classIri: NS_SKOS + 'Concept', label: 'Final', inScheme: statusUri } });
        expect(made.ok).toBe(true);
        expect(shapesOf(g).valueSets[status].members.map(m => m.label)).toEqual(['Draft', 'Final']);
        // Removing a concept from its scheme deletes it and the statements that refer to it.
        exec(g, { kind: 'removeConcept', set: status, uri: draft });
        expect(g.match(null, null, rdf.namedNode(draft), g.model)).toEqual([]);
    });

    it('link drag to empty canvas: a new node shape or value set and an unnamed property to it, one undo step', async () => {
        const g = await load();
        const view = exec(g, { kind: 'createView', label: 'Link' }) as string;
        const dataset = shapeId(g, EX + 'Dataset');
        exec(g, { kind: 'addToView', view, ids: [dataset], at: { x: 0, y: 0 } });
        const before = shapesCanonical(g);
        const path = (parsePath('unnamed property 1') as { path: never }).path;
        const { result, patch } = g.transact(x => executeCommand(x, emptyMetamodel(), {
            kind: 'createPropertyShape', shape: dataset, path, range: { kind: 'any' }, newTarget: { kind: 'nodeShape', label: 'unnamed shape 1' }, view, at: { x: 600, y: 0 }, out: true
        }));
        expect(result.ok).toBe(true);
        const s = shapesOf(g);
        const made = Object.values(s.nodeShapes).find(n => n.label === 'unnamed shape 1')!;
        expect(made.targetClass).toBeUndefined();
        expect(prop(g, EX + 'Dataset', 'unnamed property 1').range).toEqual({ kind: 'node', shape: made.id });
        const kids = schema(g, view);
        expect(kids.filter(k => k.type === 'edge:property').map(e => [e.name, elementOfId(project(g).doc.views[view], e.targetId as string)])).toContainEqual(['unnamed property 1', made.id]);
        g.undo(patch);
        expect(shapesCanonical(g)).toBe(before);
        // A new concept scheme: a scheme range and its node in the view.
        exec(g, { kind: 'createPropertyShape', shape: dataset, path, range: { kind: 'any' }, newTarget: { kind: 'scheme', label: 'Colors' }, view, at: { x: 600, y: 300 }, out: true });
        const scheme = Object.values(shapesOf(g).valueSets).find(v => v.label === 'Colors')!;
        expect(prop(g, EX + 'Dataset', 'unnamed property 1').range).toEqual({ kind: 'scheme', schemes: [scheme.uri] });
        expect(boxes(project(g).doc.views[view], 'card').map(n => n.element)).toContain(scheme.id);
    });

    it('incoming link: a new or absent owner node shape gets a property to the shape and its card, one undo step', async () => {
        const g = await load();
        const view = exec(g, { kind: 'createView', label: 'Link in' }) as string;
        const dataset = shapeId(g, EX + 'Dataset');
        exec(g, { kind: 'addToView', view, ids: [dataset], at: { x: 600, y: 0 } });
        const before = shapesCanonical(g);
        const path = (parsePath('unnamed property 1') as { path: never }).path;
        const { result, patch } = g.transact(x => executeCommand(x, emptyMetamodel(), {
            kind: 'createPropertyShape', shape: '', newOwner: 'unnamed shape 1', path, range: { kind: 'node', shape: dataset }, view, at: { x: 0, y: 0 }, out: true
        }));
        expect(result.ok).toBe(true);
        const owner = Object.values(shapesOf(g).nodeShapes).find(n => n.label === 'unnamed shape 1')!;
        expect(shapesOf(g).properties[owner.properties[0]]).toMatchObject({ owner: owner.id, range: { kind: 'node', shape: dataset } });
        expect(boxes(project(g).doc.views[view], 'card').map(n => n.element)).toContain(owner.id);
        g.undo(patch);
        expect(shapesCanonical(g)).toBe(before);
        // An existing owner that the view does not show: its card is added.
        const other = exec(g, { kind: 'createNodeShape', label: 'Other' }) as string;
        exec(g, { kind: 'createPropertyShape', shape: other, path, range: { kind: 'node', shape: dataset }, view, at: { x: 0, y: 300 }, out: true });
        expect(shapesOf(g).nodeShapes[other].properties.map(id => shapesOf(g).properties[id].range)).toEqual([{ kind: 'node', shape: dataset }]);
        expect(boxes(project(g).doc.views[view], 'card').map(n => n.element)).toContain(other);
    });
});

describe('paths as text', () => {
    it('parses and formats sequence, alternative and inverse paths', () => {
        for (const text of ['dct:title', 'dcat:qualifiedRelation/prov:agent', 'dct:isPartOf|dct:hasPart', '^prov:agent', '^(dcat:a/dcat:b)', '(dct:a|dct:b)/dct:c']) {
            const r = parsePath(text);
            expect('path' in r ? formatPath(r.path) : r.error).toBe(text);
        }
        expect(parsePath('http://example.org/p')).toEqual({ path: { kind: 'iri', iri: 'http://example.org/p' } });
        expect('error' in parsePath('dct:a/')).toBe(true);
    });

    it('maps names to canonical-md urn:name IRIs and keeps explicit IRIs', () => {
        expect(termIri('data product')).toBe('urn:name:data%20product');
        expect(termIri('dcat:Dataset')).toBe('http://www.w3.org/ns/dcat#Dataset');
        expect(termIri('<http://example.org/C>')).toBe('http://example.org/C');
        expect(termIri('  ')).toBeUndefined();
        expect(parsePath('has author')).toEqual({ path: { kind: 'iri', iri: 'urn:name:has%20author' } });
        expect(parsePath('nope:x')).toEqual({ path: { kind: 'iri', iri: 'urn:name:nope%3Ax' } });
        for (const text of ['has author', 'part/dct:title', '^member']) {
            const r = parsePath(text);
            expect('path' in r ? formatPath(r.path) : r.error).toBe(text);
        }
    });
});
