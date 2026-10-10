// Clipboard RDF uses the normal graph transaction and file routing. Figures come from the view's notations.
import { Classes, NS, PasteBox, Point, RdfCopy, RdfPaste, TYPES, iriId, layoutPastedBoxes, nkey, selection, termToJSON, toSchema } from '@catenary/model';
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import { canonical, parseRdfSync } from 'rdf-files';
import { ModelGraph, P, V } from './graph';
import { elementId, elementTerm, relationId, relationTriple } from './ids';
import { serializeRdf } from './files';
import { figureTermOf, listTermOf } from './figure-edits';
import { viewFiguresOf } from './notations';
import * as ops from './ops';
import { skolemize } from './skolem';
import { rdf, termKey, tripleKey } from './terms';
import { readView } from './view-read';
import { shapePart } from './loader';

const formats = ['application/trig', 'application/n-quads', 'application/ld+json', 'application/rdf+xml', 'text/n3'];
const accepted = new Set(['text/turtle', 'application/n-triples', ...formats]);

/** Parse completely before editing. Explicit MIME types do not fall back to another syntax. */
export async function prepareRdfPaste(text: string, mediaType?: string): Promise<RdfPaste> {
    if (!text.trim()) return { ok: false, error: 'The clipboard has no RDF statements.' };
    const mime = mediaType?.split(';')[0].trim();
    if (mime && mime !== 'text/plain' && !accepted.has(mime)) return { ok: false, error: 'This RDF clipboard format is not supported.' };
    for (const format of mime && mime !== 'text/plain' ? [mime] : formats) {
        // Plain JSON is not implicitly RDF. A JSON-LD clipboard must declare its context.
        if (format === 'application/ld+json' && !mime && !text.includes('"@context"')) continue;
        try {
            const quads = skolemize([...await rdf.io.dataset.fromText(format, text)]).quads;
            if (!quads.length) return { ok: false, error: 'The clipboard has no RDF statements.' };
            const namedGraphs = [...new Set(quads.filter(q => q.graph.termType !== 'DefaultGraph').map(q => q.graph.value))].sort();
            return { ok: true, rdf: canonical(quads), namedGraphs, statements: quads.length };
        } catch { /* Try the next syntax only for untyped clipboard text. */ }
    }
    return { ok: false, error: 'The clipboard is not valid RDF. Use Turtle, TriG, N-Triples, N-Quads, JSON-LD, N3, or RDF/XML.' };
}

