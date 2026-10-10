// Checks the package boundaries (see readme.md, "Packages"). The workspace hoists node_modules (Theia needs it),
// so pnpm does not stop a package from importing what it does not declare. This script does:
//  1. A package imports only its own files, Node built-ins, and packages declared in its package.json.
//  2. rdf-files imports no Catenary package: other projects use it.
//  3. The browser side and the shared side of the Theia extension do not import @catenary/rdf.
// Exit code 1 on a violation.
import { readFileSync, readdirSync, statSync } from 'fs';
import { builtinModules } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['packages/query', 'packages/schema', 'packages/explorer', 'packages/shacl', 'packages/rdfs', 'packages/model', 'packages/rdf-serialization', 'packages/rdf-files', 'packages/rdf', 'modeler'];
const forbidden = [
    { dir: 'packages/shacl/src/common', module: '@catenary/shacl/backend', why: 'shared SHACL rules must not load the backend' },
    { dir: 'modeler/src/browser', module: '@catenary/shacl/backend', why: 'the browser reads SHACL through RPC' },
    { dir: 'modeler/src/common', module: '@catenary/shacl/backend', why: 'shared adapters must not load the backend' },
    { dir: 'packages/model/src', module: '@catenary/shacl/backend', why: 'model runs in the browser' },
    { dir: 'packages/rdfs/src', module: '@catenary/model', why: 'a plugin gets the store through the explorer port' },
    { dir: 'packages/shacl/src', module: '@catenary/model', why: 'a plugin gets the store through the explorer port' },
    { dir: 'packages/rdf-files/src', module: '@catenary/model', why: 'rdf-files is generic: other projects use it' },
    { dir: 'packages/rdf-files/src', module: '@catenary/rdf', why: 'rdf-files is generic: other projects use it' },
    { dir: 'modeler/src/browser', module: '@catenary/rdf', why: 'the browser gets JSON from @catenary/model, never RDF' },
    { dir: 'modeler/src/common', module: '@catenary/rdf', why: 'code shared with the browser must not load RDF' }
];

const files = dir => readdirSync(dir).flatMap(f => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(?:[cm]?js|tsx?)$/.test(f) && !f.endsWith('.d.ts') ? [p] : [];
});
const specifiers = file => [...readFileSync(file, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'|(?:^|\n)\s*import\s+'([^']+)'|require\('([^']+)'\)/g)]
    .map(m => m[1] ?? m[2] ?? m[3]);
const packageName = s => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);

const errors = [];
for (const pkg of packages) {
    const manifest = JSON.parse(readFileSync(path.join(root, pkg, 'package.json'), 'utf8'));
    const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies }));
    const dir = path.join(root, pkg);
    for (const file of files(path.join(dir, 'src'))) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        for (const s of specifiers(file)) {
            if (s.startsWith('.')) {
                if (path.relative(dir, path.resolve(path.dirname(file), s)).startsWith('..')) errors.push(`${rel}: '${s}' leaves the package`);
            } else if (!builtinModules.includes(s.replace(/^node:/, '').split('/')[0]) && !declared.has(packageName(s))) {
                errors.push(`${rel}: '${s}' is not declared in ${pkg}/package.json`);
            }
            for (const f of forbidden) {
                if (rel.startsWith(f.dir + '/') && (f.module.startsWith('@catenary/shacl/') ? s === f.module : packageName(s) === f.module)) errors.push(`${rel}: imports ${f.module} (${f.why})`);
            }
        }
    }
}
if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
}
console.log(`boundaries ok: ${packages.join(', ')}`);
