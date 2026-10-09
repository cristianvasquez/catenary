// SHACL validation of the model graph after changes: debounced, and a run that a newer change makes stale is discarded. The report
// graph (ADR 0007) goes to the store directly, not through the edit log (no undo, no file, no dirty state).
// With a worker file (`useValidationWorker`, the bundled backend), shacl-engine runs in a worker thread: the backend thread stays free
// for edits and requests. Without one (tests from the source), it runs in this thread.

import { NS, Violation } from '@catenary/model';
import type { Quad, Term } from '@rdfjs/types';
import { Worker } from 'worker_threads';
import { ModelGraph, VALIDATION_GRAPH } from './graph';
import { elementId } from './ids';
import { PlainTerm, plainToQuads, quadsToPlain } from './plain-quads';
import { Metamodel } from './shapes';
import { shapesIndexOf } from './shapes-read';
import { rdf, termKey } from './terms';
import { ShaclResult, inSchemeTriples, reportQuads, validateWithReport, violationsOf } from './validate';

let workerFile: string | undefined;

/** Run shacl-engine in a worker thread from this file (validation-worker.ts, compiled). Undefined: in the backend thread. */
export function useValidationWorker(file: string | undefined): void {
    workerFile = file;
}

type Answer = { id: number; results?: ShaclResult[]; report?: PlainTerm[]; error?: string };

/** One worker thread for all runs; a failed worker is replaced at the next run. */
class ShaclWorker {
    protected worker?: Worker;
    protected next = 0;
    protected readonly waiting = new Map<number, (a: Answer) => void>();

    run(shapes: Iterable<Quad>, data: Iterable<Quad>): Promise<{ results: ShaclResult[]; report: Quad[] }> {
        const worker = this.worker ??= this.start(workerFile!);
        const id = ++this.next;
        return new Promise((resolve, reject) => {
            this.waiting.set(id, a => a.error !== undefined ? reject(new Error(a.error)) : resolve({ results: a.results!, report: plainToQuads(a.report!) }));
            worker.postMessage({ id, shapes: quadsToPlain(shapes), data: quadsToPlain(data) });
        });
    }

    protected start(file: string): Worker {
        const w = new Worker(file);
        w.unref();
        w.on('message', (a: Answer) => { this.waiting.get(a.id)?.(a); this.waiting.delete(a.id); });
        const fail = (error: string) => {
            if (this.worker === w) this.worker = undefined;
            for (const [id, done] of this.waiting) done({ id, error });
            this.waiting.clear();
        };
        w.on('error', e => fail(e.message));
        w.on('exit', code => fail(`the validation worker stopped (${code})`));
        return w;
    }
}

const shaclWorker = new ShaclWorker();

export interface Timers {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}

const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) };

export class ValidationRunner {
    violations: Violation[] = [];
    protected stamp = '';
    protected run = 0;
    protected timer?: unknown;

    /**
     * `source`: the dataset and the metamodel at the time of the run (an open replaces them), and the statements of the model graph
     * to validate (`data`; undefined: all of them). `off` (the validation mode "off"): no run; the report and the violations are
     * cleared. `stamp`: read after `data`; a new stamp is a change too (the store counts what the run checked). `changed`: the
     * violations or the stamp changed.
     * `timers`: tests give their own.
     */
    constructor(
        protected readonly source: () => { graph: ModelGraph; metamodel: Metamodel; off?: boolean; data?: () => Quad[] | undefined; stamp?: () => string },
        protected readonly changed: () => void,
        protected readonly timers: Timers = realTimers
    ) {}

    /** A running validation becomes stale at once; a new one starts after `delay` ms. */
    invalidate(delay = 250): void {
        const run = ++this.run;
        this.timers.clear(this.timer);
        this.timer = this.timers.set(() => void this.validate(run), delay);
    }

    /** Validate now; a pending or running validation becomes stale. */
    now(): Promise<void> {
        this.timers.clear(this.timer);
        return this.validate(++this.run);
    }

    /** No violations (a new dataset). */
    reset(): void {
        this.violations = [];
        this.stamp = '';
    }

    protected async validate(run: number): Promise<void> {
        const { graph: g, metamodel, off, data: own, stamp } = this.source();
        try {
            if (off) return this.publish(run, g, [], [], '');
            // The SKOS statements of the shapes files are data too: a value "in scheme X" is checked against them.
            const vocabulary = g.shapesTriples().filter(q => q.predicate.value.startsWith(NS.skos)
                || (q.predicate.value === NS.rdf + 'type' && q.object.value.startsWith(NS.skos)));
            // Imported files: only the statements that own data needs (Workspace.validationTriples).
            const data = [...own?.() ?? g.modelTriples(), ...vocabulary];
            const runStamp = stamp?.() ?? '';
            // The ids after the run: a change during the run made it stale (checked below), so the graph is the validated one.
            const instanceId = (iri: string) => {
                const t = rdf.namedNode(iri);
                return g.isInstance(t) ? elementId(t) : undefined;
            };
            const shapeId = (t: Term) => shapesIndexOf(g).byTerm.get(termKey(t));
            let violations: Violation[] = [], report: Quad[] = [];
            if (!workerFile) ({ violations, report } = await validateWithReport(data, metamodel, instanceId, shapeId));
            else if (metamodel.dataset.size) {
                const r = await shaclWorker.run(metamodel.dataset, [...data, ...inSchemeTriples(metamodel)]);
                if (run !== this.run) return;
                violations = violationsOf(r.results, metamodel, instanceId, shapeId);
                report = reportQuads(r.report);
            }
            this.publish(run, g, violations, report, runStamp);
        } catch (e) {
            console.error('[catenary] validation failed', e);
        }
    }

    /** Replace the report graph and the violations, unless a newer run made this one stale. */
    protected publish(run: number, g: ModelGraph, violations: Violation[], report: Quad[], stamp: string): void {
        if (run !== this.run) return;
        const graph = rdf.namedNode(VALIDATION_GRAPH);
        for (const q of g.store.match(null, null, null, graph)) g.store.delete(q);
        for (const q of report) g.store.add(q);
        if (stamp === this.stamp && JSON.stringify(violations) === JSON.stringify(this.violations)) return;
        this.violations = violations;
        this.stamp = stamp;
        this.changed();
    }
}
