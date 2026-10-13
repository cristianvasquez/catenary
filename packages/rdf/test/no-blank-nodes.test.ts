import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NS } from '@catenary/model';
import type { Quad } from '@rdfjs/types';
import { ModelGraph } from '../src/graph';
import * as ops from '../src/ops';
import { OxigraphStore } from 'rdf-files';
import { SKOLEM_BASE, skolemize } from 'rdf-core';
import { rdf } from '../src/terms';
import { parseTrig } from '../src/trig';
import { SHAPES, openStore, tempWorkspace, value, writeWorkspace } from './helpers';
import { newModelGraph } from '../src/model-graph';

const blank = (qs: Quad[]) => qs.filter(q => q.subject.termType === 'BlankNode' || q.object.termType === 'BlankNode');
const EX = 'http://ex/';
const n = (l: string) => rdf.namedNode(EX + l);

// Data with a nested value (two levels).
const TRIG = `@prefix ex: <${EX}> . @prefix rdfs: <${NS.rdfs}> .
<urn:name:model> { ex:a a ex:T ; rdfs:label "A" ; ex:address [ ex:city "X" ; ex:geo [ ex:lat 1 ] ] . }`;

async function graph(): Promise<ModelGraph> {
    return newModelGraph(new OxigraphStore(skolemize((await parseTrig(TRIG)).quads).quads));
}

describe('no blank nodes in the dataset (AGENTS.md)', () => {
    it('read: each blank node is a skolem IRI', async () => {
        const g = await graph();
        expect(blank(g.quads())).toEqual([]);
        const address = g.objects(n('a'), n('address'))[0];
        expect(address.value.startsWith(SKOLEM_BASE)).toBe(true);
        expect(g.objects(address, n('geo'))[0].value.startsWith(SKOLEM_BASE)).toBe(true);
    });

    it('data: a copy gives the owned values new skolem IRIs; delete removes them; a value that another subject refers to stays', async () => {
        const g = await graph();
        const copy = value(ops.copyInstance(g, 'n-http_3a_2f_2fex_2fa', 'B'));
        const b = g.match(null, rdf.namedNode(NS.rdfs + 'label'), rdf.literal('B'))[0].subject;
        const address = g.objects(n('a'), n('address'))[0], copied = g.objects(b, n('address'))[0];
        expect(copied.value.startsWith(SKOLEM_BASE) && !copied.equals(address)).toBe(true);
        const geo = g.objects(copied, n('geo'))[0];
        expect(geo.value.startsWith(SKOLEM_BASE)).toBe(true);
        g.add(n('other'), n('near'), address, g.union);
        ops.deleteInstance(g, 'n-http_3a_2f_2fex_2fa');
        expect(g.match(address).length).toBeGreaterThan(0);
        ops.deleteInstance(g, copy);
        expect(g.match(copied).length).toBe(0);
        expect(g.match(geo).length).toBe(0);
    });
});

describe('files without blank nodes', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('open: a file with blank nodes is changed, with a warning; the next save writes the skolem IRIs', async () => {
        const dir = tempWorkspace({}, 'catenary-noblank-').dir;
        writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
        writeFileSync(join(dir, 'data.ttl'), `@prefix ex: <${EX}> . @prefix rdfs: <${NS.rdfs}> . ex:a a ex:T ; rdfs:label "A" ; ex:v [ ex:w 1 ] .`);
        writeWorkspace(dir);
        const store = await openStore(join(dir, 'workspace.trig'), { watching: true });
        expect(store.dirty).toBe(true);
        expect(store.snapshot().warnings.filter(w => w.includes('data.ttl') && w.includes('replaced by IRIs')).length).toBe(1);
        expect((await store.execute({ kind: 'rename', id: 'n-http_3a_2f_2fex_2fa', label: 'A2' })).ok).toBe(true);
        await store.idle();
        expect(store.dirty).toBe(false);
        const quads = (await parseTrig(readFileSync(join(dir, 'data.ttl'), 'utf8'))).quads;
        expect(blank(quads)).toEqual([]);
        expect(quads.some(q => q.predicate.value === EX + 'v' && q.object.value.startsWith(SKOLEM_BASE))).toBe(true);
        expect(quads.some(q => q.object.value === 'A2')).toBe(true);
    });
});
