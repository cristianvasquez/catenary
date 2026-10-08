import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NS, RdfPaste, copyFromView, iriId } from '@catenary/model';
import { parseRdfSync } from 'rdf-files';
import { ModelStore } from '../src/model-store';
import { prepareRdfPaste } from '../src/clipboard';
import { rdf } from '../src/terms';
import { docOf } from './helpers';

const active: { store: ModelStore; dir: string }[] = [];
afterEach(() => { for (const { store, dir } of active.splice(0)) { store.close(); rmSync(dir, { recursive: true, force: true }); } });
const prepared = (r: RdfPaste) => { if (!r.ok) throw new Error(r.error); return r; };
const nn = (value: string) => rdf.namedNode(value);
class ClipboardStore extends ModelStore { get dataset() { return this.graph; } }

async function workspace() {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-rdf-clipboard-'));
    writeFileSync(join(dir, 'workspace.trig'), `@prefix ws: <${NS.ws}> .
        <urn:name:workspace> { <urn:name:workspace> a ws:Workspace; ws:placeShapes "shapes.ttl"; ws:placeConcepts "concepts.ttl"; ws:placeInstances "data.ttl". }`);
    const store = new ClipboardStore();
    active.push({ store, dir });
    expect((await store.open(join(dir, 'workspace.trig'))).ok).toBe(true);
    const result = store.execute({ kind: 'createView', label: 'Clipboard' });
    if (!result.ok) throw new Error(result.error);
    return { store, dir, view: result.id! };
}

