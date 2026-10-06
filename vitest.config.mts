import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    root,
    resolve: {
        // Test current source, never a stale package build. No tsc or webpack in the edit/test loop.
        alias: {
            '@catenary/model': fileURLToPath(new URL('./packages/model/src/index.ts', import.meta.url)),
            '@catenary/rdf': fileURLToPath(new URL('./packages/rdf/src/index.ts', import.meta.url)),
            'rdf-files': fileURLToPath(new URL('./packages/rdf-files/src/index.ts', import.meta.url))
        }
    },
    test: {
        environment: 'node',
        include: ['packages/*/test/**/*.test.ts', 'modeler/test/**/*.test.ts'],
        pool: 'threads',
        maxWorkers: 4,
        restoreMocks: true
    }
});
