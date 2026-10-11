// The text patch of a TriG file with one graph block (a view file, manifest §2.3, §10.2 law_writeIsFaithful and law_graphPatchKeepsText).
// The Turtle cases are in packages/rdf/test/text-patch.test.ts.
import type { Quad } from '@rdfjs/types';
import { describe, expect, it } from 'vitest';
import { canonical, forgetTurtleTrees, parseRdf, patchTurtle, rdf } from '../src';

const EX = 'http://example.org/', XSD = 'http://www.w3.org/2001/XMLSchema#';
const FILE = '/tmp/x.view.trig';
const n = (l: string) => rdf.namedNode(l.includes(':') ? l : EX + l);
const int = (v: number) => rdf.literal(String(v), n(XSD + 'integer'));
const t = (s: string, p: string, o: string | Quad['object']) => rdf.quad(n(s), n(p), typeof o === 'string' ? n(o) : o);
const GRAPH = n('urn:name:view');
const triples = (quads: Quad[]) => quads.map(q => rdf.quad(q.subject, q.predicate, q.object));

/** Patch the graph block of `text` from its read to `edit(read)`; check that the new text reads as those quads, all in the graph. */
async function patch(text: string, edit: (quads: Quad[]) => Quad[], graph = GRAPH): Promise<string> {
    const before = await parseRdf(text, FILE);
    expect(before.every(q => q.graph.equals(graph))).toBe(true);
    const after = edit(before);
    const r = await patchTurtle(text, FILE, triples(before), triples(after), {}, graph);
    if (!r.ok) throw new Error(r.reason);
    const quads = await parseRdf(r.text, FILE);
    expect(quads.every(q => q.graph.equals(graph))).toBe(true);
    expect(canonical(quads)).toBe(canonical(after));
    return r.text;
}
const without = (...qs: Quad[]) => (quads: Quad[]) => quads.filter(q => !qs.some(x => x.equals(q)));
const plus = (...qs: Quad[]) => (quads: Quad[]) => [...quads, ...qs];
const g = (s: string, p: string, o: string | Quad['object']) => rdf.quad(n(s), n(p), typeof o === 'string' ? n(o) : o, GRAPH);

const VIEW = `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
@prefix view: <osg://vocab/view#>.
# a view, written by hand

<urn:name:view> {
  <urn:name:view> a view:View;
    rdfs:label "view".

  # the first card
  <urn:name:view/p/1> a view:Placement;
    view:element <http://example.org/a>;
    view:x 0;
    view:y 0.

  <urn:name:view/p/2> a view:Placement;
    view:element <http://example.org/b>;
    view:x 700;
    view:y 0.

}
`;
const V = 'osg://vocab/view#';

