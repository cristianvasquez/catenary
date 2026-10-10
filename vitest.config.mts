import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const include = ['packages/*/test/**/*.test.ts', 'modeler/test/**/*.test.ts'];
// A file that mocks or spies runs in a process of its own (the `isolated` project). Vitest resets mocks between files only in isolated
// workers, and a spy on a shared module also sees the calls of async work that an earlier file of the worker left running.
const mocking = include.flatMap(p => globSync(p, { cwd: root })).filter(f => /\bvi\.(mock|doMock|spyOn)\(/.test(readFileSync(new URL(f, import.meta.url), 'utf8')));

export default defineConfig({
    root,
    resolve: {
        // Test current source, never a stale package build. No tsc or webpack in the edit/test loop.
        alias: {
            '@catenary/shacl/common': fileURLToPath(new URL('./packages/shacl/src/common/index.ts', import.meta.url)),
            '@catenary/shacl/backend': fileURLToPath(new URL('./packages/shacl/src/backend/index.ts', import.meta.url)),
            '@catenary/explorer': fileURLToPath(new URL('./packages/explorer/src/index.ts', import.meta.url)),
            '@catenary/query': fileURLToPath(new URL('./packages/query/src/index.ts', import.meta.url)),
            '@catenary/palette': fileURLToPath(new URL('./packages/palette/src/index.ts', import.meta.url)),
            '@catenary/links': fileURLToPath(new URL('./packages/links/src/index.ts', import.meta.url)),
            '@catenary/fields': fileURLToPath(new URL('./packages/fields/src/index.ts', import.meta.url)),
            '@catenary/rdfs': fileURLToPath(new URL('./packages/rdfs/src/index.ts', import.meta.url)),
            '@catenary/model': fileURLToPath(new URL('./packages/model/src/index.ts', import.meta.url)),
            '@catenary/rdf': fileURLToPath(new URL('./packages/rdf/src/index.ts', import.meta.url)),
            'rdf-files': fileURLToPath(new URL('./packages/rdf-files/src/index.ts', import.meta.url))
        }
    },
    test: {
        environment: 'node',
        pool: 'threads',
        // GitHub runners are slower than a developer machine. With 4 workers (and their SHACL worker threads) on 4 vCPUs, the main
        // Vitest thread got no CPU time ("Timeout calling onTaskUpdate"), and the fixture-wide tests did not pass in 5 s.
        ...(process.env.CI ? { maxWorkers: 2, testTimeout: 30_000 } : { maxWorkers: 4 }),
        restoreMocks: true,
        // The files of a thread share one module graph: Oxigraph, SHACL and the TypeScript transform load once per worker, not once per
        // file (about half of the CPU time of the suite). vitest.setup.ts resets the process-wide state for each file.
        poolOptions: { threads: { isolate: false } },
        projects: [
            { extends: true, test: { name: 'shared', include, exclude: mocking, setupFiles: ['./vitest.setup.ts'] } },
            // One process at a time: the shared project already uses each core.
            { extends: true, test: { name: 'isolated', include: mocking, pool: 'forks', poolOptions: { forks: { singleFork: true, isolate: true } } } }
        ]
    }
});
