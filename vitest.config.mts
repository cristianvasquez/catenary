import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    root,
    resolve: {
        // Test current source, never a stale package build. No tsc or webpack in the edit/test loop.
        alias: {
            '@catenary/shacl/common': fileURLToPath(new URL('./packages/shacl/src/common/index.ts', import.meta.url)),
            '@catenary/shacl/backend': fileURLToPath(new URL('./packages/shacl/src/backend/index.ts', import.meta.url)),
            '@catenary/explorer': fileURLToPath(new URL('./packages/explorer/src/index.ts', import.meta.url)),
            '@catenary/rdfs': fileURLToPath(new URL('./packages/rdfs/src/index.ts', import.meta.url)),
            '@catenary/model': fileURLToPath(new URL('./packages/model/src/index.ts', import.meta.url)),
            '@catenary/rdf': fileURLToPath(new URL('./packages/rdf/src/index.ts', import.meta.url)),
            'rdf-files': fileURLToPath(new URL('./packages/rdf-files/src/index.ts', import.meta.url))
        }
    },
    test: {
        environment: 'node',
        include: ['packages/*/test/**/*.test.ts', 'modeler/test/**/*.test.ts', 'scripts/test/**/*.test.mjs'],
        pool: 'threads',
        // GitHub runners are slower than a developer machine. With 4 workers (and their SHACL worker threads) on 4 vCPUs, the main
        // Vitest thread got no CPU time ("Timeout calling onTaskUpdate"), and the fixture-wide tests did not pass in 5 s.
        ...(process.env.CI ? { maxWorkers: 2, testTimeout: 30_000 } : { maxWorkers: 4 }),
        restoreMocks: true
    }
});