describe('text patch of a TriG graph block', () => {
    it('law_graphPatchKeepsText: a move changes the two numbers of one block; the other text stays byte for byte', async () => {
        const out = await patch(VIEW, q => [...without(g('urn:name:view/p/1', V + 'x', int(0)), g('urn:name:view/p/1', V + 'y', int(0)))(q),
            g('urn:name:view/p/1', V + 'x', int(10)), g('urn:name:view/p/1', V + 'y', int(20))]);
        expect(out).toBe(VIEW.replace('view:x 0;\n    view:y 0.', 'view:x 10;\n    view:y 20.'));
    });

    it('a subject added inside the graph block, with the indentation of the block; a subject removed with its block', async () => {
        const added = await patch(VIEW, plus(g('urn:name:view/p/3', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', V + 'Placement'), g('urn:name:view/p/3', V + 'x', int(5))));
        expect(added).toBe(VIEW.replace('    view:y 0.\n\n}', '    view:y 0.\n\n  <urn:name:view/p/3> a view:Placement;\n    view:x 5.\n\n}'));
        const removed = await patch(added, q => q.filter(x => x.subject.value !== 'urn:name:view/p/2'));
        expect(removed).toBe(added.replace('  <urn:name:view/p/2> a view:Placement;\n    view:element <http://example.org/b>;\n    view:x 700;\n    view:y 0.\n', ''));
        // The kept syntax tree: the same patch of the text parsed before gives the same text.
        forgetTurtleTrees();
        expect(await patch(added, q => q.filter(x => x.subject.value !== 'urn:name:view/p/2'))).toBe(removed);
    });

    it('an added subject in a block without a blank line before `}`, and in an empty block', async () => {
        const add = plus(g('s', 'p', int(1)));
        expect(await patch('<urn:name:view> {\n  <urn:a> <urn:p> 1 .\n}\n', add)).toBe('<urn:name:view> {\n  <urn:a> <urn:p> 1 .\n\n  <http://example.org/s> <http://example.org/p> 1 .\n}\n');
        expect(await patch('<urn:name:view> {\n}\n', add)).toBe('<urn:name:view> {\n<http://example.org/s> <http://example.org/p> 1 .\n}\n');
        expect(await patch('<urn:name:view> {}\n', add)).toBe('<urn:name:view> {\n<http://example.org/s> <http://example.org/p> 1 .\n}\n');
    });

    it('a prefix of the caller that the file does not declare goes to the top, not in the graph block', async () => {
        const before = triples(await parseRdf(VIEW, FILE));
        const r = await patchTurtle(VIEW, FILE, before, [...before, t('urn:name:view/p/1', V + 'element', 'c')], { ex: EX }, GRAPH);
        expect(r).toMatchObject({ ok: true });
        if (!r.ok) return;
        expect(r.text).toBe(VIEW.replace("@prefix view: <osg://vocab/view#>.", "@prefix view: <osg://vocab/view#>.\n@prefix ex: <http://example.org/>.")
            .replace('view:element <http://example.org/a>;', 'view:element <http://example.org/a>, ex:c;'));
    });

    it('refuses a second graph block, a statement outside the block, another graph name, and a block without a final `.`', async () => {
        const before = triples(await parseRdf(VIEW, FILE)), after = [...before, t('urn:name:view/p/1', V + 'x', int(1))];
        const refused = async (text: string, graph = GRAPH) => {
            const r = await patchTurtle(text, FILE, before, after, {}, graph);
            return r.ok ? 'ok' : r.reason;
        };
        expect(await refused(VIEW + '<urn:name:other> { <urn:x> <urn:p> 1 . }\n')).toMatch(/second graph block/);
        expect(await refused(VIEW + '<urn:x> <urn:p> 1 .\n')).toMatch(/outside the graph/);
        expect(await refused('<urn:x> <urn:p> 1 .\n' + VIEW)).toMatch(/outside the graph/);
        expect(await refused(VIEW, n('urn:name:other'))).toMatch(/not the graph <urn:name:other>/);
        expect(await refused('<urn:name:view> {\n  <urn:name:view/p/1> <osg://vocab/view#x> 0\n}\n')).toMatch(/final "\."/);
        expect(await refused('')).toMatch(/no graph block/);
        // Without a graph: a TriG text is refused as today, and quads in a graph are refused.
        const r = await patchTurtle(VIEW, FILE, before, after);
        expect(r.ok ? 'ok' : r.reason).toMatch(/only Turtle/);
        const q = await patchTurtle(VIEW, FILE, before, [...before, g('urn:name:view/p/1', V + 'x', int(1))]);
        expect(q.ok ? 'ok' : q.reason).toMatch(/named graph in a Turtle file/);
        const other = await patchTurtle(VIEW, FILE, before, [...before, rdf.quad(n('a'), n('p'), int(1), n('urn:name:other'))], {}, GRAPH);
        expect(other.ok ? 'ok' : other.reason).toMatch(/outside the graph/);
    });

    it('round trip: the patched text reads back as the expected quads, with the graph, after several edits', async () => {
        let text = VIEW;
        for (let i = 3; i < 8; i++) {
            text = await patch(text, q => [...q.filter(x => !(x.predicate.value === V + 'x' && x.subject.value === `urn:name:view/p/${i - 1}`)),
                g(`urn:name:view/p/${i - 1}`, V + 'x', int(i * 100)), g(`urn:name:view/p/${i}`, V + 'y', int(i))]);
        }
        expect(text.startsWith(VIEW.slice(0, VIEW.indexOf('<urn:name:view/p/2>')))).toBe(true);
        expect(text.endsWith('\n\n}\n')).toBe(true);
    });
});
