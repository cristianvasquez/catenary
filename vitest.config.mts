import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { sourceAliases } from './vitest.aliases.mts';

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    // Test current source, never a stale package build. No tsc or webpack in the edit/test loop.
    resolve: { alias: sourceAliases },
    test: {
        include: ['packages/*/test/**/*.test.ts', 'modeler/test/**/*.test.ts'],
        environment: 'node',
        pool: 'threads',
        // Each test file has its own module graph (Vitest isolation, the default): module state, mocks and spies of one file do not
        // reach another file. Do not set isolate: false to make the suite faster (docs/architecture.md → Testing).
        poolOptions: { threads: { isolate: true } },
        // GitHub runners are slower than a developer machine. With 4 workers (and their SHACL worker threads) on 4 vCPUs, the main
        // Vitest thread got no CPU time ("Timeout calling onTaskUpdate"), and the fixture-wide tests did not pass in 5 s.
        ...(process.env.CI ? { maxWorkers: 2, testTimeout: 30_000 } : { maxWorkers: 4 }),
        // After each test: restore spies and mocks, stubbed globals and stubbed environment variables. vitest.setup.ts restores the rest.
        restoreMocks: true,
        unstubGlobals: true,
        unstubEnvs: true,
        globalSetup: ['./vitest.global-setup.mts'],
        setupFiles: ['./vitest.setup.ts']
    }
});
