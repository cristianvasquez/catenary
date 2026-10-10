import { afterEach, describe, expect, it, vi } from 'vitest';
import { NS, type Violation } from '@catenary/model';
import * as validation from '../src/validate';
import { ValidationRunner, ValidationSource, useValidationWorker } from '../src/validation-runner';
import { ModelGraph, VALIDATION_GRAPH } from '../src/graph';
import { elementId } from '../src/ids';
import { Metamodel } from '../src/shapes';
import { skosProjection, validationInput } from '../src/validation-data';
import { rdf } from '../src/terms';
import { DPROD, emptyGraph, load, meta } from './helpers';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The compiled worker (pnpm check builds packages/rdf/lib): the bundled backend runs the same code next to its bundle. */
const WORKER = join(process.cwd(), 'packages', 'rdf', 'lib', 'validation-worker.js');

/** Timers that run only when the test says so. */
function manualTimers() {
    const pending = new Map<number, () => void>();
    let next = 0;
    return {
        timers: { set: (fn: () => void) => { pending.set(++next, fn); return next; }, clear: (h: unknown) => void pending.delete(h as number) },
        fire: () => { const fns = [...pending.values()]; pending.clear(); fns.forEach(f => f()); },
        count: () => pending.size
    };
}

const violation = (message: string): Violation => ({ instance: 'i', focus: 'urn:i', severity: 'Violation', component: 'MinCount', message });
/** A result whose violation has `message` (with `stub`). */
const result = (message: string): validation.ShaclResult => ({ focus: 'urn:i', component: 'MinCount', severity: NS.sh + 'Violation', messages: [message] });
/** A coordinator with one shape triple (the validator is mocked): each result becomes a violation with its message. */
const stub = (graph: ModelGraph = emptyGraph()): ValidationSource => ({
    graph, input: () => ({ data: [], shapes: [rdf.quad(rdf.namedNode('urn:s'), rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(NS.sh + 'NodeShape'))] }),
    violations: rs => rs.map(r => violation(r.messages[0]))
});
/** A coordinator like the store's, the mode All: the data of `g`, the shapes of `metamodel` (the fixture keeps them apart). */
const sourceOf = (g: ModelGraph, metamodel: Metamodel): ValidationSource => ({
    graph: g, input: () => ({ data: validationInput(g.modelTriples(), metamodel.dataset), shapes: [...metamodel.dataset] }),
    violations: rs => validation.violationsOf(rs, metamodel, iri => g.isInstance(rdf.namedNode(iri)) ? elementId(rdf.namedNode(iri)) : undefined)
});

describe('ValidationRunner', () => {
    afterEach(() => vi.restoreAllMocks());

    it('a burst of changes gives one run; changed only when the violations change', async () => {
        const spy = vi.spyOn(validation, 'validate').mockResolvedValue({ results: [result('x')], report: [] });
        const t = manualTimers();
        let changes = 0;
        const r = new ValidationRunner(() => stub(), () => changes++, t.timers);
        r.invalidate();
        r.invalidate();
        expect(t.count()).toBe(1);
        t.fire();
        await vi.waitFor(() => expect(changes).toBe(1));
        expect(spy).toHaveBeenCalledTimes(1);
        await r.now();
        expect(changes).toBe(1);
        expect(r.violations.map(v => v.message)).toEqual(['x']);
    });

    it('discards a run that a newer change made stale', async () => {
        let finish!: (v: validation.ValidationReport) => void;
        vi.spyOn(validation, 'validate')
            .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
            .mockResolvedValueOnce({ results: [], report: [] });
        const t = manualTimers();
        let changes = 0;
        const r = new ValidationRunner(() => stub(), () => changes++, t.timers);
        const stale = r.now();
        await r.now();
        finish({ results: [result('stale')], report: [] });
        await stale;
        expect(r.violations).toEqual([]);
        expect(changes).toBe(0);
    });
});

describe('validation in a worker thread', () => {

    it.skipIf(!existsSync(WORKER))('gives the violations and the report of a run in this thread', async () => {
        const g = await load();
        const metamodel = await meta();
        // A data product without its required owner: a violation.
        g.add(rdf.namedNode('urn:x:product'), rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(DPROD + 'DataProduct'));
        g.add(rdf.namedNode('urn:x:product'), rdf.namedNode(NS.rdfs + 'label'), rdf.literal('Product'));
        const run = async () => {
            let r!: ValidationRunner;
            await new Promise<void>(done => { r = new ValidationRunner(() => sourceOf(g, metamodel), () => done()); void r.now().then(() => done()); });
            return { violations: r.violations, report: g.match(null, null, null, rdf.namedNode(VALIDATION_GRAPH)).length };
        };
        useValidationWorker(undefined);
        const here = await run();
        expect(here.violations.length).toBeGreaterThan(0);
        useValidationWorker(WORKER);
        try {
            expect(await run()).toEqual(here);
        } finally {
            useValidationWorker(undefined);
        }
    });
});

