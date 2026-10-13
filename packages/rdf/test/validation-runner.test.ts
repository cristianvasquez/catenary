import { afterEach, describe, expect, inject, it, vi } from 'vitest';
import { NS, type Violation } from '@catenary/model';
import * as validation from '../src/validate';
import { ShaclWorker, ValidationRunner, ValidationSource, WorkerLike, stopValidationWorker, useValidationWorker } from '../src/validation-runner';
import { EventEmitter } from 'node:events';
import { ModelGraph, REPORT_GRAPH } from '../src/graph';
import { elementId } from '../src/ids';
import { Metamodel } from '../src/shapes';
import { skosProjection, validationInput } from '../src/validation-data';
import { rdf } from '../src/terms';
import { DPROD, emptyGraph, load, meta } from './helpers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelTriples, isInstance } from '../src/vocabulary';

declare module 'vitest' {
    export interface ProvidedContext {
        /** The worker file that vitest.global-setup.mts bundled from current source for this run. */
        validationWorker: string;
    }
}

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
    graph: g, input: () => ({ data: validationInput(modelTriples(g), metamodel.dataset), shapes: [...metamodel.dataset] }),
    violations: rs => validation.violationsOf(rs, metamodel, iri => isInstance(g, rdf.namedNode(iri)) ? elementId(rdf.namedNode(iri)) : undefined)
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

/** A worker thread that answers only when the test says so. `terminate` resolves when the test calls `exit`. */
class FakeWorker extends EventEmitter implements WorkerLike {
    readonly posted: { id: number }[] = [];
    terminated = false;
    protected exited = Promise.withResolvers<number>();
    postMessage(m: { id: number }): void { this.posted.push(m); }
    unref(): void {}
    terminate(): Promise<number> { this.terminated = true; return this.exited.promise; }
    /** Answer the request `id` with one violation whose message is `message`. */
    answer(id: number, message: string): void { this.emit('message', { id, results: [result(message)], report: [] }); }
    exit(code = 1): void { this.emit('exit', code); this.exited.resolve(code); }
}

describe('ValidationRunner disposal (spec/manifest.hs §3.5)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('law_disposedRunnerSilent: dispose cancels the pending run; later changes start nothing', async () => {
        const spy = vi.spyOn(validation, 'validate').mockResolvedValue({ results: [result('x')], report: [] });
        const t = manualTimers();
        let changes = 0;
        const r = new ValidationRunner(() => stub(), () => changes++, t.timers);
        r.invalidate();
        expect(t.count()).toBe(1);
        await r.dispose();
        expect(t.count()).toBe(0);
        r.invalidate();
        expect(t.count()).toBe(0);
        await r.now();
        t.fire();
        expect(spy).not.toHaveBeenCalled();
        expect(changes).toBe(0);
        expect(r.disposed).toBe(true);
    });

    it('law_disposalAwaitsRuns: dispose resolves after the running run ends, and drops its result; each call gives the same promise', async () => {
        const held = Promise.withResolvers<validation.ValidationReport>();
        vi.spyOn(validation, 'validate').mockReturnValueOnce(held.promise);
        const g = emptyGraph();
        let changes = 0;
        const r = new ValidationRunner(() => stub(g), () => changes++, manualTimers().timers);
        const running = r.now();
        const disposal = r.dispose();
        expect(r.dispose()).toBe(disposal);
        let done = false;
        void disposal.then(() => { done = true; });
        await Promise.resolve();
        await Promise.resolve();
        expect(done).toBe(false);
        held.resolve({ results: [result('stale')], report: [rdf.quad(rdf.namedNode('urn:r'), rdf.namedNode('urn:p'), rdf.literal('stale'))] });
        await disposal;
        expect(done).toBe(true);
        await running;
        expect(r.violations).toEqual([]);
        expect(g.match(null, null, null, rdf.namedNode(REPORT_GRAPH))).toHaveLength(0);
        expect(changes).toBe(0);
    });

    it('law_disposalKeepsWorker: two runners share a worker; disposing one keeps the worker and the other runner reports', async () => {
        const workers: FakeWorker[] = [];
        const worker = new ShaclWorker(() => { const w = new FakeWorker(); workers.push(w); return w; });
        const changed: string[] = [];
        const one = new ValidationRunner(() => stub(), () => changed.push('one'), manualTimers().timers, worker);
        const two = new ValidationRunner(() => stub(), () => changed.push('two'), manualTimers().timers, worker);
        useValidationWorker('fake-worker.js');
        try {
            const runs = [one.now(), two.now()];
            await vi.waitFor(() => expect(workers[0]?.posted).toHaveLength(2));
            const [a, b] = workers[0].posted.map(m => m.id);
            const disposal = one.dispose();
            workers[0].answer(a, 'from one');
            await disposal;
            workers[0].answer(b, 'from two');
            await Promise.all(runs);
            expect(changed).toEqual(['two']);
            expect(two.violations.map(v => v.message)).toEqual(['from two']);
            expect(one.violations).toEqual([]);
            expect(workers).toHaveLength(1);
            expect(workers[0].terminated).toBe(false);
            expect(worker.running).toBe(true);
        } finally {
            useValidationWorker(undefined);
        }
    });

    it('law_workerShutdownStops: shutdown fails the waiting requests and resolves after the thread stopped', async () => {
        const w = new FakeWorker();
        const worker = new ShaclWorker(() => w);
        const request = worker.run([], []);
        const failed = request.catch((e: Error) => e.message);
        const shutdown = worker.shutdown();
        expect(await failed).toBe('the validation worker was stopped');
        expect(w.terminated).toBe(true);
        expect(worker.running).toBe(false);
        let done = false;
        void shutdown.then(() => { done = true; });
        await Promise.resolve();
        expect(done).toBe(false);
        // A second call while the thread stops waits too.
        let again = false;
        void worker.shutdown().then(() => { again = true; });
        await Promise.resolve();
        expect(again).toBe(false);
        w.exit(0);
        await shutdown;
        expect(done).toBe(true);
        await vi.waitFor(() => expect(again).toBe(true));
        await worker.shutdown();
    });

    it('law_failureKeepsOtherWorkers: an error or exit of a replaced worker does not fail the requests of the new worker', async () => {
        const workers: FakeWorker[] = [];
        const worker = new ShaclWorker(() => { const w = new FakeWorker(); workers.push(w); return w; });
        const first = worker.run([], []).catch((e: Error) => e.message);
        workers[0].emit('error', new Error('crash'));
        expect(await first).toBe('crash');
        const second = worker.run([], []);
        expect(workers).toHaveLength(2);
        workers[0].exit(1);
        workers[0].emit('error', new Error('late'));
        workers[1].answer(workers[1].posted[0].id, 'ok');
        expect((await second).results.map(r => r.messages[0])).toEqual(['ok']);
        expect(worker.running).toBe(true);
    });

    it('a reply of a replaced worker is stale: it does not answer the request with the same id of the new worker', async () => {
        const workers: FakeWorker[] = [];
        const worker = new ShaclWorker(() => { const w = new FakeWorker(); workers.push(w); return w; });
        const first = worker.run([], []).catch((e: Error) => e.message);
        workers[0].emit('error', new Error('crash'));
        expect(await first).toBe('crash');
        const second = worker.run([], []);
        const id = workers[1].posted[0].id;
        let answered = false;
        void second.then(() => { answered = true; });
        workers[0].answer(id, 'stale');
        workers[0].answer(workers[0].posted[0].id, 'stale');
        await Promise.resolve();
        expect(answered).toBe(false);
        workers[1].answer(id, 'fresh');
        expect((await second).results.map(r => r.messages[0])).toEqual(['fresh']);
    });
});

