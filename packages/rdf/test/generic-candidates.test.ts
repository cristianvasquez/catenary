import { describe, expect, it } from 'vitest';
import { ClassDef, Classes, InstanceProperties, NS, RelationDef, classKey, iriId } from '@catenary/model';
import { emptyGraph, load } from './helpers';
import { explorerChildren } from '../src/explorer';
import { outline } from '../src/outline';
import { properties } from '../src/properties';
import { project } from './project-full';
import { readShapes } from '../src/shapes-read';
import { readResults } from '../src/validate';
import { freeUnnamedLabel, linkChoices } from '../src/link-choices';
import { formCandidates, formStatements } from '../src/queries';
import { thingHead } from '../src/sparql';
import { rdf } from '../src/terms';

const prefixes = `@prefix rdfs: <${NS.rdfs}> . @prefix sh: <${NS.sh}> . @prefix view: <${NS.view}> .`;
const fixture = `${prefixes}
<urn:other:types> {
    <urn:from> a <urn:Source> .
    <urn:a> a <urn:Target> . <urn:b> a <urn:Target> . <urn:c> a <urn:Target> .
    <urn:child> a <urn:Child> . <urn:Child> rdfs:subClassOf <urn:Target> .
    <urn:untyped> rdfs:label "Untyped" .
    <urn:hidden> a view:Placement .
}
<urn:other:labels> {
    <urn:from> rdfs:label "Source" .
    <urn:a> rdfs:label "Alpha" . <urn:b> sh:name "Beta" . <urn:c> rdfs:label "Gamma" .
    <urn:child> rdfs:label "Child" .
    <urn:named> a <urn:Target> ; rdfs:label "unnamed target 1" .
    <urn:from> <urn:connect> <urn:a> .
    <urn:b> <urn:connect> <urn:a> .
}
<urn:other:shapes> {
    <urn:shape> a sh:NodeShape ; sh:targetClass <urn:Source> ; sh:property <urn:ps> .
    <urn:ps> sh:path <urn:connect> ; sh:class <urn:Target> .
}
<urn:view> { <urn:view> a view:View . <urn:placement> a view:Placement ; view:element <urn:c> . }
<urn:trellis:validation> {
    <urn:report-only> a <urn:Target> ; rdfs:label "Report" .
    <urn:untyped> a <urn:Target> .
    <urn:c> <urn:connect> <urn:a> .
    <urn:from> <urn:leak> "Report" .
    <urn:report-shape> sh:targetClass <urn:Source> ; sh:property <urn:report-ps> .
    <urn:report-ps> sh:class <urn:ReportClass> .
}
`;
const relation: RelationDef = { path: 'urn:connect', name: 'connect', targetClass: 'urn:Target', maxCount: 1 };
const cls = (iri: string, relations: RelationDef[] = []): ClassDef => ({
    iri, name: iri.slice(4), shapes: [], fields: [], relations, unsupported: [], color: '1', labelInShape: true
});
const meta: Classes = { classes: [cls('urn:Source', [relation]), cls('urn:Target', [relation])] };
const shapes = { nodeShapes: {}, properties: {}, constraints: {}, valueSets: {}, prefixes: {} };

async function pick(dir: 'in' | 'out', from = 'urn:from', text?: string, definitions = meta) {
    const g = await load(fixture);
    return linkChoices({ g, meta: definitions, shapes }, dir, iriId(from), iriId('urn:view'), text);
}
function sections(result: Awaited<ReturnType<typeof pick>>) {
    expect(result && 'sections' in result).toBe(true);
    return result && 'sections' in result ? result.sections : [];
}

