#!/usr/bin/env node
// Rewrite a folder from the legacy Catenary namespaces (osg://vocab/…) to the published ones. Text replacement: formatting and comments stay.
// Usage: node scripts/migrate-vocab.mjs <folder> [--dry-run]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same map as LEGACY_NAMESPACES in packages/model/src/terms.ts (the test checks that they are equal).
const CATENARY_VOCAB = 'https://cristianvasquez.github.io/catenary/vocab/';
export const LEGACY_NAMESPACES = Object.fromEntries(
    ['view#', 'workspace#', 'notation#', 'notation/shapes#', 'notation/skos#', 'notation/classes#', 'notation/instances#', 'notation/marks#']
        .map(path => ['osg://vocab/' + path, CATENARY_VOCAB + path]));

// Same file set as listRdfFiles (packages/rdf-files/src/listing.ts): RDF extensions without .xml; no hidden names, node_modules or *.bak;
// a .json file only with @context (JSON-LD).
const EXTENSIONS = ['.ttl', '.turtle', '.trig', '.nt', '.nq', '.jsonld', '.json', '.n3', '.rdf', '.owl'];

function hasContext(file) {
    try {
        const has = v => Array.isArray(v) ? v.some(has) : v !== null && typeof v === 'object' && Object.hasOwn(v, '@context');
        return has(JSON.parse(readFileSync(file, 'utf8')));
    } catch { return false; }
}

function* rdfFiles(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue;
        const file = join(folder, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') yield* rdfFiles(file); }
        else if (entry.isFile() && !entry.name.endsWith('.bak') && EXTENSIONS.includes(extname(entry.name).toLowerCase())
            && (extname(entry.name).toLowerCase() !== '.json' || hasContext(file))) yield file;
    }
}

/** The text with each legacy namespace replaced by the published one. Longest first, so `notation#` does not take part of a longer one. */
export function migrateText(text) {
    let out = text;
    for (const old of Object.keys(LEGACY_NAMESPACES).sort((a, b) => b.length - a.length)) out = out.split(old).join(LEGACY_NAMESPACES[old]);
    return out;
}

/** Rewrite the files of the folder. Returns the changed files (relative paths) with the number of replacements. */
export function migrateFolder(folder, { dryRun = false } = {}) {
    const changed = [];
    for (const file of rdfFiles(folder)) {
        const text = readFileSync(file, 'utf8'), out = migrateText(text);
        if (out === text) continue;
        const count = Object.keys(LEGACY_NAMESPACES).reduce((n, old) => n + text.split(old).length - 1, 0);
        if (!dryRun) writeFileSync(file, out);
        changed.push({ file: relative(folder, file), count });
    }
    return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2), dryRun = args.includes('--dry-run'), folders = args.filter(a => a !== '--dry-run');
    if (folders.length !== 1) { console.error('Usage: node scripts/migrate-vocab.mjs <folder> [--dry-run]'); process.exit(2); }
    const changed = migrateFolder(folders[0], { dryRun });
    for (const c of changed) console.log(`${dryRun ? 'would change' : 'changed'} ${c.file} (${c.count} replacements)`);
    console.log(`${changed.length} file(s) ${dryRun ? 'to change' : 'changed'}`);
}