describe('report patch events', () => {
    afterEach(() => vi.restoreAllMocks());

    it('publishes a changed report through the patch path even when violation counts stay the same', async () => {
        const g = emptyGraph(), reportGraph = rdf.namedNode(VALIDATION_GRAPH);
        const quad = (value: string) => rdf.quad(rdf.namedNode('urn:report'), rdf.namedNode('urn:message'), rdf.literal(value), reportGraph);
        vi.spyOn(validation, 'validate')
            .mockResolvedValueOnce({ results: [result('same')], report: [quad('first')] })
            .mockResolvedValueOnce({ results: [result('same')], report: [quad('second')] })
            .mockResolvedValueOnce({ results: [result('same')], report: [quad('second')] });
        const events: import('../src/graph').GraphChange[] = [], notifications: import('../src/graph').Patch[] = [];
        const keys = { ...g.keys };
        g.onDidChange(e => events.push(e));
        const runner = new ValidationRunner(() => stub(g), (_, patch) => notifications.push(patch));
        await runner.now();
        await runner.now();
        await runner.now();
        expect(events).toHaveLength(2);
        expect(notifications).toHaveLength(2);
        expect(notifications[1].map(c => c.op)).toEqual(['remove', 'add']);
        expect(events.every(e => e.graphs.length === 1 && e.graphs[0] === VALIDATION_GRAPH)).toBe(true);
        expect(g.keys).toEqual(keys);
        expect(g.match(null, null, null, reportGraph).map(q => q.object.value)).toEqual(['second']);
    });
});

describe('the validator (spec/manifest.hs §9 validator)', () => {
    const q = (s: string, p: string, o: string) => rdf.quad(rdf.namedNode(s), rdf.namedNode(p), rdf.namedNode(o));
    const SKOS = NS.skos, EX = 'urn:ex:';

    it('is pure: it imports nothing from the store or the workspace', () => {
        const src = readFileSync(join(__dirname, '..', 'src', 'validate.ts'), 'utf8');
        expect([...src.matchAll(/from '\.\/([\w-]+)'/g)].map(x => x[1]).sort()).toEqual(['skolem', 'terms']);
    });

    it('without shapes gives an empty report (law_validatorNoShapes)', async () => {
        expect(await validation.validate([q(EX + 'a', NS.rdf + 'type', EX + 'Thing')], [])).toEqual({ results: [], report: [] });
    });

    it('the SKOS projection: SKOS statements and implied scheme membership; with named IRIs, only statements about them', () => {
        const shapes = [
            q(EX + 'red', SKOS + 'inScheme', EX + 'colors'), q(EX + 'colors', SKOS + 'hasTopConcept', EX + 'blue'),
            q(EX + 'green', SKOS + 'topConceptOf', EX + 'colors'), q(EX + 'loose', NS.rdf + 'type', SKOS + 'Concept'),
            q(EX + 'Shape', NS.rdf + 'type', NS.sh + 'NodeShape'), q(EX + 'Shape', NS.sh + 'targetClass', EX + 'Thing')
        ];
        const keys = (qs: ReturnType<typeof q>[]) => qs.map(x => `${x.subject.value.slice(EX.length)} ${x.predicate.value.replace(/.*[#/]/, '')} ${x.object.value.replace(/.*[#:]/, '')}`).sort();
        expect(keys(skosProjection(shapes))).toEqual(['blue inScheme colors', 'colors hasTopConcept blue', 'green inScheme colors',
            'green topConceptOf colors', 'loose type Concept', 'red inScheme colors']);
        // OpenViews (law_openViewsWithinAll): the data names blue as an object; colors, green, loose and red stay out.
        const data = [q(EX + 'shown', EX + 'color', EX + 'blue')];
        expect(keys(validationInput(data, shapes, new Set()).filter(x => !x.subject.equals(data[0].subject)))).toEqual(['blue inScheme colors']);
    });
});
