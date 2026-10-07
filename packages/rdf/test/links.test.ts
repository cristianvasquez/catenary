import { describe, expect, it } from 'vitest';
import {
    Doc, NS, boxes, elementLabel, findRelation, formPredicates, inView, isHidden, kindOf, predicateName, primaryClass, shortIri, viewsShowing
} from '@catenary/model';
import { ModelGraph, fileGraphIri } from '../src/graph';
import { elementId } from '../src/ids';
import { OxigraphStore } from 'rdf-files';
import { links, selectionLinks } from '../src/queries';
import { readShapes } from '../src/shapes-read';
import { skolemize } from '../src/skolem';
import { rdf } from '../src/terms';
import { doc, example, meta, parseQuads } from './helpers';

const linksOf = (g: ModelGraph, d: Doc, ids: string[]) =>
    links(g, readShapes(g.shapesAndVocabulary()), ids, id => !!(d.instances[id] || d.views[id] || d.shapes.nodeShapes[id] || d.shapes.valueSets[id]));
const sorted = (xs: string[]) => [...xs].sort();

describe('links query', () => {
    it('instances: views and relations agree with the read model', async () => {
        const g = await example();
        const d = doc(g);
        for (const id of Object.keys(d.instances)) {
            const l = linksOf(g, d, [id]);
            expect(sorted(l.views.map(v => v.view))).toEqual(sorted(viewsShowing(d, id).map(v => v.id)));
            const ends = (dir: 'out' | 'in') => sorted(l.rows.filter(r => r.dir === dir && r.id && d.instances[r.id]).map(r => `${r.predicate} ${r.id}`));
            const rels = Object.values(d.relations);
            expect(ends('out')).toEqual(sorted(rels.filter(r => r.subject === id).map(r => `${r.predicate} ${r.object}`)));
            expect(ends('in')).toEqual(sorted(rels.filter(r => r.object === id).map(r => `${r.predicate} ${r.subject}`)));
            expect(l.rows.some(r => r.predicate === NS.rdf + 'type')).toBe(false);
        }
    });

    it('relations: views with both ends, hidden edges marked; groups: their view; several ids at once', async () => {
        const g = await example();
        const d = doc(g);
        const rel = Object.keys(d.relations);
        const l = linksOf(g, d, rel);
        for (const id of rel) {
            const expected = viewsShowing(d, id, true).map(v => `${v.id} ${isHidden(v, id)}`);
            expect(sorted(l.views.filter(v => v.element === id).map(v => `${v.view} ${!!v.hidden}`))).toEqual(sorted(expected));
        }
        const view = Object.values(d.views).find(v => boxes(v, 'group').length)!;
        const group = boxes(view, 'group')[0].id;
        expect(linksOf(g, d, [group]).views).toEqual([{ element: group, view: view.id }]);
    });

    it('shape elements: property shape, sh:or constraint and its members (blank nodes in the file); the view of the node shape card', async () => {
        const TTL = `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <http://ex/> .
            ex:Task a sh:NodeShape ; sh:targetClass ex:Task ; sh:property [ sh:path ex:owner ; sh:class ex:Person ] ;
                sh:or ( [ sh:path ex:a ; sh:minCount 1 ] [ sh:path ex:b ; sh:minCount 1 ] ) .
            ex:Person a sh:NodeShape ; sh:targetClass ex:Person ; sh:property ex:Person-name .
            ex:Person-name sh:path ex:name .`;
        const g = new ModelGraph(new OxigraphStore());
        const shapes = rdf.namedNode(fileGraphIri('/tmp/links-shapes.ttl'));
        g.setShapesGraphs([...g.shapesGraphs(), shapes]);
        for (const q of skolemize(await parseQuads(TTL)).quads) g.store.add(rdf.quad(q.subject, q.predicate, q.object, shapes));
        const V = rdf.namedNode('urn:name:V'), node = rdf.namedNode('urn:name:V-placement');
        g.store.add(rdf.quad(V, rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(NS.view + 'View'), V));
        g.store.add(rdf.quad(node, rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(NS.view + 'Placement'), V));
        g.store.add(rdf.quad(node, rdf.namedNode(NS.view + 'element'), rdf.namedNode('http://ex/Task'), V));
        const d = doc(g);
        const task = elementId(rdf.namedNode('http://ex/Task')), person = elementId(rdf.namedNode('http://ex/Person')), view = elementId(V);
        const props = Object.values(d.shapes.properties);
        const owner = props.find(p => p.path.kind === 'iri' && p.path.iri === 'http://ex/owner')!;
        const name = props.find(p => p.uri === 'http://ex/Person-name')!;
        const members = props.filter(p => p.id !== owner.id && p.id !== name.id).map(p => p.id);
        const constraint = Object.keys(d.shapes.constraints)[0];
        expect(members.length).toBe(2);

        const p = linksOf(g, d, [owner.id]);
        expect(p.views).toEqual([{ element: owner.id, view }]);
        expect(p.rows.filter(r => r.dir === 'out').map(r => `${r.predicate} ${r.iri}`).sort()).toEqual([`${NS.sh}class http://ex/Person`, `${NS.sh}path http://ex/owner`]);
        expect(p.rows.find(r => r.predicate === NS.sh + 'class')!.id).toBe(person);
        expect(p.rows.filter(r => r.dir === 'in').map(r => `${r.predicate} ${r.id}`)).toEqual([`${NS.sh}property ${task}`]);

        const c = linksOf(g, d, [constraint]);
        expect(c.views).toEqual([{ element: constraint, view }]);
        expect(sorted(c.rows.filter(r => r.dir === 'out').map(r => `${r.predicate} ${r.id}`))).toEqual(sorted(members.map(m => `${NS.sh}or ${m}`)));
        expect(c.rows.filter(r => r.dir === 'in').map(r => `${r.predicate} ${r.id}`)).toEqual([`${NS.sh}or ${task}`]);

        const m = linksOf(g, d, [members[0]]);
        expect(m.rows.filter(r => r.dir === 'in').map(r => `${r.predicate} ${r.id}`)).toEqual([`${NS.sh}or ${task}`]);

        const t = linksOf(g, d, [task]);
        expect(t.views).toEqual([{ element: task, view }]);
        expect(sorted(t.rows.filter(r => r.dir === 'out').map(r => `${r.predicate} ${r.id}`)))
            .toEqual(sorted([`${NS.sh}targetClass ${task}`, `${NS.sh}property ${owner.id}`, ...members.map(x => `${NS.sh}or ${x}`)]));
        expect(t.rows.filter(r => r.dir === 'in')).toEqual([]);

        // A property shape with an IRI: its id, not a plain IRI.
        expect(linksOf(g, d, [person]).rows.find(r => r.predicate === NS.sh + 'property')!.id).toBe(name.id);
    });
});

