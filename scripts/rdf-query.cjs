#!/usr/bin/env node
// Reads RDF files into an Oxigraph store and runs a SPARQL query. For tests and agents: check RDF files by their triples, not their
// text (AGENTS.md → Assertions). Turtle and N-Triples load into the default graph; TriG and N-Quads keep their named graphs. The
// default graph of the query is the union of all graphs.
// Usage:
//   node scripts/rdf-query.cjs <file>... --query '<SPARQL>'      SELECT: one JSON object per row (variable → value); ASK: true/false
//   node scripts/rdf-query.cjs <file>... --query-file q.rq
//   node scripts/rdf-query.cjs <file>...                         N-Quads of the files
// From code: const { rows, quads } = require('./rdf-query.cjs'); rows(files, query) → [{ var: value }], quads(files) → Quad[].
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
// Oxigraph is a dependency of rdf-files, not of the root package.
const ox = require('node:module').createRequire(path.join(__dirname, '../packages/rdf-files/package.json'))('oxigraph');

const FORMATS = { '.ttl': 'text/turtle', '.trig': 'application/trig', '.nt': 'application/n-triples', '.nq': 'application/n-quads' };

function store(files) {
    const s = new ox.Store();
    for (const file of [].concat(files)) {
        const format = FORMATS[path.extname(file).toLowerCase()];
        if (!format) throw new Error(`${file}: unknown RDF format (${Object.keys(FORMATS).join(', ')})`);
        s.load(fs.readFileSync(file, 'utf8'), { format, base_iri: pathToFileURL(path.resolve(file)).href });
    }
    return s;
}

/** The quads of the files. */
const quads = files => store(files).match();

/** The rows of a SELECT query (variable → term value), or the boolean of an ASK query. */
function rows(files, query) {
    const result = store(files).query(query, { use_default_graph_as_union: true });
    if (typeof result === 'boolean') return result;
    return [...result].map(binding => Object.fromEntries([...binding].map(([name, term]) => [name, term.value])));
}

module.exports = { quads, rows };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const at = name => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
    const queryFile = at('--query-file');
    const query = at('--query') ?? (queryFile && fs.readFileSync(queryFile, 'utf8'));
    if (!argv.length || argv.some(a => a.startsWith('--'))) {
        console.error('usage: node scripts/rdf-query.cjs <file>... [--query <SPARQL> | --query-file <file>]');
        process.exit(2);
    }
    try {
        if (!query) for (const q of quads(argv)) console.log(q.toString() + ' .');
        else {
            const r = rows(argv, query);
            if (typeof r === 'boolean') { console.log(r); process.exit(r ? 0 : 1); }
            for (const row of r) console.log(JSON.stringify(row));
        }
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}
