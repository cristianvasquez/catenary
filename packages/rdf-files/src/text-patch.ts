// Text patches of Turtle files. `patchTurtle` gets the text of a file and its triples before and after an edit, and
// changes only the text of what changed: comments, layout, prefixes and all other statements stay byte for byte.
// Parser: tree-sitter-turtle (grammars/turtle.wasm, scripts/build-turtle-grammar.sh): it keeps comments and byte positions.
//
// Catenary has no blank nodes (AGENTS.md): a text with a blank node (`[ … ]`, `( … )`, `_:b`) is not patched; the caller writes the
// whole file, with IRIs. The unit of change is a triple `iri p o`: the object only (with its `,` or `;`).
// A subject in more than one block: a removal applies where the triple is; an addition goes to the first block. New subjects: new
// blocks at the end. What the patcher cannot address gives a reason and no text (the caller writes the whole file).
// Only the statements of the subjects that change are read (the caller checks the result by a read of the new text). The syntax tree
// of the last patched text of each file is kept: the next patch of that text parses only the changed parts (tree-sitter incremental parse).

import type { Quad, Term } from '@rdfjs/types';
import { existsSync } from 'fs';
import * as path from 'path';
import { Edit, Language, Node, Parser, Point, Tree } from 'web-tree-sitter';
import { fileIri } from './paths';

export type PatchResult = { ok: true; text: string } | { ok: false; reason: string };

let parser: Promise<Parser> | undefined;
/**
 * The parser. The WASM files are next to this script in a bundle (the bundler of the application copies them there), else in the package:
 * `grammars/turtle.wasm`, and `tree-sitter.wasm` of web-tree-sitter.
 */
function turtleParser(): Promise<Parser> {
    return parser ??= (async () => {
        const here = (name: string) => path.join(__dirname, name);
        const bundled = existsSync(here('tree-sitter.wasm'));
        await Parser.init(bundled ? { locateFile: (name: string) => here(name) } : undefined);
        const p = new Parser();
        p.setLanguage(await Language.load(existsSync(here('turtle.wasm')) ? here('turtle.wasm') : path.join(__dirname, '..', 'grammars', 'turtle.wasm')));
        return p;
    })();
}

/**
 * Turtle or TriG text with the RDF 1.2 annotation syntax `s p o {| … |}` (not in a comment or a string). The reader (n3 2.7.12) can
 * lose statements of such a file: the statements after an annotation that `;` or `,` follows (rdfjs/N3.js #677), and in TriG the
 * graph of the `rdf:reifies` statement (#673).
 */
export async function hasAnnotation(text: string): Promise<boolean> {
    if (!text.includes('{|')) return false;
    return (await turtleParser()).parse(text)!.rootNode.descendantsOfType('annotation').length > 0;
}

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', XSD = 'http://www.w3.org/2001/XMLSchema#';
const TYPE = `<${RDF}type>`;
/** A local name that a prefixed name can have without escapes. */
const LOCAL = /^([A-Za-z0-9_]([A-Za-z0-9_.-]*[A-Za-z0-9_-])?)?$/;
const kids = (n: Node): Node[] => n.namedChildren.filter((c): c is Node => c !== null);

/** Key of a term: `<iri>`, `_:label`, `"value"@lang--dir`, `"value"^^<datatype>`, `<<( s p o )>>` (RDF 1.2 triple term). */
const termKey = (t: Term): string =>
    t.termType === 'NamedNode' ? `<${t.value}>`
    : t.termType === 'BlankNode' ? `_:${t.value}`
    : t.termType === 'Literal' ? `"${t.value}"` + (t.language ? `@${t.language.toLowerCase()}${t.direction ? `--${t.direction}` : ''}` : `^^<${t.datatype.value}>`)
    : t.termType === 'Quad' ? `<<( ${termKey(t.subject)} ${termKey(t.predicate)} ${termKey(t.object)} )>>`
    : `?${t.value}`;

function unescapeString(s: string): string {
    return s.replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|(.))/g, (_, u, U, c) =>
        u || U ? String.fromCodePoint(parseInt(u ?? U, 16)) : ({ t: '\t', b: '\b', n: '\n', r: '\r', f: '\f' } as Record<string, string>)[c] ?? c);
}

