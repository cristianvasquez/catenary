// Pages of the vocabularies on the site. Reads each www/public/vocab/<name>.ttl with rdf-files and writes www/vocab/<name>.md:
// the title, the namespace, a link to the Turtle, then one `##` per term. The anchor of a term is its local name, so the term IRI
// `<namespace><local>` resolves to its heading on the published page. Needs `pnpm -C packages/rdf-files build`.
// Usage: pnpm www:vocab
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(root, 'packages/rdf-files/lib/index.js');
if (!fs.existsSync(lib)) throw new Error('Run pnpm -C packages/rdf-files build before pnpm www:vocab.');
const { parseRdf } = createRequire(import.meta.url)(lib);

const src = path.join(root, 'www/public/vocab');
const out = path.join(root, 'www/vocab');

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const DCT = 'http://purl.org/dc/terms/';
const VANN = 'http://purl.org/vocab/vann/';
const WELL_KNOWN = { rdf: RDF, rdfs: RDFS, owl: OWL, xsd: 'http://www.w3.org/2001/XMLSchema#', sh: 'http://www.w3.org/ns/shacl#', dct: DCT };

/** Text for a Markdown line: no HTML, no autolinks, no emphasis, no Vue interpolation. Line breaks become spaces. */
const text = s => s.replace(/\s*\n\s*/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[*_[\]`\\]/g, c => '\\' + c).replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');

function page(name, quads) {
    const objects = (s, p) => quads.filter(q => q.subject.value === s && q.predicate.value === p).map(q => q.object);
    const one = (s, p) => objects(s, p)[0]?.value;
    const ontology = quads.find(q => q.predicate.value === RDF + 'type' && q.object.value === OWL + 'Ontology')?.subject.value;
    if (!ontology) throw new Error(`${name}.ttl: no owl:Ontology`);
    const ns = one(ontology, VANN + 'preferredNamespaceUri');
    const prefix = one(ontology, VANN + 'preferredNamespacePrefix');
    const title = one(ontology, DCT + 'title');
    if (!ns || !prefix || !title) throw new Error(`${name}.ttl: the ontology needs dct:title, vann:preferredNamespaceUri and vann:preferredNamespacePrefix`);
    const prefixes = { ...WELL_KNOWN, [prefix]: ns };

    // A term: a typed subject in the namespace.
    const terms = [...new Set(quads.filter(q => q.predicate.value === RDF + 'type' && q.subject.value.startsWith(ns)).map(q => q.subject.value))];
    const isA = (t, c) => objects(t, RDF + 'type').some(o => o.value === c);
    const rank = t => isA(t, RDFS + 'Class') ? 0 : isA(t, RDF + 'Property') ? 1 : 2;
    terms.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

    /** An IRI as a link to its heading (a term of this page), or as a prefixed name. */
    const ref = iri => {
        if (terms.includes(iri)) return `[${prefix}:${iri.slice(ns.length)}](#${iri.slice(ns.length)})`;
        const [p, n] = Object.entries(prefixes).find(([, v]) => iri.startsWith(v)) ?? [];
        return p ? `\`${p}:${iri.slice(n.length)}\`` : `\`<${iri}>\``;
    };
    const refs = (t, p) => objects(t, p).map(o => ref(o.value)).join(', ');

    const lines = [
        `# ${text(title)}`, '',
        ...(one(ontology, DCT + 'description') ? [text(one(ontology, DCT + 'description')), ''] : []),
        `Namespace: \`${ns}\` (prefix \`${prefix}:\`)`, '',
        `Turtle: [${name}.ttl](./${name}.ttl){target="_self"}`, '',
        `This page is generated from the Turtle file by \`pnpm www:vocab\`. Do not edit it.`, ''
    ];
    for (const t of terms) {
        const local = t.slice(ns.length);
        lines.push(`## ${prefix}:${text(local)} {#${local}}`, '');
        const rows = [
            ['Type', refs(t, RDF + 'type')],
            ['Label', one(t, RDFS + 'label') && text(one(t, RDFS + 'label'))],
            ['Subclass of', refs(t, RDFS + 'subClassOf')],
            ['Domain', refs(t, RDFS + 'domain')],
            ['Range', refs(t, RDFS + 'range')],
            ['Deprecated', one(t, OWL + 'deprecated') === 'true' && 'yes']
        ].filter(([, v]) => v);
        for (const [k, v] of rows) lines.push(`- ${k}: ${v}`);
        lines.push('');
        for (const c of objects(t, RDFS + 'comment')) lines.push(text(c.value), '');
    }
    return { md: lines.join('\n').replace(/\n+$/, '\n'), count: terms.length };
}

fs.mkdirSync(out, { recursive: true });
for (const file of fs.readdirSync(src).filter(f => f.endsWith('.ttl')).sort()) {
    const name = path.basename(file, '.ttl');
    const target = path.join(src, file);
    const quads = await parseRdf(fs.readFileSync(target, 'utf8'), target);
    const { md, count } = page(name, quads);
    fs.writeFileSync(path.join(out, `${name}.md`), md);
    console.log(`www/vocab/${name}.md: ${count} terms`);
}
