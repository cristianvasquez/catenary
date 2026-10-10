import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rdfsRules } from '@catenary/rdfs';
import { InstanceProperties, NS, classDef, iriId, permittedRelations, schemaFormShape } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { schemaPort } from '../src/schema';
import { rdf } from '../src/terms';
import { DATA, DPROD, PROV, SHAPES, emptyGraph, parseQuads, writeWorkspace } from './helpers';

const EX = 'http://ex/';
const ONTOLOGY = `@prefix rdf: <${NS.rdf}> . @prefix rdfs: <${NS.rdfs}> . @prefix xsd: <${NS.xsd}> . @prefix owl: <${NS.owl}> .
@prefix ex: <${EX}> . @prefix dprod: <${DPROD}> . @prefix prov: <${PROV}> .
ex:Person rdfs:label "Person" ; rdfs:comment "A human." .
ex:Employee rdfs:subClassOf ex:Person .
ex:Team rdfs:label "Team" .
ex:Robot rdfs:label "Robot" .
ex:A rdfs:subClassOf ex:B . ex:B rdfs:subClassOf ex:A .
ex:Code a rdfs:Datatype .
ex:memberOf rdfs:domain ex:Person ; rdfs:range ex:Team ; rdfs:label "member of" ; rdfs:comment "The team of a person." .
ex:age rdfs:domain ex:Person ; rdfs:range xsd:integer .
ex:note rdfs:domain ex:Person, ex:Team ; rdfs:range rdfs:Literal .
ex:anything rdfs:domain ex:Team .
ex:code rdfs:domain ex:Team ; rdfs:range ex:Code .
ex:mixed rdfs:domain ex:Robot ; rdfs:range xsd:string, xsd:integer .
ex:knows rdfs:domain ex:Person ; rdfs:range ex:Person .
ex:cycle rdfs:domain ex:A ; rdfs:range ex:B .
rdfs:seeAlso rdfs:domain rdfs:Resource .
dprod:dataProductOwner rdfs:domain dprod:DataProduct ; rdfs:range ex:Team .
ex:height a rdf:Property ; rdfs:label "height" .
ex:ann a ex:Employee ; rdfs:label "Ann" .
ex:bob a ex:Person ; rdfs:label "Bob" .
ex:core a ex:Team ; rdfs:label "Core team" .
`;

async function rules(text = ONTOLOGY) {
    const g = emptyGraph();
    for (const q of await parseQuads(text)) g.store.add(rdf.quad(q.subject, q.predicate, q.object, g.model));
    return rdfsRules(schemaPort(g));
}
const ofPredicate = (rs: Awaited<ReturnType<typeof rules>>, p: string) => rs.rules.filter(r => r.predicate === EX + p).map(r => `${r.domain.slice(EX.length)} ${JSON.stringify(r.range)}`);

describe('RDFS domain and range providers (@catenary/rdfs)', () => {
    it('law_domainSubclasses: a domain applies to its class and its written subclasses; a class range also admits the subclasses', async () => {
        const rs = await rules();
        expect(ofPredicate(rs, 'memberOf')).toEqual([`Person {"kind":"class","iri":"${EX}Team"}`, `Employee {"kind":"class","iri":"${EX}Team"}`]);
        expect(ofPredicate(rs, 'knows')).toEqual([
            `Person {"kind":"class","iri":"${EX}Person"}`, `Person {"kind":"class","iri":"${EX}Employee"}`,
            `Employee {"kind":"class","iri":"${EX}Person"}`, `Employee {"kind":"class","iri":"${EX}Employee"}`]);
    });

    it('several domains are a union; literal ranges are fields; no range and rdfs:Literal take any value; a declared datatype is literal', async () => {
        const rs = await rules();
        expect(ofPredicate(rs, 'note')).toEqual(['Person {"kind":"literal"}', 'Employee {"kind":"literal"}', 'Team {"kind":"literal"}']);
        expect(ofPredicate(rs, 'age')).toEqual([`Person {"kind":"literal","datatype":"${NS.xsd}integer"}`, `Employee {"kind":"literal","datatype":"${NS.xsd}integer"}`]);
        expect(ofPredicate(rs, 'anything')).toEqual(['Team {"kind":"literal"}']);
        expect(ofPredicate(rs, 'code')).toEqual([`Team {"kind":"literal","datatype":"${EX}Code"}`]);
    });

    it('a subclass cycle ends; built-in vocabularies give no rules; labels and comments come from the predicate and the class', async () => {
        const rs = await rules();
        expect(ofPredicate(rs, 'cycle').sort()).toEqual([`A {"kind":"class","iri":"${EX}A"}`, `A {"kind":"class","iri":"${EX}B"}`,
            `B {"kind":"class","iri":"${EX}A"}`, `B {"kind":"class","iri":"${EX}B"}`]);
        expect(rs.rules.some(r => r.predicate.startsWith(NS.rdfs))).toBe(false);
        expect(rs.rules.find(r => r.predicate === EX + 'memberOf')).toMatchObject({ name: 'member of', description: 'The team of a person.' });
        expect(rs.rules.find(r => r.predicate === EX + 'age')!.name).toBeUndefined();
        expect(rs.classes[EX + 'Person']).toEqual({ name: 'Person', description: 'A human.' });
        expect(rs.classes[EX + 'Employee']).toEqual({});
    });

    it('no rdfs:domain: no rules', async () => {
        expect(await rules(`<${EX}p> <${NS.rdfs}range> <${EX}Team> .`)).toEqual({ rules: [], classes: {} });
    });
});