/** Add missing triples, preserve IRIs and place only figures that the pasted data describes. */
export function pasteRdf(g: ModelGraph, viewId: string, text: string, flatten: boolean, at: Point): ops.Result<string[]> {
    const parsed = parseRdfSync(text, 'application/n-quads');
    if (parsed.some(q => q.graph.termType !== 'DefaultGraph') && !flatten) return ops.fail('Named graphs require confirmation before flattening.');
    const quads = skolemize(parsed.map(q => rdf.quad(q.subject, q.predicate, q.object))).quads;
    if (!quads.length) return ops.fail('The clipboard has no RDF statements.');
    // Shape descriptions and their owned parts use the primary shapes graph. Existing shapes keep their graph.
    const shapeSubjects = shapePart(quads);
    for (const q of quads) {
        if (g.match(q.subject, q.predicate, q.object).some(existing => g.isDataGraph(existing.graph) || g.isShapesGraph(existing.graph))) continue;
        const existing = g.match(q.subject).find(existing => g.isShapesGraph(existing.graph));
        const graph = existing?.graph ?? (shapeSubjects.has(termKey(q.subject)) ? g.shapesTarget() : g.homeOf(q.subject));
        if (!graph) return ops.fail('No file is configured for new shapes.');
        g.add(q.subject, q.predicate, q.object, graph);
    }
    // The pasted elements and the ends of the pasted statements are not placed yet: the figures read around them too.
    const pasted = quads.flatMap(q => [q.subject, q.object]).flatMap(t => { const j = termToJSON(t); return j?.termType === 'NamedNode' ? [j] : []; });
    const vf = viewFiguresOf(g, ops.viewTerm(g, viewId)!.value, pasted);
    const subjects = new Set(quads.map(q => termKey(q.subject)));
    const statements = new Set(quads.map(tripleKey));
    const placed: string[] = [];
    for (const f of vf.derivation.figures) {
        if (f.fs.kind !== 'Box' || !subjects.has(nkey(f.focus)) || vf.placed.has(nkey(f.placedAs))) continue;
        const term = f.placedAs;
        if (term.termType !== 'NamedNode') continue;
        const element = rdf.namedNode(term.value), view = ops.viewTerm(g, viewId)!;
        const p = ops.addPlacement(g, view, element);
        ops.writeBox(g, view, p, { ...at, ...ops.cardSize(g, elementId(element)) });
        placed.push(elementId(p));
    }
    // Explicit pasted relationships may bring their two ends. Never walk unrelated outgoing resources.
    for (const f of vf.derivation.figures) for (const link of f.connectors) {
        const t = link.statement;
        if (t.termType !== 'Triple') continue;
        const q = rdf.quad(rdf.namedNode(t.subject.value), rdf.namedNode(t.predicate.value), rdf.namedNode(t.object.value));
        if (!statements.has(tripleKey(q))) continue;
        for (const end of [link.start, link.end]) {
            if (!end || end.fs.kind !== 'Box' || end.placedAs.termType !== 'NamedNode') continue;
            const element = rdf.namedNode(end.placedAs.value), view = ops.viewTerm(g, viewId)!;
            if (g.nodeOf(view, element)) continue;
            const p = ops.addPlacement(g, view, element);
            ops.writeBox(g, view, p, { ...at, ...ops.cardSize(g, elementId(element)) });
            placed.push(elementId(p));
        }
    }
    // The default instance projection also draws model relations without a property-shape declaration.
    for (const q of quads) {
        if (q.subject.termType !== 'NamedNode' || q.object.termType !== 'NamedNode' || q.predicate.equals(P.type) || q.predicate.equals(P.label)
            || !ops.relationTerms(g, relationId(q.subject, q.predicate as NamedNode, q.object))) continue;
        for (const end of [q.subject, q.object]) {
            const figure = vf.derivation.figures.find(f => f.fs.kind === 'Box' && f.focus.value === end.value);
            if (!figure || figure.placedAs.termType !== 'NamedNode') continue;
            const term = rdf.namedNode(figure.placedAs.value), view = ops.viewTerm(g, viewId)!;
            if (g.nodeOf(view, term)) continue;
            const p = ops.addPlacement(g, view, term);
            ops.writeBox(g, view, p, { ...at, ...ops.cardSize(g, elementId(term)) });
            placed.push(elementId(p));
        }
    }
    return ops.ok(placed);
}

/** Layout after arrival, inside the paste transaction. Only new placements receive positions. */
export function layoutNewPlacements(g: ModelGraph, meta: Classes, viewId: string, before: Set<string>, at?: Point, cardScale = 1): string[] {
    const view = ops.viewTerm(g, viewId)!;
    const vf = viewFiguresOf(g, view.value);
    const doc = readView(g, viewId);
    const boxes = new Map<string, PasteBox>(doc.views[viewId].boxes.map(b => [b.id, { ...b, group: b.kind === 'group',
        membership: { x: b.x, y: b.y, width: b.width, height: b.height } }]));
    const schema = toSchema(doc, meta, viewId, { showHidden: false, violations: [], notation: vf, cardScale });
    const drawnIds = new Map<string, string>();
    for (const child of schema.children ?? []) {
        if (!child.type.startsWith('node:') || child.private || child.type === TYPES.LOGIC) continue;
        const direct = elementTerm(child.id);
        const term = figureTermOf(g, child.id);
        const placement = direct && g.has(rdf.quad(direct, V.view, view, view)) ? direct : term && g.nodeOf(view, term);
        if (!placement) continue;
        const id = elementId(placement as NamedNode), position = child.position as Point, size = child.size as { width: number; height: number };
        if (!position || !size) continue;
        const stored = boxes.get(id);
        boxes.set(id, { id, ...position, width: Math.max(stored?.width ?? 0, size.width), height: Math.max(stored?.height ?? 0, size.height),
            group: stored?.group, membership: stored?.membership });
        drawnIds.set(child.id, id);
    }
    // Reserve the private pills drawn beside a card, without giving them placements of their own.
    for (const child of schema.children ?? []) if (child.private) {
        const edge = schema.children!.find(e => e.targetId === child.id);
        const id = edge && drawnIds.get(String(edge.sourceId));
        const owner = id && boxes.get(id);
        if (!owner) continue;
        const position = child.position as Point, size = child.size as { width: number; height: number };
        owner.width = Math.max(owner.width, position.x + size.width - owner.x);
        owner.height = Math.max(owner.height, position.y + size.height - owner.y);
    }
    for (const hub of vf.join.hubs) {
        const p = vf.placed.get(nkey(hub.placedAs))!;
        boxes.set(iriId(p.iri), { id: iriId(p.iri), x: p.x ?? 0, y: p.y ?? 0, width: 40, height: 40 });
    }
    const added = [...boxes.values()].filter(b => !before.has(b.id)), fixed = [...boxes.values()].filter(b => before.has(b.id));
    const anchor = at ?? { x: Math.min(...added.map(b => b.x)), y: Math.min(...added.map(b => b.y)) };
    for (const b of layoutPastedBoxes(added, fixed, anchor)) {
        const p = elementTerm(b.id)!;
        // Preserve dimensions and appearance. Drawn extents reserve space but are not stored as new sizes.
        ops.writeBox(g, view, p, { x: b.x, y: b.y });
    }
    return [...vf.placed.values()].filter(p => !before.has(iriId(p.iri))).map(p => iriId(p.iri));
}

