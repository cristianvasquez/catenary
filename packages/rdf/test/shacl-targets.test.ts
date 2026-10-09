import { describe, expect, it } from 'vitest';
import { applicableMatches, readNodeReferences, targetMatches } from '@catenary/shacl/backend';
import { reasonText, targetText } from '@catenary/shacl/common';
import { OxigraphStore, parseRdfSync } from 'rdf-files';

const prefix = `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`;
const node = (value: string) => ({ termType: 'NamedNode' as const, value });
const scope = { shapes: ['urn:shapes', 'urn:more'], data: ['urn:data', 'urn:shapes', 'urn:more'] };
function store(text: string) { return new OxigraphStore(parseRdfSync(prefix + text, 'application/trig')); }

describe('shared SHACL target relation', () => {
    it('law_targetNavigation: both directions agree, preserve reasons and union all targets', () => {
        const g = store(`
            <urn:shapes> {
                <urn:S> a sh:NodeShape ; sh:targetClass <urn:C>, <urn:Other> ; sh:targetNode <urn:a> ;
                    sh:targetSubjectsOf <urn:p>, <urn:q> ; sh:targetObjectsOf <urn:p> .
                <urn:Sub> rdfs:subClassOf <urn:Middle> .
            }
            <urn:more> { <urn:Middle> rdfs:subClassOf <urn:C> . }
            <urn:data> { <urn:a> a <urn:Sub> ; <urn:p> <urn:b> . <urn:b> a <urn:Other> . <urn:c> <urn:q> "value" . }
        `);
        const reverse = targetMatches(g, scope, { shapes: ['urn:S'] });
        expect(reverse.map(m => m.node.value).sort()).toEqual(['urn:a', 'urn:b', 'urn:c']);
        for (const m of reverse) expect(targetMatches(g, scope, { nodes: [m.node] })).toContainEqual(m);
        expect(reverse.find(m => m.node.value === 'urn:a')!.reasons.map(r => r.kind).sort())
            .toEqual(['targetClass', 'targetNode', 'targetSubjectsOf']);
    });

    it('keeps literals as object focus nodes, including language and datatype', () => {
        const g = store(`<urn:shapes> { <urn:S> sh:targetObjectsOf <urn:p> . }
            <urn:data> { <urn:a> <urn:p> "hello"@en, "7"^^<urn:integer> . }`);
        const matches = targetMatches(g, scope, { shapes: ['urn:S'] });
        expect(matches.map(m => m.node)).toEqual(expect.arrayContaining([
            { termType: 'Literal', value: 'hello', language: 'en' },
            { termType: 'Literal', value: '7', datatype: 'urn:integer' }
        ]));
        for (const m of matches) expect(targetMatches(g, scope, { nodes: [m.node] })).toEqual([m]);
    });

    it('excludes view and report graphs and recognizes implicit class targets', () => {
        const g = store(`<urn:shapes> { <urn:S> a sh:NodeShape, rdfs:Class . <urn:T> sh:targetObjectsOf <urn:p> . }
            <urn:data> { <urn:a> a <urn:S> . }
            <urn:view> { <urn:b> a <urn:S> ; <urn:p> <urn:c> . }
            <urn:report> { <urn:a> <urn:p> <urn:d> . <urn:Fake> sh:targetNode <urn:a> . }`);
        expect(targetMatches(g, scope, { nodes: [node('urn:a')] })).toEqual([
            { shape: 'urn:S', node: node('urn:a'), reasons: [{ kind: 'implicitClass', target: node('urn:S') }] }
        ]);
        expect(targetMatches(g, scope, { shapes: ['urn:T'] })).toEqual([]);
    });

    it('handles explicit targets without outgoing data and short-circuits empty selections', () => {
        const g = store('<urn:shapes> { <urn:S> sh:targetNode <urn:objectOnly> . }');
        expect(targetMatches(g, scope, { nodes: [node('urn:objectOnly')] })).toHaveLength(1);
        expect(targetMatches(g, scope, { nodes: [] })).toEqual([]);
        expect(targetMatches(g, scope, { shapes: [] })).toEqual([]);
    });

    it('rejects query syntax in an IRI', () => {
        expect(() => targetMatches(store(''), scope, { shapes: ['urn:S> } UNION { ?s ?p ?o'] })).toThrow('Invalid IRI');
    });

    it('shares target labels and displays the reason that actually matched', () => {
        expect(targetText({ targetClass: 'urn:C', targetObjectsOf: ['urn:p', 'urn:q'] }, s => s.slice(4)))
            .toBe('C · objects of p or q');
        expect(reasonText([{ kind: 'targetObjectsOf', target: node('urn:p') }], s => s.slice(4))).toBe('objects of p');
    });
});