describe('selectionLinks: the Links panel data (ADR 0007)', () => {
    it('law_shapeInstances: lists distinct targets outside views with shared labels', async () => {
        const g = new ModelGraph(new OxigraphStore());
        const shapes = rdf.namedNode(fileGraphIri('/tmp/instance-links-shapes.ttl'));
        g.setShapesGraphs([...g.shapesGraphs(), shapes]);
        const prefix = `@prefix sh: <${NS.sh}> . @prefix rdfs: <${NS.rdfs}> . @prefix ex: <http://ex/> .`;
        for (const q of await parseQuads(prefix + `
            ex:S a sh:NodeShape ; sh:targetClass ex:C ; sh:targetNode ex:a .
            ex:T a sh:NodeShape ; sh:targetSubjectsOf ex:p ; sh:targetObjectsOf ex:p .
            ex:Empty a sh:NodeShape . ex:Sub rdfs:subClassOf ex:C .`)) {
            g.store.add(rdf.quad(q.subject, q.predicate, q.object, shapes));
        }
        for (const q of await parseQuads(prefix + `
            ex:a a ex:C ; rdfs:label "Alpha" ; ex:p ex:b .
            ex:b a ex:Sub ; rdfs:label "Beta" . ex:c a ex:Other .`)) {
            g.store.add(rdf.quad(q.subject, q.predicate, q.object, g.model));
        }
        const id = (name: string) => elementId(rdf.namedNode('http://ex/' + name));
        const d = doc(g), idx = readShapes(g.shapesAndVocabulary()), m = await meta();
        const result = selectionLinks(g, idx, d, m, [id('S'), id('T')]);
        expect(result.instances).toEqual([
            { id: id('a'), label: 'Alpha', shapes: [id('S'), id('T')] },
            { id: id('b'), label: 'Beta', shapes: [id('S'), id('T')] }
        ]);
        expect(selectionLinks(g, idx, d, m, [id('Empty')]).instances).toEqual([]);
        expect(selectionLinks(g, idx, d, m, [id('a')]).instances).toEqual([]);
    });
    it('elements: placements resolve to their element; kind, label, kind name and relation ends agree with the read model', async () => {
        const g = await example(), m = await meta();
        const d = doc(g);
        const idx = readShapes(g.shapesAndVocabulary());
        const all = [...Object.keys(d.instances), ...Object.keys(d.relations), ...Object.keys(d.views), ...Object.keys(d.shapes.nodeShapes)];
        const { elements } = selectionLinks(g, idx, d, m, [...all, 'urn:name:not-an-element']);
        expect(elements.map(e => e.id)).toEqual([...new Set(all)]);
        for (const e of elements) {
            expect(e.kind).toBe(kindOf(d, undefined, e.id));
            expect(e.label).toBe(elementLabel(d, m, e.id) ?? e.id);
            if (e.kind === 'instance') expect(e.kindName).toBe(primaryClass(m, d.instances[e.id].types)?.name ?? 'Instance');
            const r = d.relations[e.id];
            expect(e.ends).toEqual(r ? { subject: r.subject, object: r.object, subjectLabel: d.instances[r.subject].label, objectLabel: d.instances[r.object].label } : undefined);
        }
        expect(elements.filter(e => e.ends).length).toBe(Object.keys(d.relations).length);

        // Ids of a view: a card placement gives its instance, a placed edge its relation; a group is found in its view only.
        const view = Object.values(d.views).find(v => boxes(v, 'group').length && boxes(v, 'card').length && v.edges.some(x => x.id))!;
        const card = boxes(view, 'card')[0], edge = view.edges.find(x => x.id)!, group = boxes(view, 'group')[0];
        expect(selectionLinks(g, idx, d, m, [card.id, edge.id!, group.id], view.id).elements.map(e => `${e.id} ${e.kind} ${e.label}`)).toEqual([
            `${card.element} instance ${d.instances[card.element].label}`, `${edge.relation} relation ${elementLabel(d, m, edge.relation)}`, `${group.id} group ${group.label}`
        ]);
        expect(selectionLinks(g, idx, d, m, [group.id]).elements).toEqual([]);
    });

    it('views and rows: view labels, cards in views, row targets, names, predicate names and relations agree with the read model', async () => {
        const g = await example(), m = await meta();
        const d = doc(g);
        const idx = readShapes(g.shapesAndVocabulary());
        let relationRows = 0;
        for (const id of Object.keys(d.instances)) {
            const l = selectionLinks(g, idx, d, m, [id]);
            for (const v of l.views) expect(v.label).toBe(d.views[v.view].label);
            for (const v of Object.values(d.views)) expect(l.views.some(x => x.view === v.id && x.element === id)).toBe(inView(v, id));
            const cls = primaryClass(m, d.instances[id].types);
            for (const r of l.rows) {
                if (r.id) expect(kindOf(d, undefined, r.id)).toBeDefined();
                expect(r.name).toBe(r.label ?? (r.id ? elementLabel(d, m, r.id) : r.iri ? shortIri(r.iri) : 'blank node'));
                expect(r.predicateName).toBe(predicateName(m, r.predicate));
                const [s, o] = r.dir === 'out' ? [id, r.id] : [r.id, id];
                expect(r.relation).toBe(s && o && d.instances[s] && d.instances[o] ? findRelation(d, s, r.predicate, o)?.id : undefined);
                if (r.relation) relationRows++;
                expect(!!r.undeclared).toBe(r.dir === 'out' && !!r.relation && !!cls && !formPredicates(cls).includes(r.predicate));
            }
        }
        // Each relation is a row of its subject ('out') and of its object ('in').
        expect(Object.keys(d.relations).length).toBeGreaterThan(0);
        expect(relationRows).toBe(2 * Object.keys(d.relations).length);
    });
});
