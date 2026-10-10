import { describe, expect, it } from 'vitest';
import { classDef, permittedRelations, verbalizeProperty } from '@catenary/model';
import { ModelGraph, fileGraphIri } from '../src/graph';
import { OxigraphStore } from 'rdf-files';
import { project } from './project-full';
import { emptyMetamodel, metamodelFromQuads } from '../src/shapes';
import { skolemize } from '../src/skolem';
import { canonical } from '../src/trig';
import { rdf } from '../src/terms';
import { executeCommand } from '../src/commands';
import { parseQuads, run, violationsIn } from './helpers';

// A property shape with sh:or of ranges: "the value is an A or a B" (range kind "or").
const P = `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <http://ex/> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .`;
const TTL = P + `
ex:Task a sh:NodeShape ; sh:targetClass ex:Task ; sh:property ex:Task-updates, ex:Task-note, ex:Task-odd .
ex:Task-updates sh:path ex:updates ; sh:or ( [ sh:class ex:Series ] [ sh:class ex:Graph ] ) .
ex:Task-note sh:path ex:note ; sh:datatype xsd:string .
ex:Task-odd sh:path ex:odd ; sh:or ( [ sh:path ex:x ] [ sh:class ex:Graph ] ) .
ex:Series a sh:NodeShape ; sh:targetClass ex:Series .
ex:GraphShape a sh:NodeShape ; sh:targetClass ex:Graph .`;
const EX = 'http://ex/';
const FILE = '/tmp/or-shapes.ttl';
const GRAPH = rdf.namedNode(fileGraphIri(FILE));

async function load(): Promise<ModelGraph> {
    const g = new ModelGraph(new OxigraphStore());
    g.setShapesGraphs([...g.shapesGraphs(), GRAPH]);
    for (const q of skolemize(await parseQuads(TTL)).quads) g.store.add(rdf.quad(q.subject, q.predicate, q.object, GRAPH));
    return g;
}
const shapesOf = (g: ModelGraph) => project(g).doc.shapes;
const prop = (g: ModelGraph, path: string) => Object.values(shapesOf(g).properties).find(p => p.path.kind === 'iri' && p.path.iri === EX + path.slice(3))!;
const exec = (g: ModelGraph, c: Parameters<typeof executeCommand>[2]) => run(g, emptyMetamodel(), c);
const shapesCanonical = (g: ModelGraph) => canonical(g.match(null, null, null, GRAPH).map(q => rdf.quad(q.subject, q.predicate, q.object)));
const meta = (g: ModelGraph) => metamodelFromQuads(g.match(null, null, null, GRAPH));

describe('"or" range of a property shape', () => {
    it('reads sh:or of ranges; its members are not node shapes; another sh:or stays not mapped', async () => {
        const g = await load();
        const s = shapesOf(g);
        expect(prop(g, 'ex:updates').range).toEqual({ kind: 'or', alternatives: [{ kind: 'class', class: EX + 'Series' }, { kind: 'class', class: EX + 'Graph' }] });
        expect(prop(g, 'ex:updates').raw).toEqual([]);
        expect(Object.values(s.nodeShapes).map(n => n.uri).sort()).toEqual([EX + 'GraphShape', EX + 'Series', EX + 'Task']);
        const odd = prop(g, 'ex:odd');
        expect(odd.range.kind).toBe('any');
        expect(odd.raw.some(r => r.startsWith('sh:or'))).toBe(true);
        expect(verbalizeProperty(s, prop(g, 'ex:updates'))).toBe('Each Task has zero or more <http://ex/updates>, each an instance of Series or an instance of Graph.');
    });

    it('writes alternatives as member shapes with IRIs; one alternative left is a plain range; undo restores', async () => {
        const g = await load();
        const note = prop(g, 'ex:note');
        const before = shapesCanonical(g);
        const { patch } = g.transact(x => executeCommand(x, emptyMetamodel(), {
            kind: 'setPropertyShape', id: note.id, patch: { range: { kind: 'or', alternatives: [{ kind: 'datatype', datatype: 'http://www.w3.org/2001/XMLSchema#string' }, { kind: 'class', class: EX + 'Series' }] } }
        }));
        expect(prop(g, 'ex:note').range).toEqual({ kind: 'or', alternatives: [{ kind: 'datatype', datatype: 'http://www.w3.org/2001/XMLSchema#string' }, { kind: 'class', class: EX + 'Series' }] });
        const blanks = g.match(null, null, null, GRAPH).filter(q => q.subject.termType === 'BlankNode' || q.object.termType === 'BlankNode');
        expect(blanks).toEqual([]);
        // Member shapes named after the property shape and the alternative.
        const members = g.match(null, null, null, GRAPH).map(q => q.subject.value).filter(v => v.startsWith(EX + 'Task-note-'));
        expect([...new Set(members)].sort()).toEqual([EX + 'Task-note-Series', EX + 'Task-note-or', EX + 'Task-note-or-2', EX + 'Task-note-string']);
        g.undo(patch);
        expect(shapesCanonical(g)).toBe(before);

        // One alternative left: sh:or, its cells and member shapes go.
        exec(g, { kind: 'setPropertyShape', id: prop(g, 'ex:updates').id, patch: { range: { kind: 'or', alternatives: [{ kind: 'class', class: EX + 'Graph' }] } } });
        expect(prop(g, 'ex:updates').range).toEqual({ kind: 'class', class: EX + 'Graph' });
        const left = g.match(null, null, null, GRAPH).filter(q => q.subject.value.startsWith(EX + 'Task-updates') || q.subject.termType === 'BlankNode');
        expect(left.map(q => `${q.predicate.value.replace(/.*#/, '')} ${q.object.value}`).sort()).toEqual(['class ' + EX + 'Graph', 'path ' + EX + 'updates']);
    });

    it('is one relation for each class alternative; validation accepts a value of one alternative only', async () => {
        const g = await load();
        const m = meta(g);
        const task = classDef(m, EX + 'Task')!;
        expect(task.relations.filter(r => r.path === EX + 'updates').map(r => r.targetClass).sort()).toEqual([EX + 'Graph', EX + 'Series']);
        expect(permittedRelations(m, [EX + 'Task'], [EX + 'Graph']).map(r => r.path)).toEqual([EX + 'updates']);
        const check = async (cls: string) => (await violationsIn(await parseQuads(`<${EX}t> a <${EX}Task> ; <${EX}updates> <${EX}v> . <${EX}v> a <${EX}${cls}> .`), m, i => i))
            .filter(v => v.path === EX + 'updates').length;
        expect(await check('Series')).toBe(0);
        expect(await check('Graph')).toBe(0);
        expect(await check('Other')).toBe(1);
    });

    it('deleting the property shape removes its member shapes and list cells', async () => {
        const g = await load();
        exec(g, { kind: 'delete', ids: [prop(g, 'ex:updates').id] });
        expect(g.match(null, null, null, GRAPH).filter(q => q.subject.value.startsWith(EX + 'Task-updates'))).toEqual([]);
    });
});