describe('raw RDF clipboard', () => {
    it.each([
        ['text/turtle', '<urn:a> <urn:p> "value" .'],
        ['application/n-triples', '<urn:a> <urn:p> "value" .'],
        ['application/trig', '<urn:g> { <urn:a> <urn:p> "value" . }'],
        ['application/n-quads', '<urn:a> <urn:p> "value" <urn:g> .'],
        ['application/ld+json', '{"@context":{"p":"urn:p"},"@id":"urn:a","p":"value"}'],
        ['application/rdf+xml', `<rdf:RDF xmlns:rdf="${NS.rdf}" xmlns:e="urn:"><rdf:Description rdf:about="urn:a"><e:p>value</e:p></rdf:Description></rdf:RDF>`]
    ])('parses %s completely', async (mime, text) => {
        const r = prepared(await prepareRdfPaste(text, mime));
        expect(r.statements).toBe(1);
        expect(parseRdfSync(r.rdf, 'application/n-quads')[0].object.value).toBe('value');
    });

    it('detects RDF text, rejects broken RDF and plain JSON, and skolemizes blank nodes', async () => {
        const r = prepared(await prepareRdfPaste('<urn:a> <urn:p> [ <urn:q> "nested" ] .'));
        const quads = parseRdfSync(r.rdf, 'application/n-quads');
        expect(quads).toHaveLength(2);
        expect(quads.every(q => q.subject.termType !== 'BlankNode' && q.object.termType !== 'BlankNode')).toBe(true);
        expect((await prepareRdfPaste('<urn:a> <urn:p> "ok" . garbage')).ok).toBe(false);
        expect((await prepareRdfPaste('{"value":1}')).ok).toBe(false);
    });

    it('law_namedGraphConsent: requires consent and deduplicates flattened graphs without an earlier edit', async () => {
        const { store, view } = await workspace();
        const r = prepared(await store.prepareRdfPaste('<urn:g1> { <urn:a> <urn:p> "x" . } <urn:g2> { <urn:a> <urn:p> "x" . }'));
        expect(r.namedGraphs).toEqual(['urn:g1', 'urn:g2']);
        const revision = store.snapshot().revision;
        expect(store.execute({ kind: 'pasteRdf', view, rdf: r.rdf }).ok).toBe(false);
        expect(store.snapshot().revision).toBe(revision);
        expect(store.execute({ kind: 'pasteRdf', view, rdf: r.rdf, flatten: true }).ok).toBe(true);
        expect(store.dataset.match(nn('urn:a'), nn('urn:p'))).toHaveLength(1);
        expect(store.dataset.match(null, null, null, nn('urn:g1'))).toHaveLength(0);
    });

    it('law_pasteRdfAdditive and law_pasteKeepsOldPositions: adds data and figures in one undo step', async () => {
        const { store, view, dir } = await workspace();
        const original = prepared(await store.prepareRdfPaste(`<urn:old> a <urn:C>; <${NS.rdfs}label> "Old" .`));
        expect(store.execute({ kind: 'pasteRdf', view, rdf: original.rdf, at: { x: 0, y: 0 } }).ok).toBe(true);
        const before = store.view(view)!;
        const r = prepared(await store.prepareRdfPaste(`<urn:a> a <urn:C>; <${NS.rdfs}label> "A"; <urn:link> <urn:b> .
            <urn:b> a <urn:C>; <${NS.rdfs}label> "B" .`));
        const result = store.execute({ kind: 'pasteRdf', view, rdf: r.rdf, at: { x: 0, y: 0 } });
        expect(result.ok).toBe(true);
        expect(store.view(view)!.boxes).toHaveLength(3);
        expect(store.view(view)!.boxes.find(b => b.id === before.boxes[0].id)).toEqual(before.boxes[0]);
        expect(store.view(view)!.edges).toHaveLength(1);
        store.undo();
        expect(store.view(view)).toEqual(before);
        expect(store.dataset.match(nn('urn:a'))).toHaveLength(0);
        store.redo();
        expect(store.view(view)!.boxes).toHaveLength(3);
        expect((await store.save()).ok).toBe(true);
        const saved = parseRdfSync(readFileSync(join(dir, 'data.ttl'), 'utf8'), 'text/turtle');
        expect(saved.some(q => q.subject.value === 'urn:a')).toBe(true);
        expect((await store.open(join(dir, 'workspace.trig'))).ok).toBe(true);
        expect(store.view(view)!.boxes).toHaveLength(3);
    });

    it('reuses existing RDF and places it without duplicating named instances', async () => {
        const { store, view } = await workspace();
        const r = prepared(await store.prepareRdfPaste('<urn:a> a <urn:C> .'));
        store.execute({ kind: 'pasteRdf', view, rdf: r.rdf });
        store.execute({ kind: 'removeFromView', view, ids: [iriId('urn:a')] });
        expect(store.execute({ kind: 'pasteRdf', view, rdf: r.rdf }).ok).toBe(true);
        expect(store.dataset.match(nn('urn:a'))).toHaveLength(1);
        expect(store.view(view)!.boxes).toHaveLength(1);
        expect(store.execute({ kind: 'pasteRdf', view, rdf: r.rdf })).toMatchObject({ ok: true, ids: [] });
    });

    it('routes shapes, owned property parts, and concepts to their configured files', async () => {
        const { store, view, dir } = await workspace();
        const r = prepared(await store.prepareRdfPaste(`@prefix sh: <${NS.sh}> . @prefix skos: <${NS.skos}> .
            <urn:S> a sh:NodeShape; sh:targetClass <urn:C>; sh:property [ sh:path <urn:name>; sh:datatype <${NS.xsd}string> ].
            <urn:scheme> a skos:ConceptScheme . <urn:concept> a skos:Concept; skos:inScheme <urn:scheme> .`));
        expect(store.execute({ kind: 'pasteRdf', view, rdf: r.rdf }).ok).toBe(true);
        expect(store.shapes().nodeShapes[iriId('urn:S')]).toBeDefined();
        expect(store.view(view)!.boxes.length).toBeGreaterThan(0);
        expect((await store.save()).ok).toBe(true);
        const shapes = parseRdfSync(readFileSync(join(dir, 'shapes.ttl'), 'utf8'), 'text/turtle');
        expect(shapes.some(q => q.subject.value === 'urn:S')).toBe(true);
        expect(shapes.some(q => q.predicate.value === NS.sh + 'path')).toBe(true);
        const concepts = parseRdfSync(readFileSync(join(dir, 'concepts.ttl'), 'utf8'), 'text/turtle');
        expect(concepts.some(q => q.subject.value === 'urn:concept')).toBe(true);
    });

    it('pastes a relationship by showing its existing ends, without expanding their other links', async () => {
        const { store, view } = await workspace();
        const data = prepared(await store.prepareRdfPaste('<urn:a> a <urn:C>; <urn:other> <urn:c> . <urn:b> a <urn:C> . <urn:c> a <urn:C> .'));
        store.execute({ kind: 'pasteRdf', view, rdf: data.rdf });
        store.execute({ kind: 'removeFromView', view, ids: [iriId('urn:a'), iriId('urn:b'), iriId('urn:c')] });
        const link = prepared(await store.prepareRdfPaste('<urn:a> <urn:link> <urn:b> .'));
        expect(store.execute({ kind: 'pasteRdf', view, rdf: link.rdf }).ok).toBe(true);
        expect(store.view(view)!.boxes.filter(b => b.kind === 'card').map(b => b.element).sort()).toEqual([iriId('urn:a'), iriId('urn:b')].sort());
        expect(store.view(view)!.edges).toHaveLength(1);
    });

    it('exports shape-owned property definitions but leaves target class descriptions out', async () => {
        const { store, view } = await workspace();
        const input = prepared(await store.prepareRdfPaste(`@prefix sh: <${NS.sh}> .
            <urn:S> a sh:NodeShape; sh:targetClass <urn:C>; sh:property <urn:S-name> .
            <urn:S-name> a sh:PropertyShape; sh:path <urn:name>; sh:datatype <${NS.xsd}string> .
            <urn:C> a <${NS.rdfs}Class>; <${NS.rdfs}label> "Class" .`));
        store.execute({ kind: 'pasteRdf', view, rdf: input.rdf });
        const copy = await store.copyAsRdf(view, [iriId('urn:S')]);
        if (!copy.ok) throw new Error(copy.error);
        const quads = parseRdfSync(copy.text, 'text/turtle');
        expect(quads.some(q => q.subject.value === 'urn:S-name' && q.predicate.value === NS.sh + 'path')).toBe(true);
        expect(quads.some(q => q.subject.value === 'urn:C')).toBe(false);
    });

    it('ordinary copy cannot duplicate a shape already shown in the canvas', async () => {
        const { store, view } = await workspace();
        const input = prepared(await store.prepareRdfPaste(`<urn:S> a <${NS.sh}NodeShape>; <${NS.sh}targetClass> <urn:C> .`));
        store.execute({ kind: 'pasteRdf', view, rdf: input.rdf });
        const before = store.view(view)!;
        const clip = copyFromView(docOf(store), view, [iriId('urn:S')])!;
        expect(clip).toBeDefined();
        expect(store.execute({ kind: 'pasteIntoView', view, clip }).ok).toBe(false);
        expect(store.view(view)).toEqual(before);
        expect(Object.keys(store.shapes().nodeShapes)).toHaveLength(1);
    });

    it('law_rdfCopyWithoutPlacement: exports selected cards and owned values without referenced descriptions', async () => {
        const { store, view } = await workspace();
        const input = prepared(await store.prepareRdfPaste(`<urn:a> a <urn:C>; <urn:owned> [ <urn:value> "nested" ]; <urn:link> <urn:b> .
            <urn:b> a <urn:C>; <${NS.rdfs}label> "B" .`));
        store.execute({ kind: 'pasteRdf', view, rdf: input.rdf });
        const card = store.view(view)!.boxes.find(b => b.kind === 'card' && b.element === iriId('urn:a'))!;
        const r = await store.copyAsRdf(view, [card.id]);
        if (!r.ok) throw new Error(r.error);
        const quads = parseRdfSync(r.text, 'text/turtle');
        expect(quads).toHaveLength(4);
        expect(quads.some(q => q.object.value === 'nested')).toBe(true);
        expect(quads.some(q => q.subject.value === 'urn:b' || q.predicate.value.startsWith(NS.view))).toBe(false);
        const edge = store.view(view)!.edges[0];
        const relation = await store.copyAsRdf(view, [edge.id!]);
        if (!relation.ok) throw new Error(relation.error);
        expect(parseRdfSync(relation.text, 'text/turtle')).toHaveLength(1);
        const preparedAgain = prepared(await store.prepareRdfPaste(r.text));
        expect(store.execute({ kind: 'pasteRdf', view, rdf: preparedAgain.rdf })).toMatchObject({ ok: true, ids: [] });
    });
});