/** Terms of one file: prefixes and base change in document order. */
class Resolver {
    prefixes = new Map<string, string>();
    /** Compact form of an IRI that the prefixes of the file do not compact (the prefix table of the caller). */
    fallback?: (iri: string) => string | undefined;
    constructor(public base: string) {}

    directive(n: Node) {
        const d = kids(n)[0]!;
        if (d.type === 'version' || d.type === 'sparql_version') return;
        const iri = kids(d).find(c => c.type === 'iri_reference')!;
        if (d.type === 'prefix_id' || d.type === 'sparql_prefix') {
            const ns = kids(d).find(c => c.type === 'namespace')!;
            this.prefixes.set(ns.text.slice(0, -1), this.iri(iri));
        } else this.base = this.iri(iri);
    }
    iri(n: Node): string {
        return new URL(unescapeString(n.text.slice(1, -1)), this.base).href;
    }
    /** Key of a subject or object node; undefined for a blank node or a list (not addressable in the text). */
    key(n: Node): string | undefined {
        switch (n.type) {
            case 'subject': return this.key(kids(n)[0]!);
            case 'triple_term': {
                // A blank node inside a triple term is not addressable: the triple term is not either.
                const [s, p, o] = ['subject', 'predicate', 'object'].map(f => n.childForFieldName(f));
                const ks = s && this.key(s), ko = o && this.key(o), kp = p && this.predicate(p);
                return ks && kp && ko ? `<<( ${ks} ${kp} ${ko} )>>` : undefined;
            }
            case 'iri_reference': return `<${this.iri(n)}>`;
            case 'prefixed_name': {
                const ns = kids(n).find(c => c.type === 'namespace')!.text.slice(0, -1);
                const local = kids(n).find(c => c.type === 'pn_local')?.text ?? '';
                const iri = this.prefixes.get(ns);
                if (iri === undefined) throw new Error(`undeclared prefix "${ns}:" at line ${n.startPosition.row + 1}`);
                return `<${iri}${local.replace(/\\(.)/g, '$1')}>`;
            }
            case 'integer': return `"${n.text}"^^<${XSD}integer>`;
            case 'decimal': return `"${n.text}"^^<${XSD}decimal>`;
            case 'double': return `"${n.text}"^^<${XSD}double>`;
            case 'boolean_literal': return `"${n.text}"^^<${XSD}boolean>`;
            case 'rdf_literal': {
                const s = kids(n).find(c => c.type === 'string')!.text;
                const q = /^("""|'''|"|')/.exec(s)![1];
                const value = `"${unescapeString(s.slice(q.length, -q.length))}"`;
                const lang = kids(n).find(c => c.type === 'lang_tag');
                if (lang) return `${value}@${lang.text.slice(1).toLowerCase()}`;
                const dt = kids(n).find(c => c.type === 'iri_reference' || c.type === 'prefixed_name');
                return `${value}^^${dt ? this.key(dt) : `<${XSD}string>`}`;
            }
            default: return undefined;
        }
    }
    predicate(n: Node): string {
        const c = kids(n)[0];
        return c ? this.key(c)! : TYPE; // `a`
    }
    /** Text of a term, compact with the prefixes of the file. */
    write(t: Term, asPredicate = false): string {
        if (t.termType === 'NamedNode') {
            if (asPredicate && `<${t.value}>` === TYPE) return 'a';
            for (const [p, ns] of this.prefixes) if (t.value.startsWith(ns) && LOCAL.test(t.value.slice(ns.length))) return `${p}:${t.value.slice(ns.length)}`;
            const compact = this.fallback?.(t.value);
            if (compact) return compact;
            return `<${t.value.replace(/[\u0000- <>"{}|^`\\]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}>`;
        }
        if (t.termType === 'Quad') return `<<( ${this.write(t.subject)} ${this.write(t.predicate, true)} ${this.write(t.object)} )>>`;
        if (t.termType !== 'Literal') throw new Error(`${t.termType} not supported`);
        const dt = t.datatype.value;
        if (!t.language && dt === XSD + 'integer' && /^[+-]?\d+$/.test(t.value)) return t.value;
        if (!t.language && dt === XSD + 'boolean' && /^(true|false)$/.test(t.value)) return t.value;
        const s = `"${t.value.replace(/[\\"\n\r]/g, c => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r' })[c]!)}"`;
        if (t.language) return `${s}@${t.language}${t.direction ? `--${t.direction}` : ''}`;
        return dt === XSD + 'string' ? s : `${s}^^${this.write(t.datatype)}`;
    }
}

/** The syntax tree of the last text of each file that `patchTurtle` parsed or wrote. */
const trees = new Map<string, { text: string; tree: Tree }>();

/** The syntax tree of `text`: the kept tree of `file` when it is the tree of this text, else a new parse. */
async function treeOf(file: string, text: string): Promise<Tree> {
    const kept = trees.get(file);
    if (kept?.text === text) return kept.tree;
    const tree = (await turtleParser()).parse(text)!;
    kept?.tree.delete();
    trees.set(file, { text, tree });
    return tree;
}

/** Forget the kept syntax trees (tests). */
export function forgetTurtleTrees(): void {
    for (const { tree } of trees.values()) tree.delete();
    trees.clear();
}

/** Row and column (UTF-16 code units, as the indexes of the nodes) of an index of `text`. */
function pointAt(text: string, index: number): Point {
    const line = text.lastIndexOf('\n', index - 1);
    let row = 0;
    for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) row++;
    return { row, column: index - line - 1 };
}

/** The point after `inserted`, when it starts at `start`. */
function pointAfter(start: Point, inserted: string): Point {
    const lines = inserted.split('\n');
    return lines.length === 1 ? { row: start.row, column: start.column + inserted.length } : { row: start.row + lines.length - 1, column: lines[lines.length - 1].length };
}

/**
 * Keep the syntax tree of `out`: the tree of `text` with `edits` (applied in this order, from the end of the text) and an incremental
 * parse of the changed parts.
 */
async function keepTree(file: string, text: string, tree: Tree, edits: readonly (readonly [number, number, string, number])[], out: string): Promise<void> {
    const edited = tree.copy();
    for (const [start, end, insert] of edits) {
        const startPosition = pointAt(text, start);
        edited.edit({
            startIndex: start, oldEndIndex: end, newEndIndex: start + insert.length,
            startPosition, oldEndPosition: pointAt(text, end), newEndPosition: pointAfter(startPosition, insert)
        } satisfies Edit);
    }
    const next = (await turtleParser()).parse(out, edited)!;
    edited.delete();
    if (trees.get(file)?.tree === tree) tree.delete();
    trees.set(file, { text: out, tree: next });
}

/** Triples indexed by subject key. */
class Triples {
    readonly out = new Map<string, Quad[]>();
    readonly keys = new Set<string>();
    constructor(quads: Quad[]) {
        for (const q of quads) {
            const s = termKey(q.subject), k = `${s} ${termKey(q.predicate)} ${termKey(q.object)}`;
            if (this.keys.has(k)) continue;
            this.keys.add(k);
            (this.out.get(s) ?? this.out.set(s, []).get(s)!).push(q);
        }
    }
    props(k: string) { return this.out.get(k) ?? []; }
}

/** A top-level statement of the text. */
interface Statement {
    node: Node;
    /** Key of the IRI subject. */
    subject: string;
    properties: { node: Node; p: string; objects: { node: Node; o?: string }[] }[];
}

/**
 * Change `text` (Turtle; `file` gives the base IRI) from the triples `before` to the triples `after` (default graph). `before` must
 * be the read of `text`. `prefixes` (prefix → namespace): for new terms that the prefixes of the file do not compact; the file gets their directives.
 */
export async function patchTurtle(text: string, file: string, before: Quad[], after: Quad[], prefixes: Readonly<Record<string, string>> = {}): Promise<PatchResult> {
    if ([...before, ...after].some(q => q.graph.termType !== 'DefaultGraph')) return { ok: false, reason: 'a named graph in a Turtle file' };
    const old = new Triples(before), next = new Triples(after);
    const removed = [...old.keys].filter(k => !next.keys.has(k)), added = [...next.keys].filter(k => !old.keys.has(k));
    if (!removed.length && !added.length) return { ok: true, text };
    const quadKey = (q: Quad) => `${termKey(q.subject)} ${termKey(q.predicate)} ${termKey(q.object)}`;
    const quadOf = new Map([...before, ...after].map(q => [quadKey(q), q]));
    /** The subjects whose statements change: only their blocks are read. */
    const changing = new Set([...removed, ...added].map(k => termKey(quadOf.get(k)!.subject)));
    const tree = await treeOf(file, text);
    if (tree.rootNode.hasError) return { ok: false, reason: 'syntax error in the file' };
    const r = new Resolver(fileIri(file));
    const statements: Statement[] = [];
    const scopes: { end: number; resolver: Resolver }[] = [{ end: 0, resolver: new Resolver(r.base) }];
    const at = (offset: number): Resolver => scopes.filter(s => s.end <= offset).slice(-1)[0].resolver;
    try {
        for (const n of kids(tree.rootNode)) {
            if (n.type === 'comment') continue;
            if (n.type === 'directive') {
                r.directive(n);
                const resolver = new Resolver(r.base);
                resolver.prefixes = new Map(r.prefixes);
                scopes.push({ end: n.endIndex, resolver });
                continue;
            }
            if (n.type !== 'triple') return { ok: false, reason: `${n.type} at line ${n.startPosition.row + 1}: only Turtle is supported` };
            const first = kids(n)[0]!;
            if (first.type === 'reified_triple') return { ok: false, reason: `reified triple at line ${n.startPosition.row + 1}: not supported by the text patch` };
            const subject = first.type === 'subject' ? r.key(first) : undefined;
            if (!subject || subject.startsWith('_:')) return { ok: false, reason: `blank node at line ${n.startPosition.row + 1}` };
            if (!changing.has(subject)) continue;
            const st: Statement = { node: n, subject, properties: [] };
            const lists = kids(n).slice(1).filter(c => c.type === 'property_list');
            for (const list of lists) {
                for (const property of kids(list).filter(c => c.type === 'property')) {
                    const list = kids(kids(property)[1]!).filter(c => c.type !== 'comment');
                    // A reifier or an annotation follows its object: that object is not a simple object of the text (no key).
                    const objects = list.filter(c => c.type !== 'reifier' && c.type !== 'annotation').map(o => {
                        if (o.type === 'blank_node_property_list' || o.type === 'collection' || r.key(o)?.startsWith('_:')) throw new Error(`blank node at line ${o.startPosition.row + 1}`);
                        const after = list[list.indexOf(o) + 1];
                        return { node: o, o: after && (after.type === 'reifier' || after.type === 'annotation') ? undefined : r.key(o) };
                    });
                    st.properties.push({ node: property, p: r.predicate(kids(property)[0]!), objects });
                }
            }
            statements.push(st);
        }
    } catch (e) {
        return { ok: false, reason: (e as Error).message };
    }
    // `prefixes` of the caller: for an IRI that the prefixes of the file do not compact, a prefix whose name the file does not declare
    // (the longest namespace). Its directive goes after the last directive before the first statement (else before that statement).
    const declared = new Set(r.prefixes.keys()), needed = new Map<string, string>();
    const fallback = (iri: string) => {
        const [p, ns] = Object.entries(prefixes).filter(([p, ns]) => !declared.has(p) && iri.startsWith(ns) && LOCAL.test(iri.slice(ns.length)))
            .sort(([, a], [, b]) => b.length - a.length)[0] ?? [];
        if (p === undefined || ns === undefined) return undefined;
        needed.set(p, ns);
        return `${p}:${iri.slice(ns.length)}`;
    };
    for (const s of scopes) s.resolver.fallback = fallback;

    const terms = new Map<string, Term>();
    for (const q of [...after, ...before]) for (const t of [q.subject, q.predicate, q.object]) if (!terms.has(termKey(t))) terms.set(termKey(t), t);

    const simple = [...removed.map(key => ({ key, op: 'remove' as const })), ...added.map(key => ({ key, op: 'add' as const }))];

    // ------------------------------------------------------------ text generation

    const unit = /\n([ \t]+)\S/.exec(text)?.[1] ?? '    ';
    // The punctuation of the file: `p o ;` or `p o;`, `s p o .` or `s p o.` (the one it has most).
    const count = (re: RegExp) => (text.match(re) ?? []).length;
    const semi = count(/\S;[ \t]*(#.*)?\n/g) > count(/\s;[ \t]*(#.*)?\n/g) ? ';' : ' ;';
    const dot = count(/[^\s.]\.[ \t]*(#.*)?\n/g) > count(/\s\.[ \t]*(#.*)?\n/g) ? '.' : ' .';
    const termOf = (k: string): Term => {
        const t = terms.get(k);
        if (!t) throw new Error(`unknown term ${k}`);
        return t;
    };
    const object = (k: string, offset: number): string => at(offset).write(termOf(k));
    /** `p o1, o2` for each predicate of subject `k`: rdf:type first, then in the order of the triples. */
    const propertyTexts = (k: string, g: Triples, offset: number): string[] => {
        const byP = new Map<string, Quad[]>();
        for (const q of g.props(k)) (byP.get(termKey(q.predicate)) ?? byP.set(termKey(q.predicate), []).get(termKey(q.predicate))!).push(q);
        const order = [...byP.keys()].sort((a, b) => Number(b === TYPE) - Number(a === TYPE));
        return order.map(p => `${at(offset).write(byP.get(p)![0].predicate, true)} ${byP.get(p)!.map(q => object(termKey(q.object), offset)).join(', ')}`);
    };

    // ------------------------------------------------------------ edits on the old text: [start, end, insert]

    const edits: [number, number, string][] = [];
    const cut = (items: Node[], gone: Set<Node>) => {
        for (let i = 0; i < items.length; i++) {
            if (!gone.has(items[i])) continue;
            let j = i;
            while (j + 1 < items.length && gone.has(items[j + 1])) j++;
            if (j + 1 < items.length) edits.push([items[i].startIndex, items[j + 1].startIndex, '']);
            else if (i > 0) edits.push([items[i - 1].endIndex, items[j].endIndex, '']);
            i = j;
        }
    };
    const removeStatement = (st: Statement) =>
        edits.push([st.node.startIndex, text.startsWith('\n', st.node.endIndex) ? st.node.endIndex + 1 : st.node.endIndex, '']);
    const indentOf = (st: Statement) => /\n([ \t]+)\S/.exec(text.slice(st.node.startIndex, st.node.endIndex))?.[1] ?? unit;
    let tail = '';

    // Subjects: objects (removed, added, replaced), new properties.
    const simpleBy = new Map<string, { remove: Set<string>; add: Quad[] }>();
    for (const { key, op } of simple) {
        const q = quadOf.get(key)!, s = termKey(q.subject);
        const e = simpleBy.get(s) ?? simpleBy.set(s, { remove: new Set(), add: [] }).get(s)!;
        if (op === 'remove') e.remove.add(key); else e.add.push(q);
    }
    for (const [s, e] of simpleBy) {
        const own = statements.filter(st => st.subject === s);
        if (!own.length) {
            // No block in the text: a new subject. Its triples were nowhere in the text, else it has a block.
            if (old.props(s).length) return { ok: false, reason: `subject without a block in the text: ${s}` };
            const all = propertyTexts(s, next, text.length);
            if (all.length) tail += `\n${at(text.length).write(termOf(s))} ${all.join(`${semi}\n${unit}`)}${dot}\n`;
            continue;
        }
        // Text objects: removed, or replaced by an added object of the same predicate.
        const goneObject = new Set<Node>(), replace = new Map<Node, string>(), adds: { p: string; text: (offset: number) => string; predicate: Term }[] = [];
        for (const st of own) for (const pr of st.properties) for (const o of pr.objects) if (o.o && e.remove.has(`${s} ${pr.p} ${o.o}`)) goneObject.add(o.node);
        const missing = [...e.remove].filter(k => ![...goneObject].some(n => own.some(st => st.properties.some(pr => pr.objects.some(o => o.node === n && `${s} ${pr.p} ${o.o}` === k)))));
        if (missing.length) return { ok: false, reason: `not in the text as a simple triple: ${missing[0]}` };
        for (const q of e.add) adds.push({ p: termKey(q.predicate), text: offset => object(termKey(q.object), offset), predicate: q.predicate });
        // A removed object and an added object of the same predicate: the new text takes the place of the old one.
        const used = new Set<number>();
        for (const st of own) for (const pr of st.properties) for (const o of pr.objects) {
            if (!goneObject.has(o.node)) continue;
            const i = adds.findIndex((a, j) => !used.has(j) && a.p === pr.p);
            if (i < 0) continue;
            used.add(i);
            goneObject.delete(o.node);
            replace.set(o.node, adds[i].text(o.node.startIndex));
        }

        const goneProps = new Map<Statement, Set<Node>>(), keptObjects = new Map<Node, Node[]>();
        for (const st of own) {
            const gone = new Set<Node>();
            for (const pr of st.properties) {
                const goneHere = pr.objects.filter(o => goneObject.has(o.node));
                if (goneHere.length === pr.objects.length) { gone.add(pr.node); continue; }
                cut(pr.objects.map(o => o.node), new Set(goneHere.map(o => o.node)));
                keptObjects.set(pr.node, pr.objects.filter(o => !goneObject.has(o.node)).map(o => o.node));
            }
            goneProps.set(st, gone);
        }
        for (const [node, txt] of replace) edits.push([node.startIndex, node.endIndex, txt]);
        // Additions: after the last kept object of the same predicate (first block that has one), else new properties.
        const newProps: ((offset: number) => string)[] = [];
        const byP = new Map<string, typeof adds>();
        for (const [j, a] of adds.entries()) if (!used.has(j)) (byP.get(a.p) ?? byP.set(a.p, []).get(a.p)!).push(a);
        for (const [p, list] of [...byP].sort(([a], [b]) => Number(b === TYPE) - Number(a === TYPE))) {
            const pr = own.flatMap(st => st.properties).find(x => x.p === p && keptObjects.has(x.node));
            if (pr) {
                const last = keptObjects.get(pr.node)!.slice(-1)[0];
                edits.push([last.endIndex, last.endIndex, list.map(a => `, ${a.text(last.endIndex)}`).join('')]);
            } else newProps.push(offset => `${at(offset).write(list[0].predicate, true)} ${list.map(a => a.text(offset)).join(', ')}`);
        }
        own.forEach((st, i) => {
            const gone = goneProps.get(st)!;
            const left = st.properties.filter(pr => !gone.has(pr.node));
            const extra = i === 0 ? newProps : [];
            const ind = indentOf(st);
            if (!left.length && !extra.length) { removeStatement(st); return; }
            if (!left.length) {
                edits.push([st.properties[0].node.startIndex, st.properties[st.properties.length - 1].node.endIndex, extra.map(x => x(st.properties[0].node.startIndex)).join(`${semi}\n${ind}`)]);
                return;
            }
            cut(st.properties.map(pr => pr.node), gone);
            if (extra.length) {
                const at = left[left.length - 1].node.endIndex;
                edits.push([at, at, extra.map(x => `${semi}\n${ind}${x(at)}`).join('')]);
            }
        });
    }
    if (tail) edits.push([text.length, text.length, (text.endsWith('\n') || !text ? '' : '\n') + tail]);
    if (needed.size) {
        const top = kids(tree.rootNode).filter(n => n.type !== 'comment');
        const first = top.findIndex(n => n.type !== 'directive');
        const directives = (first < 0 ? top : top.slice(0, first)).filter(n => n.type === 'directive' && /^(@prefix|prefix)\b/i.test(n.text));
        const last = directives[directives.length - 1];
        // The form of the last prefix directive of the file: `PREFIX p: <ns>`, `@prefix p: <ns> .` or `@prefix p: <ns>.`.
        const line = !last ? (p: string, ns: string) => `@prefix ${p}: <${ns}>${dot}`
            : /^prefix/i.test(last.text) ? (p: string, ns: string) => `PREFIX ${p}: <${ns}>`
            : (p: string, ns: string) => `@prefix ${p}: <${ns}>${/\s\.$/.test(last.text) ? ' .' : '.'}`;
        const lines = [...needed].sort(([a], [b]) => a.localeCompare(b)).map(([p, ns]) => line(p, ns)).join('\n');
        const pos = last?.endIndex ?? (first < 0 ? text.length : top[first].startIndex);
        // Before the other edits at the same position (a new block at the end of an empty file).
        edits.unshift([pos, pos, last ? `\n${lines}` : `${lines}\n${pos < text.length ? '\n' : ''}`]);
    }

    // Apply from the end. At one position: a removal first (its text is after the position), then the inserts in reverse order,
    // so that they are in the text in the order they were made. Overlapping ranges: a defect of the units, no text.
    const order = edits.map((e, i) => [...e, i] as const).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[3] - a[3]);
    for (let i = 1; i < order.length; i++) {
        if (order[i][1] > order[i - 1][0]) return { ok: false, reason: 'overlapping changes' };
    }
    let out = text;
    for (const [s, e, ins] of order) out = out.slice(0, s) + ins + out.slice(e);
    await keepTree(file, text, tree, order, out);
    return { ok: true, text: out };
}
