#!/usr/bin/env node
// Parses the style sheets with the CSS parser of esbuild. A syntax error or a parser warning fails: webpack would drop the rule.
// Usage: node scripts/check-css.mjs [file.css ...]   (default: all CSS files in Git outside node_modules)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// esbuild is a dependency of rdf-serialization (its build), not of the root package.
const { transformSync } = createRequire(join(root, 'packages/rdf-serialization/package.json'))('esbuild');
const files = process.argv.length > 2
    ? process.argv.slice(2)
    : execFileSync('git', ['ls-files', '*.css'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

let failures = 0;
for (const file of files) {
    try {
        const { warnings } = transformSync(readFileSync(join(root, file), 'utf8'), { loader: 'css', sourcefile: file, logLevel: 'silent' });
        for (const w of warnings) {
            failures++;
            console.log(`${file}:${w.location?.line}:${w.location?.column}: ${w.text}`);
        }
    } catch (e) {
        for (const err of e.errors ?? [{ text: e.message }]) {
            failures++;
            console.log(`${file}:${err.location?.line ?? '?'}:${err.location?.column ?? '?'}: ${err.text}`);
        }
    }
}
console.log(failures ? `check-css: ${failures} problems` : `check-css: ${files.length} files parsed`);
process.exit(failures ? 1 : 0);
