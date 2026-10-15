// The store accepts an IRI where a command or a read takes an id, and a triple {s, p, o} where it takes a relation id (manifest §1.3, §12).
import { beforeEach, describe, expect, it } from 'vitest';
import { boxes, iriId, relationIdOf } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { DATA, DCAT, DPM, SHAPES, openStore, tempWorkspace, writeWorkspace } from './helpers';

const VIEW = 'urn:name:Product%20context';
const QUERY_SERVICE = 'urn:name:Query%20service';
const EXPOSED = DPM + 'exposedThrough';

let store: ModelStore;
beforeEach(async () => {
    const { dir } = tempWorkspace({ 'shapes.ttl': SHAPES, 'data.ttl': DATA }, 'catenary-iri-ids-');
    store = await openStore(writeWorkspace(dir));
});

/** A new dataset in the model: its id and IRI from the result. */
function dataset(label: string): { id: string; iri: string } {
    const r = store.execute({ kind: 'createInstance', classIri: DCAT + 'Dataset', label });
    if (!r.ok || !r.id || !r.iri) throw new Error(JSON.stringify(r));
    return { id: r.id, iri: r.iri };
}

describe('IRIs where commands take ids', () => {
    it('a created element gives its id and its IRI', () => {
        const d = dataset('Sales data');
        expect(d.id).toBe(iriId(d.iri));
        expect(d.iri).toBe('urn:name:Sales%20data');
    });

    it('rename with an IRI (law_iriArgumentIsId)', () => {
        const d = dataset('Sales data');
        const r = store.execute({ kind: 'rename', id: d.iri, label: 'Revenue data' });
        expect(store.resolveId(d.iri)).toBe(d.id);
        expect(r.ok).toBe(true);
        expect(store.reads.properties(d.id)).toMatchObject({ label: 'Revenue data' });
    });

    it('addToView and setBounds with the IRIs of the view and the element', () => {
        const d = dataset('Sales data');
        expect(store.execute({ kind: 'addToView', view: VIEW, ids: [d.iri], at: { x: 0, y: 0 } }).ok).toBe(true);
        expect(store.execute({ kind: 'setBounds', view: VIEW, bounds: [{ id: d.iri, x: 1234, y: 567 }] }).ok).toBe(true);
        const card = boxes(store.reads.view(iriId(VIEW))!, 'card').find(b => b.element === d.id);
        expect(card).toMatchObject({ x: 1234, y: 567 });
    });

    it('createRelation with IRIs gives the relation id; delete with a triple removes it', () => {
        const d = dataset('Sales data');
        const r = store.execute({ kind: 'createRelation', subject: d.iri, predicate: EXPOSED, object: QUERY_SERVICE });
        const id = relationIdOf(d.iri, EXPOSED, QUERY_SERVICE);
        expect(r).toMatchObject({ ok: true, id });
        expect(r.ok && r.iri).toBeFalsy();   // a relation has no IRI
        expect(store.knownId(id)).toBe(true);
        const del = store.execute({ kind: 'delete', ids: [{ s: d.iri, p: EXPOSED, o: QUERY_SERVICE } as unknown as string] });
        expect(del.ok).toBe(true);
        expect(store.knownId(id)).toBe(false);
    });

    it('delete with the IRI of a property shape deletes the property shape', () => {
        const properties = Object.values(store.reads.shapes().properties);
        const p = properties.find(x => x.uri && properties.filter(y => y.uri === x.uri).length === 1)!;
        expect(store.resolveId(p.uri!)).toBe(p.id);
        expect(store.execute({ kind: 'delete', ids: [p.uri!] }).ok).toBe(true);
        expect(store.reads.shapes().properties[p.id]).toBeUndefined();
    });

    it('addConcept with the IRI of the value set gives the IRI of the concept', () => {
        const set = store.execute({ kind: 'createValueSet', valueSet: 'scheme', label: 'Colors' });
        if (!set.ok || !set.iri) throw new Error(JSON.stringify(set));
        const r = store.execute({ kind: 'addConcept', set: set.iri, label: 'Red' });
        expect(r.ok).toBe(true);
        expect(r.ok && r.iri).toBeTruthy();
        expect(r.ok && r.iri).toBe(r.ok && r.id);
        expect(store.reads.shapes().valueSets[set.id!].members.map(m => m.uri)).toEqual([r.ok && r.iri]);
    });

    it('an unknown IRI fails, and the error names the IRI', () => {
        const r = store.execute({ kind: 'rename', id: 'urn:name:Nothing%20here', label: 'X' });
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toContain('urn:name:Nothing%20here');
    });
});

describe('IRIs where reads take ids (CLI)', () => {
    it('properties with an IRI or a property shape IRI', () => {
        const r = store.resolveQueryArgs('properties', [QUERY_SERVICE]);
        expect(r).toEqual({ args: [iriId(QUERY_SERVICE)] });
        const p = Object.values(store.reads.shapes().properties).find(x => x.uri)!;
        expect(store.resolveQueryArgs('properties', [p.uri])).toEqual({ args: [store.resolveId(p.uri!)] });
    });

    it('a triple where a read takes a list of ids', () => {
        const d = dataset('Sales data');
        store.execute({ kind: 'createRelation', subject: d.iri, predicate: EXPOSED, object: QUERY_SERVICE });
        expect(store.resolveQueryArgs('unplaced', [[{ s: d.iri, p: EXPOSED, o: QUERY_SERVICE }, d.iri]]))
            .toEqual({ args: [[relationIdOf(d.iri, EXPOSED, QUERY_SERVICE), d.id]] });
    });

    it('an unknown IRI or id gives an error that names the value', () => {
        const r = store.resolveQueryArgs('properties', ['urn:name:MEPS%20mirror']);
        expect(r).toEqual({ error: expect.stringContaining('urn:name:MEPS%20mirror') });
        expect(store.resolveQueryArgs('properties', [iriId('urn:name:MEPS%20mirror')])).toHaveProperty('error');
    });

    it('parameters that are not ids stay the same', () => {
        expect(store.resolveQueryArgs('instancesNamed', ['urn:name:Query%20service'])).toEqual({ args: ['urn:name:Query%20service'] });
    });
});
