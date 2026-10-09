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
import { tracer } from './trace';
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

export class ValidationRunner {
    violations: Violation[] = [];
    protected stamp = '';
    protected run = 0;
    protected timer?: unknown;

    /**
     * `source`: the dataset and the metamodel at the time of the run (an open replaces them), and the statements of the model graph
     * to validate (`data`; undefined: all of them). `off` (the validation mode "off"): no run; the report and the violations are
     * cleared. `focus` (the validation mode "views", read after `data`): the elements on the open views, by termKey; the SKOS
     * statements of the shapes files then go in only for these elements and for the IRIs of `data`. `stamp`: read after `data`; a new
     * stamp is a change too (the store counts what the run checked). `changed`: the violations or the stamp changed (`before`: the
     * violations before the run).
     * `timers`: tests give their own.
     */
    constructor(
        protected readonly source: () => {
            graph: ModelGraph; metamodel: Metamodel; off?: boolean; data?: () => Quad[] | undefined; focus?: () => Set<string> | undefined; stamp?: () => string
        },
        protected readonly changed: (before: Violation[]) => void,
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
        const { graph: g, metamodel, off, data: own, focus: focusOf, stamp } = this.source();
        try {
            if (off) {
                tracer.note(`run ${run}: validation is off`);
                return this.publish(run, g, [], [], '');
            }
            // The SKOS statements of the shapes files are data too: a value "in scheme X" is checked against them.
            let vocabulary = g.shapesTriples().filter(q => q.predicate.value.startsWith(NS.skos)
                || (q.predicate.value === NS.rdf + 'type' && q.object.value.startsWith(NS.skos)));
            // Imported files: only the statements that own data needs (Workspace.validationTriples).
            const model = own?.() ?? g.modelTriples();
            // Open views: only the SKOS statements of the elements on the views and of the IRIs that the data names.
            const focus = focusOf?.();
            if (focus) {
                const needed = new Set(focus);
                for (const q of model) for (const t of [q.subject, q.object]) if (t.termType === 'NamedNode') needed.add(termKey(t));
                vocabulary = vocabulary.filter(q => needed.has(termKey(q.subject)));
            }
            const data = [...model, ...vocabulary];
            const runStamp = stamp?.() ?? '';
            tracer.note(`run ${run}: ${data.length} data triples, ${metamodel.dataset.size} shapes triples${workerFile ? ', in the worker' : ''}`, data.length);
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
                if (run !== this.run) return discarded(run);
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
        if (run !== this.run) return discarded(run);
        const graph = rdf.namedNode(VALIDATION_GRAPH);
        for (const q of g.store.match(null, null, null, graph)) g.store.delete(q);
        for (const q of report) g.store.add(q);
        if (stamp === this.stamp && JSON.stringify(violations) === JSON.stringify(this.violations)) return tracer.note(`run ${run}: ${violations.length} violations, unchanged`);
        tracer.note(`run ${run}: ${violations.length} violations, changed`);
        const before = this.violations;
        this.violations = violations;
        this.stamp = stamp;
        this.changed(before);
    }
}
