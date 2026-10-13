// The measurement report of `pnpm test:perf` (vitest.perf.config.mts). Each measured step has its individual samples, p50, p95 and
// maximum, and the limit that its p50 must keep. The report states the runtime, the CPU allocation and the fixture size. A run is
// diagnostic unless the operator sets CATENARY_PERF_ENV to a description of a controlled environment: then an overrun is a
// regression. In a diagnostic run an overrun is inconclusive. The load average is recorded, but it does not classify a run.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { tracer } from '../../src/trace';

/** Unmeasured runs before the samples of a step: the first read after the open builds the shapes index and the request context. */
export const WARMUP = 2;
/** Measured runs of each step. */
export const SAMPLES = 20;

/** The elapsed time of the top `rpc` span of `read` in each of SAMPLES runs, after WARMUP unmeasured runs. An async read counts until it settles. */
export async function spanSamples(name: string, read: () => unknown): Promise<number[]> {
    for (let i = 0; i < WARMUP; i++) await read();
    const out: number[] = [];
    tracer.setClient(true);
    try {
        for (let i = 0; i < SAMPLES; i++) {
            const since = tracer.take().seq;
            await tracer.span('rpc', name, read);
            out.push(tracer.take(since).spans.find(s => s.kind === 'rpc' && s.name === name && s.parent === undefined)!.ms);
        }
    } finally {
        tracer.setClient(false);
    }
    return out;
}

export interface Measurement {
    step: string;
    /** The limit of the p50, in ms: readBudgetMs, or the ceiling of an accepted exception. */
    limitMs: number;
    /** Why the limit is not readBudgetMs (the spec/open.md row), when it is not. */
    exception?: string;
    samplesMs: number[];
    p50: number;
    p95: number;
    max: number;
    over: boolean;
}

/** The nearest-rank percentile of `xs`. */
export const percentile = (xs: number[], p: number): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

const round = (ms: number) => Math.round(ms * 10) / 10;

function cpuAllocation() {
    const cpus = os.cpus();
    const read = (file: string) => { try { return readFileSync(file, 'utf8').trim(); } catch { return undefined; } };
    return {
        model: cpus[0]?.model,
        logicalCpus: cpus.length,
        availableParallelism: os.availableParallelism(),
        // Linux: the CPUs that the process may run on, and the CPU quota of its cgroup ("max 100000" is no quota).
        cpusAllowed: /Cpus_allowed_list:\s*(.+)/.exec(read('/proc/self/status') ?? '')?.[1] ?? null,
        cgroupCpuMax: read('/sys/fs/cgroup/cpu.max') ?? null,
        totalMemMiB: Math.round(os.totalmem() / 2 ** 20),
        loadAverage: os.loadavg().map(round)
    };
}

/** The report of one perf file. `write` saves it as JSON in CATENARY_PERF_DIR and prints a table. */
export class PerfReport {
    readonly measurements: Measurement[] = [];
    readonly environment = process.env.CATENARY_PERF_ENV
        ? { kind: 'controlled' as const, description: process.env.CATENARY_PERF_ENV }
        : { kind: 'diagnostic' as const, description: 'local run: no controlled environment given (CATENARY_PERF_ENV)' };

    constructor(readonly name: string, readonly fixture: Record<string, unknown>) {}

    /** Record the samples of `step` and assert that their p50 keeps `limitMs`. The report keeps an overrun. */
    check(step: string, samplesMs: number[], limitMs: number, exception?: string): void {
        const m: Measurement = {
            step, limitMs, exception, samplesMs: samplesMs.map(round),
            p50: round(percentile(samplesMs, 50)), p95: round(percentile(samplesMs, 95)), max: round(Math.max(...samplesMs)), over: false
        };
        m.over = m.p50 > limitMs;
        this.measurements.push(m);
        const verdict = this.environment.kind === 'controlled' ? 'regression' : 'inconclusive (diagnostic run)';
        expect(m.over, `${step}: p50 ${m.p50} ms > ${limitMs} ms, samples ${m.samplesMs.join(', ')}: ${verdict}`).toBe(false);
    }

    write(): string {
        const dir = process.env.CATENARY_PERF_DIR ?? join(os.tmpdir(), 'catenary-perf');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${this.name}.json`);
        const report = {
            name: this.name,
            date: new Date().toISOString(),
            environment: this.environment,
            runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, osRelease: os.release() },
            cpu: cpuAllocation(),
            warmup: `${WARMUP} unmeasured runs of each step after the open, then ${SAMPLES} measured runs; the limit applies to the p50`,
            fixture: this.fixture,
            measurements: this.measurements,
            overruns: this.measurements.filter(m => m.over).map(m => m.step)
        };
        writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
        const rows = this.measurements.map(m => `${m.over ? 'OVER' : 'ok  '} ${m.step.padEnd(36)} p50 ${String(m.p50).padStart(7)}  p95 ${String(m.p95).padStart(7)}  max ${String(m.max).padStart(7)}  limit ${m.limitMs}${m.exception ? ` (${m.exception})` : ''}`);
        console.log([`${this.name} [${this.environment.kind}]: ${file}`, ...rows].join('\n'));
        return file;
    }
}
