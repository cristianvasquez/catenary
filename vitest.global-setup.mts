// Once before the tests of a run: bundle the SHACL validation worker (packages/rdf/src/validation-worker.ts) from current source into a
// new temporary directory. validation-runner.test.ts runs a real worker thread from it (inject('validationWorker')). No test reads
// packages/rdf/lib, so a clean checkout or a stale build gives the same result. The directory is removed after the run.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { TestProject } from 'vitest/node';
import { sourceAliases } from './vitest.aliases.mts';

export default async function setup(project: TestProject): Promise<() => void> {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-validation-worker-'));
    const outfile = join(dir, 'validation-worker.js');
    await build({
        entryPoints: [fileURLToPath(new URL('./packages/rdf/src/validation-worker.ts', import.meta.url))],
        outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', alias: sourceAliases, logLevel: 'warning'
    });
    // Oxigraph loads its WASM file from the directory of the bundle, as in the backend build (scripts/esbuild-catenary.mjs copyBackendWasm).
    const fromFiles = createRequire(fileURLToPath(new URL('./packages/rdf-files/package.json', import.meta.url)));
    copyFileSync(join(dirname(fromFiles.resolve('oxigraph')), 'node_bg.wasm'), join(dir, 'node_bg.wasm'));
    project.provide('validationWorker', outfile);
    return () => rmSync(dir, { recursive: true, force: true });
}