describe('validation in a worker thread', () => {
    // The owner of useValidationWorker stops the shared worker at its end (law_workerShutdownStops).
    afterEach(async () => {
        useValidationWorker(undefined);
        await stopValidationWorker();
    });

    it('gives the violations and the report of a run in this thread', async () => {
        const g = await load();
        const metamodel = await meta();
        // A data product without its required owner: a violation.
        g.add(rdf.namedNode('urn:x:product'), rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(DPROD + 'DataProduct'), g.union);
        g.add(rdf.namedNode('urn:x:product'), rdf.namedNode(NS.rdfs + 'label'), rdf.literal('Product'), g.union);
        const run = async () => {
            let r!: ValidationRunner;
            await new Promise<void>(done => { r = new ValidationRunner(() => sourceOf(g, metamodel), () => done()); void r.now().then(() => done()); });
            return { violations: r.violations, report: g.match(null, null, null, rdf.namedNode(REPORT_GRAPH)).length };
        };
        useValidationWorker(undefined);
        const here = await run();
        expect(here.violations.length).toBeGreaterThan(0);
        useValidationWorker(inject('validationWorker'));
        expect(await run()).toEqual(here);
    });
});

describe('report patch events', () => {
    afterEach(() => vi.restoreAllMocks());

    it('publishes a changed report through the patch path even when violation counts stay the same', async () => {
        const g = emptyGraph(), reportGraph = rdf.namedNode(REPORT_GRAPH);
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
        expect(events.every(e => e.graphs.length === 1 && e.graphs[0] === REPORT_GRAPH)).toBe(true);
        expect(g.keys).toEqual(keys);
        expect(g.match(null, null, null, reportGraph).map(q => q.object.value)).toEqual(['second']);
    });
});

describe('the validator (spec/manifest.hs §9 validator)', () => {
    const q = (s: string, p: string, o: string) => rdf.quad(rdf.namedNode(s), rdf.namedNode(p), rdf.namedNode(o));
    const SKOS = NS.skos, EX = 'urn:ex:';

    it('is pure: it imports nothing from the store or the workspace', () => {
        const src = readFileSync(join(__dirname, '..', 'src', 'validate.ts'), 'utf8');
        expect([...src.matchAll(/from '\.\/([\w-]+)'/g)].map(x => x[1]).sort()).toEqual(['terms']); // terms.ts imports only rdf-core
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
