// Catenary additions to the esbuild build of a Theia app (app/ for the browser, electron-app/ for Electron). Each app's esbuild.mjs
// calls them.
import { copyFileSync, mkdirSync, readdirSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';

/** WASM files that the backend loads from the directory of its bundle: oxigraph (the quad store), web-tree-sitter and the Turtle grammar (rdf-files text-patch.ts). */
export function copyBackendWasm(appDir, outdir) {
    const fromModeler = createRequire(createRequire(path.join(appDir, 'package.json')).resolve('catenary/package.json'));
    const fromRdf = createRequire(fromModeler.resolve('@catenary/rdf/package.json'));
    const fromFiles = createRequire(fromRdf.resolve('rdf-files/package.json'));
    mkdirSync(outdir, { recursive: true });
    copyFileSync(path.join(path.dirname(fromFiles.resolve('oxigraph')), 'node_bg.wasm'), path.join(outdir, 'node_bg.wasm'));
    const fromTreeSitter = createRequire(fromFiles.resolve('web-tree-sitter'));
    copyFileSync(path.join(path.dirname(fromTreeSitter.resolve('web-tree-sitter')), 'tree-sitter.wasm'), path.join(outdir, 'tree-sitter.wasm'));
    copyFileSync(path.join(path.dirname(fromRdf.resolve('rdf-files/package.json')), 'grammars', 'turtle.wasm'), path.join(outdir, 'turtle.wasm'));
    // The built-in notations (ADR 0014): packages/rdf/src/notations.ts reads them from `notations/` next to the bundle.
    const notations = path.join(path.dirname(fromModeler.resolve('@catenary/rdf/package.json')), 'notations');
    mkdirSync(path.join(outdir, 'notations'), { recursive: true });
    for (const f of readdirSync(notations)) copyFileSync(path.join(notations, f), path.join(outdir, 'notations', f));
}

/** The worker thread of the SHACL validation: `validation-worker.js` next to the backend bundle (packages/rdf/src/validation-runner.ts). */
export function addValidationWorker(appDir, nodeOptions) {
    const fromModeler = createRequire(createRequire(path.join(appDir, 'package.json')).resolve('catenary/package.json'));
    const rdfDir = path.dirname(fromModeler.resolve('@catenary/rdf/package.json'));
    nodeOptions.entryPoints['validation-worker'] = path.join(rdfDir, 'lib', 'validation-worker.js');
}

// @ulb-darmstadt/shacl-form exports only an "import" entry. The modeler is compiled to CommonJS,
// so its require() of that package fails to resolve. Resolve it as an import instead.
export const esmOnlyPackages = {
    name: 'esm-only-packages',
    setup(build) {
        build.onResolve({ filter: /^@ulb-darmstadt\/shacl-form$/ }, args => args.kind === 'require-call'
            ? build.resolve(args.path, { kind: 'import-statement', resolveDir: args.resolveDir, importer: args.importer })
            : undefined);
    }
};
