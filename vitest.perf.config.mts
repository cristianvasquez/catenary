// pnpm test:perf: the elapsed-time measurements of packages/*/test/perf (spec/manifest.hs §11.3 readBudgetMs). Not part of pnpm test
// or pnpm verify. One file at a time in one process, so the files do not measure each other. Each file writes a JSON report to
// CATENARY_PERF_DIR (default: a new temporary directory). Without CATENARY_PERF_ENV a run is diagnostic (packages/rdf/test/perf/report.ts).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

process.env.CATENARY_PERF_DIR ??= mkdtempSync(join(tmpdir(), 'catenary-perf-'));
console.log(`test:perf reports: ${process.env.CATENARY_PERF_DIR}`);

export default defineConfig({
    root: base.root,
    resolve: base.resolve,
    test: {
        environment: 'node',
        include: ['packages/*/test/perf/**/*.perf.ts'],
        pool: 'forks',
        poolOptions: { forks: { singleFork: true, isolate: true } },
        fileParallelism: false,
        sequence: { shuffle: false },
        setupFiles: ['./vitest.setup.ts']
    }
});
