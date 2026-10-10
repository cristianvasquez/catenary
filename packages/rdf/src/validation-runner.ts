// SHACL validation of the model graph after changes: debounced, and a run that a newer change makes stale is discarded. The coordinator
// (ModelStore) gives the input of each run; the validator (validate.ts) is pure. The report graph (ADR 0007) uses the shared patch path,
// outside edit history and file tracking (no undo, no file, no dirty state).
// With a worker file (`useValidationWorker`, the bundled backend), shacl-engine runs in a worker thread: the backend thread stays free
// for edits and requests. Without one (tests from the source), it runs in this thread.

import { Violation } from '@catenary/model';
import type { Quad } from '@rdfjs/types';
import { Worker } from 'worker_threads';
import { ModelGraph, Patch, VALIDATION_GRAPH } from './graph';
import { PlainTerm, plainToQuads, quadsToPlain } from './plain-quads';
import { rdf } from './terms';
import { tracer } from './trace';
import { ShaclResult, ValidationReport, validate } from './validate';

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

    run(data: Iterable<Quad>, shapes: Iterable<Quad>): Promise<ValidationReport> {
        const worker = this.worker ??= this.start(workerFile!);
        const id = ++this.next;
        return new Promise((resolve, reject) => {
            this.waiting.set(id, a => a.error !== undefined ? reject(new Error(a.error)) : resolve({ results: a.results!, report: plainToQuads(a.report!) }));
            worker.postMessage({ id, data: quadsToPlain(data), shapes: quadsToPlain(shapes) });
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

/** A newer change made the run stale: its result is not used. */
function discarded(run: number): void {
    tracer.note(`run ${run}: discarded, a newer change came`);
    tracer.event('validation', 'discarded', `run ${run}`);
}

export interface Timers {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}

const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** What a run reads from the coordinator. */
export interface ValidationSource {
    /** The dataset of the report graph. */
    graph: ModelGraph;
    /** The data and the shapes of the run (§9 validationInput), plain quads. Undefined: the mode off (no run, an empty report). */
    input(): { data: Quad[]; shapes: Quad[] } | undefined;
    /** The violations of the results, read after the run. */
    violations(results: ShaclResult[]): Violation[];
    /** Read after `input`; a new stamp is a change too (the store counts what the run checked). */
    stamp?(): string;
}

export class ValidationRunner {
    violations: Violation[] = [];
    protected stamp = '';
    protected run = 0;
    protected timer?: unknown;

    /**
     * `source`: the coordinator at the time of the run (an open replaces the dataset). `changed`: the violations or the stamp changed
     * (`before`: the violations before the run). `timers`: tests give their own.
     */
    constructor(
        protected readonly source: () => ValidationSource,
        protected readonly changed: (before: Violation[], patch: Patch) => void,
        protected readonly timers: Timers = realTimers
    ) {}

    /** A running validation becomes stale at once; a new one starts after `delay` ms. */
    invalidate(delay = 250): void {
        const run = ++this.run;
        this.timers.clear(this.timer);
        tracer.event('validation', 'scheduled', `run ${run} in ${delay} ms`);
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

    protected validate(run: number): Promise<void> {
        return tracer.span('validation', 'run', () => this.validateNow(run));
    }

    protected async validateNow(run: number): Promise<void> {
        const source = this.source(), g = source.graph;
        try {
            const input = source.input();
            if (!input) {
                tracer.note(`run ${run}: validation is off`);
                return this.publish(run, g, [], [], '');
            }
            const { data, shapes } = input, stamp = source.stamp?.() ?? '';
            tracer.note(`run ${run}: ${data.length} data triples, ${shapes.length} shapes triples${workerFile ? ', in the worker' : ''}`, data.length);
            // The worker gets a full copy of the input for each run.
            const r = workerFile && shapes.length ? await shaclWorker.run(data, shapes) : await validate(data, shapes);
            if (run !== this.run) return discarded(run);
            // The ids after the run: a change during the run made it stale (checked above), so the graph is the validated one.
            this.publish(run, g, source.violations(r.results), r.report, stamp);
        } catch (e) {
            console.error('[catenary] validation failed', e);
        }
    }

    /** Replace the report graph (the triples of `triples`) and the violations, unless a newer run made this one stale. */
    protected publish(run: number, g: ModelGraph, violations: Violation[], triples: Quad[], stamp: string): void {
        if (run !== this.run) return discarded(run);
        const graph = rdf.namedNode(VALIDATION_GRAPH);
        const report = triples.map(q => rdf.quad(q.subject, q.predicate, q.object, graph));
        const patch = g.update(() => {
            const next = rdf.dataset(report);
            for (const q of g.match(null, null, null, graph)) if (!next.has(q)) g.remove(q);
            for (const q of report) g.add(q.subject, q.predicate, q.object, graph);
        });
        if (!patch.length && stamp === this.stamp && JSON.stringify(violations) === JSON.stringify(this.violations)) return tracer.note(`run ${run}: ${violations.length} violations, unchanged`);
        tracer.note(`run ${run}: ${violations.length} violations, changed`);
        const before = this.violations;
        this.violations = violations;
        this.stamp = stamp;
        this.changed(before, patch);
    }
}
