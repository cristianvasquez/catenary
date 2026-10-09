import { afterEach, describe, expect, it, vi } from 'vitest';
import { NS, type Violation } from '@catenary/model';
import { emptyMetamodel } from '../src/shapes';
import * as validation from '../src/validate';
import { ValidationRunner, useValidationWorker } from '../src/validation-runner';
import { VALIDATION_GRAPH } from '../src/graph';
import { rdf } from '../src/terms';
import { DPROD, emptyGraph, load, meta } from './helpers';
import { existsSync } from 'node:fs';
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

describe('ValidationRunner', () => {
    afterEach(() => vi.restoreAllMocks());

    it('a burst of changes gives one run; changed only when the violations change', async () => {
        const spy = vi.spyOn(validation, 'validateWithReport').mockResolvedValue({ violations: [violation('x')], report: [] });
        const t = manualTimers();
        let changes = 0;
        const r = new ValidationRunner(() => ({ graph: emptyGraph(), metamodel: emptyMetamodel() }), () => changes++, t.timers);
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
        let finish!: (v: { violations: Violation[]; report: [] }) => void;
        vi.spyOn(validation, 'validateWithReport')
            .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
            .mockResolvedValueOnce({ violations: [], report: [] });
        const t = manualTimers();
        let changes = 0;
        const r = new ValidationRunner(() => ({ graph: emptyGraph(), metamodel: emptyMetamodel() }), () => changes++, t.timers);
        const stale = r.now();
        await r.now();
        finish({ violations: [violation('stale')], report: [] });
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
            await new Promise<void>(done => { r = new ValidationRunner(() => ({ graph: g, metamodel }), () => done()); void r.now().then(() => done()); });
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
