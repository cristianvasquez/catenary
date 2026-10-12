import { describe, expect, it } from 'vitest';
import { Validator } from 'shacl-engine';
import { rdf } from '../src/terms';
import { parseQuads } from './helpers';

const P = `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <http://ex/> .`;
const ds = async (t: string) => rdf.dataset(await parseQuads(t));
const validate = async (constraint: string, data: string) => {
    const shapes = P + `ex:S a sh:NodeShape ; sh:targetSubjectsOf ex:p ; sh:property ex:S-p . ex:S-p sh:path ex:p ; ${constraint} .`;
    const r = await new Validator(await ds(shapes), { factory: rdf }).validate({ dataset: await ds(P + data) });
    return r.results.map(x => `${x.focusNode?.value ?? x.focusNode?.term?.value} ${x.constraintComponent?.value.split('#')[1]}`).sort();
};

// patches/shacl-engine@1.1.3.patch (rdf-ext/shacl-engine#95): each value of a single-parameter constraint is a separate constraint (SHACL 2.1.1).
// Unpatched, the engine reads no value: it matches every predicate of the focus node, or throws for sh:hasValue.
describe('shacl-engine constraints with more than one value', () => {
    it('sh:disjoint checks each property', async () => {
        expect(await validate('sh:disjoint ex:a, ex:b', `ex:ok ex:p 1 ; ex:a 2 . ex:bad ex:p 1 ; ex:b 1 .`)).toEqual(['http://ex/bad DisjointConstraintComponent']);
    });
    it('sh:equals checks each property', async () => {
        expect(await validate('sh:equals ex:a, ex:b', `ex:ok ex:p 1 ; ex:a 1 ; ex:b 1 ; ex:c 2 . ex:bad ex:p 1 ; ex:a 1 ; ex:b 2 .`)).toEqual(['http://ex/bad EqualsConstraintComponent', 'http://ex/bad EqualsConstraintComponent']);
    });
    it('sh:hasValue checks each value', async () => {
        expect(await validate('sh:hasValue 1, 2', `ex:ok ex:p 1, 2 . ex:bad ex:p 1 .`)).toEqual(['http://ex/bad HasValueConstraintComponent']);
    });
    it('sh:lessThan checks each property', async () => {
        expect(await validate('sh:lessThan ex:a, ex:b', `ex:ok ex:p 1 ; ex:a 2 ; ex:b 3 . ex:bad ex:p 3 ; ex:a 4 ; ex:b 2 .`)).toEqual(['http://ex/bad LessThanConstraintComponent']);
    });
    it('sh:lessThanOrEquals checks each property', async () => {
        expect(await validate('sh:lessThanOrEquals ex:a, ex:b', `ex:ok ex:p 1 ; ex:a 1 ; ex:b 2 ; ex:c 0 . ex:bad ex:p 2 ; ex:a 2 ; ex:b 1 .`)).toEqual(['http://ex/bad LessThanOrEqualsConstraintComponent']);
    });
});