describe('RDFS rules in the store', () => {
    let dir: string, store: ModelStore;
    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'catenary-rdfs-'));
        writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
        writeFileSync(join(dir, 'data.ttl'), DATA);
        writeFileSync(join(dir, 'ontology.ttl'), ONTOLOGY);
        store = new ModelStore();
        store.watching = false;
        expect(await store.open(writeWorkspace(dir))).toEqual({ ok: true });
    });
    afterEach(async () => {
        await store.idle();
        store.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const id = (local: string) => iriId(EX + local);

    it('law_shaclWins: the metamodel has the RDFS classes and rules; the shapes win for a predicate that they describe', () => {
        const { meta } = store;
        const person = classDef(meta, EX + 'Person')!;
        expect(person).toMatchObject({ name: 'Person', description: 'A human.', shapes: [] });
        expect(person.relations.map(r => [r.name, r.targetClass, r.source])).toEqual([
            ['knows', EX + 'Person', 'rdfs'], ['knows', EX + 'Employee', 'rdfs'], ['member of', EX + 'Team', 'rdfs']]);
        expect(person.fields.map(f => [f.name, f.datatype, f.source])).toEqual([['age', NS.xsd + 'integer', 'rdfs'], ['note', undefined, 'rdfs']]);
        expect(classDef(meta, EX + 'Robot')!.fields.map(f => [f.path, f.datatype])).toEqual([[EX + 'mixed', undefined]]);
        const product = classDef(meta, DPROD + 'DataProduct')!;
        expect(product.relations.filter(r => r.path === DPROD + 'dataProductOwner')).toMatchObject([{ targetClass: PROV + 'Agent' }]);
        expect(product.relations.every(r => !r.source)).toBe(true);
        // The SHACL classes keep their palette order; the RDFS classes follow.
        expect(meta.classes.findIndex(c => c.iri === EX + 'Person')).toBeGreaterThan(meta.classes.findIndex(c => c.iri === DPROD + 'DataProduct'));
    });

    it('the link picker offers RDFS relations; connect accepts them, also to a subclass instance', () => {
        const choices = store.linkChoices('out', id('bob'), '');
        if (!choices || 'error' in choices) throw new Error('no choices');
        const member = choices.sections.find(s => s.predicate === EX + 'memberOf')!;
        expect(member.candidates.map(c => c.label)).toEqual(['Core team']);
        expect(permittedRelations(store.meta, [EX + 'Person'], [EX + 'Employee']).map(r => r.name)).toEqual(['knows']);
        expect(store.execute({ kind: 'createRelation', subject: id('bob'), predicate: EX + 'knows', object: id('ann') })).toMatchObject({ ok: true });
        expect(store.execute({ kind: 'createRelation', subject: id('core'), predicate: EX + 'knows', object: id('ann') }))
            .toMatchObject({ ok: false, error: expect.stringMatching(/schema does not permit/) });
    });

    it('Properties: a schema form for the RDFS rules, its shape in the form shapes only, and its link candidates', () => {
        const props = store.properties(id('bob')) as InstanceProperties;
        const shape = schemaFormShape('rdfs', EX + 'Person');
        expect(props.schema).toEqual([{ id: shape, uri: shape, label: 'Person (RDFS)', predicates: [EX + 'age', EX + 'knows', EX + 'memberOf', EX + 'note'] }]);
        expect(props.candidates).toContain(`<${EX}core>`);
        expect(store.shapesText()).toContain(`<${shape}>`);
        // Validation reads the shapes dataset: no RDFS rule is in it.
        const dataset = (store as unknown as { metamodel: { dataset: { match(...a: unknown[]): { size: number } } } }).metamodel.dataset;
        expect(dataset.match(rdf.namedNode(shape)).size).toBe(0);
    });

    it('a data statement keeps the metamodel; an RDFS statement on disk rebuilds it', async () => {
        const version = store.snapshot().shapesVersion;
        const age = { [EX + 'age']: [{ termType: 'Literal' as const, value: '40', datatype: NS.xsd + 'integer' }] };
        expect(store.execute({ kind: 'setStatements', id: id('bob'), values: age })).toEqual({ ok: true });
        expect(store.snapshot().shapesVersion).toBe(version);
        await store.idle();
        writeFileSync(join(dir, 'ontology.ttl'), ONTOLOGY + `<${EX}height> <${NS.rdfs}domain> <${EX}Person> .\n`);
        await store.syncFromDisk();
        expect(classDef(store.meta, EX + 'Person')!.fields.map(f => f.path)).toContain(EX + 'height');
    });
});

describe('ModelGraph.shapesRevision', () => {
    it('changes with an RDFS schema statement of the model graph and with the label of a schema predicate, not with other data', () => {
        const g = emptyGraph(), n = (local: string) => rdf.namedNode(EX + local), p = (local: string) => rdf.namedNode(NS.rdfs + local);
        let revision = g.shapesRevision;
        const changed = () => { const c = g.shapesRevision !== revision; revision = g.shapesRevision; return c; };
        g.add(n('bob'), n('age'), rdf.literal('40'));
        expect(changed()).toBe(false);
        g.add(n('age'), p('domain'), n('Person'));
        expect(changed()).toBe(true);
        g.add(n('age'), p('label'), rdf.literal('age'));
        expect(changed()).toBe(true);
        g.add(n('Person'), p('comment'), rdf.literal('A human.'));
        expect(changed()).toBe(true);
        g.add(n('bob'), p('label'), rdf.literal('Bob'));
        expect(changed()).toBe(false);
        g.add(n('Employee'), p('subClassOf'), n('Person'));
        expect(changed()).toBe(true);
    });
});