/** Domain RDF for cards, links and owned parts. References do not pull in their resource descriptions. */
export async function copyAsRdf(g: ModelGraph, viewId: string, ids: string[]): Promise<RdfCopy> {
    const view = ops.viewTerm(g, viewId);
    if (!view) return { ok: false, error: 'The view does not exist.' };
    const out = new Map<string, Quad>(), visited = new Set<string>();
    const domain = (q: Quad) => g.isDataGraph(q.graph) || g.isShapesGraph(q.graph);
    const add = (q: Quad) => { if (domain(q)) out.set(tripleKey(q), rdf.quad(q.subject, q.predicate, q.object)); };
    const describe = (s: Term) => {
        const key = termKey(s);
        if (visited.has(key)) return;
        visited.add(key);
        for (const q of g.match(s).filter(domain)) {
            add(q);
            // Named SHACL parts and list cells join their owner's description, as do skolemized owned values.
            const shapePart = q.object.termType === 'NamedNode' && g.isShapesGraph(q.graph)
                && (['property', 'and', 'or', 'xone', 'not', 'in', 'languageIn', 'ignoredProperties', 'alternativePath'].some(p => q.predicate.value === NS.sh + p)
                    || ['first', 'rest'].some(p => q.predicate.value === NS.rdf + p))
                && g.match(q.object, null, null, q.graph).length && g.match(null, null, q.object).filter(domain).every(r => r.subject.equals(s));
            if (g.ownedBy(q.object, s, q.graph) || shapePart) describe(q.object);
        }
    };
    const stored = readView(g, viewId).views[viewId];
    const expanded = [...ids, ...selection(stored, ids).flatMap(b => b.kind === 'card' ? [b.element] : b.kind === 'collection' ? b.members : [])];
    for (const id of new Set(expanded)) {
        const p = elementTerm(id);
        const reified = p && g.object(p, P.reifies, view);
        const r = relationTriple(id);
        const relation = reified?.termType === 'Quad' ? reified : r ? rdf.quad(r.s, r.p, r.o) : undefined;
        if (relation) { g.match(relation.subject, relation.predicate, relation.object).forEach(add); continue; }
        const term = figureTermOf(g, ops.elementIdOf(g, id));
        if (!term) continue;
        if (term.value.startsWith(ops.LIST_PREFIX)) {
            for (const q of g.quads().filter(domain)) if (q.object.termType === 'NamedNode' && g.match(q.object, rdf.namedNode(NS.rdf + 'first')).length
                && listTermOf(g, q.subject as NamedNode, q.predicate as NamedNode, q.object).equals(term)) describe(q.object);
        } else describe(term);
    }
    return out.size ? { ok: true, text: await serializeRdf(out.values(), 'clipboard.ttl') }
        : { ok: false, error: 'The selection has no model RDF to copy.' };
}
