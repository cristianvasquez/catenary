import { describe, expect, it } from 'vitest';
import { Validator } from 'shacl-engine';
import { rdf } from '../src/terms';
import { parseQuads } from './helpers';

const P = `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <http://ex/> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .`;
const shapes = P + `
ex:S a sh:NodeShape ; sh:targetClass ex:C ; sh:property ex:S-status ; sh:or ex:S-or-1 .
ex:S-or-1 rdf:first ex:S-a ; rdf:rest ex:S-or-2 . ex:S-or-2 rdf:first ex:S-b ; rdf:rest rdf:nil .
ex:S-a sh:path ex:a ; sh:minCount 1 . ex:S-b sh:path ex:b ; sh:minCount 1 .
ex:S-status sh:path ex:status ; sh:in ex:S-status-in-1 ; sh:node ex:ThemesConcept .
ex:S-status-in-1 rdf:first ex:k1 ; rdf:rest ex:S-status-in-2 . ex:S-status-in-2 rdf:first ex:k2 ; rdf:rest rdf:nil .
ex:ThemesConcept a sh:NodeShape ; sh:property ex:ThemesConcept-inScheme .
ex:ThemesConcept-inScheme sh:path skos:inScheme ; sh:hasValue ex:themes .`;
const data = P + `
ex:ok a ex:C ; ex:a 1 ; ex:status ex:k1 . ex:k1 skos:inScheme ex:themes . ex:k2 skos:inScheme ex:other . ex:k3 skos:inScheme ex:themes .
ex:noOr a ex:C .
ex:badIn a ex:C ; ex:b 1 ; ex:status ex:k3 .
ex:badScheme a ex:C ; ex:b 1 ; ex:status ex:k2 .`;
const ds = async (t: string) => rdf.dataset(await parseQuads(t));
// The shapes graphs have no blank nodes (skolem.ts): RDF lists have IRI cells. shacl-engine must read them.
describe('IRI list cells', () => {
    it('shacl-engine reads sh:or and sh:in lists with IRI cells', async () => {
        const r = await new Validator(await ds(shapes), { factory: rdf }).validate({ dataset: await ds(data) });
        const got = r.results.map(x => `${x.focusNode?.value ?? x.focusNode?.term?.value} ${x.constraintComponent?.value.split('#')[1]}`).sort();
        expect(got).toEqual(['http://ex/badIn InConstraintComponent', 'http://ex/badScheme NodeConstraintComponent', 'http://ex/noOr OrConstraintComponent']);
    });
});