describe('sh:node applicability', () => {
    const checked = (g: OxigraphStore, selection: Parameters<typeof applicableMatches>[3]) =>
        applicableMatches(g, scope, readNodeReferences(g, scope.shapes), selection);

    it.each([false, true])('follows directly targeted property shapes with an owner: %s', owned => {
        const g = store(`<urn:shapes> {
            <urn:P> a sh:PropertyShape ; sh:targetNode <urn:a> ; sh:path <urn:p> ; sh:node <urn:T> .
            <urn:T> a sh:NodeShape .
            ${owned ? '<urn:S> sh:targetNode <urn:c> ; sh:property <urn:P> .' : ''}
        } <urn:data> { <urn:a> <urn:p> <urn:b> . <urn:c> <urn:p> <urn:d> . }`);
        const forward = checked(g, { nodes: [node('urn:b')] });
        expect(forward).toEqual([{
            shape: 'urn:T', node: node('urn:b'), reasons: [{
                kind: 'node', target: node('urn:T'), sourceShape: 'urn:P', sourceNode: node('urn:a'), property: 'urn:P'
            }]
        }]);
        const reverse = checked(g, { shapes: ['urn:T'] });
        expect(reverse).toContainEqual(forward[0]);
        expect(reverse.map(m => m.node.value)).toEqual(owned ? ['urn:b', 'urn:d'] : ['urn:b']);
        if (owned) expect(reverse[1].reasons[0].sourceShape).toBe('urn:S');
        expect(checked(g, { nodes: [node('urn:a')], shapes: ['urn:T'] })).toEqual([]);
    });

    it('law_nodeNavigation: applies targetless shapes to property values and the same focus node', () => {
        const g = store(`<urn:shapes> {
            <urn:S> sh:targetNode <urn:a> ; sh:node <urn:Same> ; sh:property <urn:ps> .
            <urn:ps> sh:path <urn:p> ; sh:node <urn:Value> .
            <urn:Value> sh:targetClass <urn:Unrelated> .
        } <urn:data> { <urn:a> <urn:p> <urn:b> . }`);
        expect(checked(g, { nodes: [node('urn:a')] }).map(m => m.shape)).toEqual(['urn:S', 'urn:Same']);
        const forward = checked(g, { nodes: [node('urn:b')] });
        expect(forward.map(m => m.shape)).toEqual(['urn:Value']);
        expect(forward[0].reasons).toEqual([{
            kind: 'node', target: node('urn:Value'), sourceShape: 'urn:S', sourceNode: node('urn:a'), property: 'urn:ps'
        }]);
        expect(checked(g, { shapes: ['urn:Value'] })).toEqual(forward);
        expect(checked(g, { shapes: ['urn:Same'] })).toEqual(checked(g, { nodes: [node('urn:a')], shapes: ['urn:Same'] }));
    });

    it('terminates seeded and rootless cycles without losing nodes reached through a path', () => {
        const g = store(`<urn:shapes> {
            <urn:S> sh:targetNode <urn:a> ; sh:node <urn:T> . <urn:T> sh:node <urn:S> ; sh:property <urn:ps> .
            <urn:ps> sh:path <urn:p> ; sh:node <urn:S> .
            <urn:X> sh:node <urn:Y> . <urn:Y> sh:node <urn:X> .
        } <urn:data> { <urn:a> <urn:p> <urn:b> . <urn:b> <urn:p> <urn:a> . }`);
        expect(checked(g, { nodes: [node('urn:b')] }).map(m => m.shape)).toEqual(['urn:S', 'urn:T']);
        expect(checked(g, { shapes: ['urn:T'] }).map(m => m.node.value)).toEqual(['urn:a', 'urn:b']);
        expect(checked(g, { shapes: ['urn:X'] })).toEqual([]);
        expect(checked(g, { nodes: [node('urn:z')] })).toEqual([]);
    });

    it('evaluates inverse, sequence, alternative and repetition paths across shape files', () => {
        const g = store(`<urn:shapes> {
            <urn:S> sh:targetNode <urn:b> ; sh:property <urn:ps> . <urn:ps> sh:path <urn:sequence> ; sh:node <urn:T> .
            <urn:sequence> <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> <urn:inverse> ;
                <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> <urn:tail> .
            <urn:inverse> sh:inversePath <urn:p> .
        } <urn:more> {
            <urn:tail> <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> <urn:repeat> ;
                <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> <http://www.w3.org/1999/02/22-rdf-syntax-ns#nil> .
            <urn:repeat> sh:oneOrMorePath <urn:alt> . <urn:alt> sh:alternativePath <urn:list> .
            <urn:list> <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> <urn:q> ;
                <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> <urn:last> .
            <urn:last> <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> <urn:r> ;
                <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> <http://www.w3.org/1999/02/22-rdf-syntax-ns#nil> .
        } <urn:data> { <urn:a> <urn:p> <urn:b> ; <urn:q> <urn:c> . <urn:c> <urn:r> <urn:d> . }`);
        expect(checked(g, { shapes: ['urn:T'] }).map(m => m.node.value)).toEqual(['urn:c', 'urn:d']);
        expect(checked(g, { nodes: [node('urn:d')] }).map(m => m.shape)).toEqual(['urn:T']);
    });

    it('keeps references under sh:or and sh:not out of unconditional applicability', () => {
        const g = store(`<urn:shapes> { <urn:S> sh:targetNode <urn:a> ; sh:not <urn:not> . <urn:not> sh:node <urn:T> . }`);
        expect(checked(g, { nodes: [node('urn:a')] }).map(m => m.shape)).toEqual(['urn:S']);
    });
});