describe('generic thing reads for pickers and forms', () => {
    it('reads split types and labels, rejects hidden subjects and report-only subjects', async () => {
        const g = await load(fixture);
        expect(thingHead(g, rdf.namedNode('urn:from'))).toEqual({ label: 'Source', types: ['urn:Source'] });
        expect(thingHead(g, rdf.namedNode('urn:untyped'))).toEqual({ label: 'Untyped', types: [NS.rdfs + 'Resource'] });
        expect(thingHead(g, rdf.namedNode('urn:hidden'))).toBeUndefined();
        expect(thingHead(g, rdf.namedNode('urn:report-only'))).toBeUndefined();
    });

    it('reads form statements across graphs without report statements', async () => {
        const quads = formStatements(await load(fixture), rdf.namedNode('urn:from'))!;
        expect(quads.map(q => q.predicate.value).sort()).toEqual([NS.rdf + 'type', NS.rdfs + 'label', 'urn:connect'].sort());
    });

    it('reads form candidates across graphs, with shared labels and subclasses', async () => {
        const quads = formCandidates(await load(fixture), rdf.namedNode('urn:from'));
        const subjects = [...new Set(quads.map(q => q.subject.value))].sort();
        expect(subjects).toEqual(['urn:a', 'urn:b', 'urn:c', 'urn:child', 'urn:named']);
        expect(quads.find(q => q.subject.value === 'urn:b' && q.predicate.value === NS.rdfs + 'label')?.object.value).toBe('Beta');
    });

    it('sorts placed candidates first, excludes existing links and filters shared display labels', async () => {
        const s = sections(await pick('out'))[0];
        expect(s.candidates.map(c => c.label)).toEqual(['Gamma', 'Beta', 'unnamed target 1']);
        expect(s.header).toContain('maximum reached');
        expect(sections(await pick('out', 'urn:from', 'BETA'))[0].candidates.map(c => c.label)).toEqual(['Beta']);
    });

    it('applies incoming cardinality across graphs, but ignores report links', async () => {
        const s = sections(await pick('in', 'urn:a')).find(s => s.header.startsWith('Target'))!;
        expect(s.candidates.map(c => c.label)).toEqual(['Gamma', 'unnamed target 1']);
        const zero: Classes = { classes: [cls('urn:Target', [{ ...relation, maxCount: 0 }])] };
        expect(sections(await pick('in', 'urn:a', undefined, zero))[0].candidates).toEqual([]);
    });

    it('explorer reads typed members and subclass folders without Doc members', async () => {
        const g = await load(fixture);
        const ctx = { g, meta, shapes: project(emptyGraph()).doc.shapes, byTerm: new Map<string, string>(), placements: new Map<string, Set<string>>(), content: {} };
        const root = explorerChildren(ctx);
        expect(root.find(r => r.key === classKey('urn:Target'))?.badge).toBe('4');
        const children = explorerChildren(ctx, classKey('urn:Target'));
        expect(children.filter(r => r.kind === 'instance').map(r => r.name)).toEqual(['Alpha', 'Beta', 'Gamma', 'unnamed target 1']);
        expect(children.find(r => r.key === classKey('urn:Child'))?.badge).toBe('1');
    });

    it('SKOS folders use written types and ignore report-only membership', async () => {
        const g = await load(`${prefixes}
            <urn:types> { <urn:scheme> a <${NS.skos}ConceptScheme> . <urn:concept> a <${NS.skos}Concept> . }
            <urn:content> { <urn:scheme> rdfs:label "Scheme" . <urn:concept> rdfs:label "Concept" ; <${NS.skos}inScheme> <urn:scheme> . }
            <urn:trellis:validation> { <urn:ghost> a <${NS.skos}Concept> ; <${NS.skos}inScheme> <urn:scheme> . }
        `);
        const ctx = { g, meta: { classes: [] }, shapes: project(emptyGraph()).doc.shapes, byTerm: new Map<string, string>(), placements: new Map<string, Set<string>>(), content: {} };
        expect(explorerChildren(ctx).find(r => r.key === 'concepts')?.badge).toBe('1');
        expect(explorerChildren(ctx, 'concepts').map(r => [r.name, r.badge])).toEqual([['Scheme', '1']]);
        expect(explorerChildren(ctx, 'scheme:urn:scheme').map(r => r.name)).toEqual(['Concept']);
    });

    it('Properties reads split statements and shared labels without Doc membership', async () => {
        const g = await load(fixture);
        const p = properties({ g, meta, idx: readShapes([]), fileOf: () => undefined }, iriId('urn:from')) as InstanceProperties;
        expect(p.label).toBe('Source');
        expect(p.types).toEqual(['urn:Source']);
        expect(p.targets).toEqual({ 'urn:connect': ['urn:a'] });
        expect(p.fields['urn:leak']).toBeUndefined();
        expect(properties({ g, meta, idx: readShapes([]), fileOf: () => undefined }, iriId('urn:report-only'))).toBeUndefined();
    });

    it('Outline reads generic placements and connections across data graphs', async () => {
        const g = await load(fixture);
        const view = rdf.namedNode('urn:view');
        for (const s of ['urn:from', 'urn:a']) {
            const placement = rdf.namedNode(s + '/placement');
            g.store.add(rdf.quad(placement, rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(NS.view + 'Placement'), view));
            g.store.add(rdf.quad(placement, rdf.namedNode(NS.view + 'element'), rdf.namedNode(s), view));
        }
        const edge = rdf.namedNode('urn:edge');
        g.store.add(rdf.quad(edge, rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(NS.view + 'Placement'), view));
        g.store.add(rdf.quad(edge, rdf.namedNode(NS.rdf + 'reifies'), rdf.quad(rdf.namedNode('urn:from'), rdf.namedNode('urn:connect'), rdf.namedNode('urn:a')), view));
        const tree = outline({ g, meta, shapes }, iriId('urn:view'));
        expect(tree.map(n => n.name)).toEqual(['Alpha', 'Gamma', 'Source']);
        expect(tree.find(n => n.name === 'Source')?.children.map(n => n.name)).toEqual(['connect → Alpha']);
    });

    it('Problems and Properties share report reads and data labels', async () => {
        const g = await load(fixture);
        const graph = rdf.namedNode('urn:trellis:validation');
        const result = rdf.namedNode('urn:result');
        for (const [p, o] of [
            ['focusNode', rdf.namedNode('urn:b')], ['resultSeverity', rdf.namedNode(NS.sh + 'Violation')],
            ['resultMessage', rdf.literal('Bad value')]
        ] as const) g.store.add(rdf.quad(result, rdf.namedNode(NS.sh + p), o, graph));
        const r = readResults(g, meta);
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ instance: iriId('urn:b'), label: 'Beta', message: 'Bad value' });
        const p = properties({ g, meta, idx: readShapes([]), fileOf: () => undefined }, iriId('urn:b')) as InstanceProperties;
        expect(p.results).toEqual([{ focus: 'urn:b', focusLabel: 'Beta', pathName: undefined, severity: 'Violation', message: 'Bad value' }]);
    });

    it('respects an empty allowed-value set and reserves written labels across graphs', async () => {
        const empty: Classes = { classes: [cls('urn:Source', [{ ...relation, values: [] }])] };
        expect(sections(await pick('out', 'urn:from', undefined, empty))[0].candidates).toEqual([]);
        expect(freeUnnamedLabel(await load(fixture), 'target')).toBe('unnamed target 2');
    });
});
