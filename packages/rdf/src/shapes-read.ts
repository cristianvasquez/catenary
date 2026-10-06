// Shapes graphs -> ShapesModel (@catenary/model): node shapes, property shapes, logical constraints, with the terms that hold them.
// The read does not change the quads. Statements that the editor does not map are listed as `raw` and stay in the store and the files.
// Mapping:
//   node shape: an IRI with rdf:type sh:NodeShape, sh:targetClass, sh:property or a logical constraint, and without sh:path.
//   property shape: an object of sh:property, or a member with sh:path of an sh:or / sh:xone / sh:and list, or the object of sh:not.
//   range, first match: sh:node to a scheme shape (one property: skos:inScheme with sh:hasValue or sh:in; scheme), sh:node to a member
//   shape (dct:source a skos:Collection, sh:in its members; collection), sh:node to a node shape, sh:class, sh:in, sh:datatype, sh:nodeKind.
//   Scheme shapes and member shapes are part of the range: they are not node shapes of the model.
//   range "or": one sh:or on the property shape whose members each have only one of the ranges above (an alternative). The members
//   are part of the range, not node shapes. Another sh:or on a property shape is not mapped (raw).
//   value set: a skos:ConceptScheme or skos:Collection of the shapes graphs.

import {
    LogicalConstraint, LogicalOperator, NODE_KINDS, NS, NodeKind, NodeShape, PathJSON, PropertyShape, Range, ShapesModel, SimpleRange, TermJSON, compactIri,
    emptyShapes, formatPath, isValueSetRange, termToJSON
} from '@catenary/model';
import type { NamedNode, Quad, Quad_Object, Quad_Subject, Term } from '@rdfjs/types';
import type { Dataset } from 'rdf-ext';
import { ModelGraph, cmp, fileOfGraph, labelFromIri } from './graph';
import { constraintId, elementId, propertyShapeId } from './ids';
import { isSkolem } from './skolem';
import { rdf, termKey } from './terms';

const SH = NS.sh;
const n = (iri: string) => rdf.namedNode(iri);
export const S = {
    NodeShape: n(SH + 'NodeShape'), PropertyShape: n(SH + 'PropertyShape'), targetClass: n(SH + 'targetClass'), property: n(SH + 'property'),
    path: n(SH + 'path'), name: n(SH + 'name'), description: n(SH + 'description'), minCount: n(SH + 'minCount'), maxCount: n(SH + 'maxCount'),
    datatype: n(SH + 'datatype'), nodeKind: n(SH + 'nodeKind'), class: n(SH + 'class'), node: n(SH + 'node'), in: n(SH + 'in'),
    hasValue: n(SH + 'hasValue'), pattern: n(SH + 'pattern'), minLength: n(SH + 'minLength'), maxLength: n(SH + 'maxLength'),
    languageIn: n(SH + 'languageIn'), order: n(SH + 'order'), closed: n(SH + 'closed'), ignoredProperties: n(SH + 'ignoredProperties'),
    inversePath: n(SH + 'inversePath'), alternativePath: n(SH + 'alternativePath'), zeroOrMorePath: n(SH + 'zeroOrMorePath'),
    oneOrMorePath: n(SH + 'oneOrMorePath'), zeroOrOnePath: n(SH + 'zeroOrOnePath'),
    or: n(SH + 'or'), xone: n(SH + 'xone'), and: n(SH + 'and'), not: n(SH + 'not'),
    type: n(NS.rdf + 'type'), first: n(NS.rdf + 'first'), rest: n(NS.rdf + 'rest'), nil: n(NS.rdf + 'nil'),
    label: n(NS.rdfs + 'label'), comment: n(NS.rdfs + 'comment'),
    Concept: n(NS.skos + 'Concept'), inScheme: n(NS.skos + 'inScheme'), ConceptScheme: n(NS.skos + 'ConceptScheme'),
    Collection: n(NS.skos + 'Collection'), member: n(NS.skos + 'member'), hasTopConcept: n(NS.skos + 'hasTopConcept'),
    topConceptOf: n(NS.skos + 'topConceptOf'), prefLabel: n(NS.skos + 'prefLabel'), source: n(NS.dct + 'source'),
    broader: n(NS.skos + 'broader'), narrower: n(NS.skos + 'narrower')
};
export const LIST_OPERATORS = ['or', 'xone', 'and'] as const;

/** Where a property shape is: an sh:property of its owner, a member of a list (sh:or, sh:xone, sh:and), or the object of sh:not. */
export type Placement = { via: 'property' } | { via: 'list'; operator: LogicalOperator; head: Quad_Object } | { via: 'not' };

export interface ShapesIndex {
    model: ShapesModel;
    nodeShape: Map<string, { term: NamedNode; graph: NamedNode }>;
    property: Map<string, { term: Quad_Subject; owner: NamedNode; graph: NamedNode; placement: Placement }>;
    constraint: Map<string, { owner: NamedNode; graph: NamedNode; operator: LogicalOperator; head: Quad_Object }>;
    valueSet: Map<string, { term: NamedNode; graph: NamedNode }>;
    /** Scheme IRI -> its scheme shape; collection IRI -> its member shapes (see the mapping above). */
    schemeShape: Map<string, NamedNode>;
    memberShapes: Map<string, NamedNode[]>;
    /** Property shape term (termKey) -> id of its first occurrence (for validation results). */
    byTerm: Map<string, string>;
}

const key = termKey;

const indexes = new WeakMap<ModelGraph, { revision: number; index: ShapesIndex }>();

/**
 * The shapes index of the shapes graphs and the SKOS vocabulary of the model graph of `g`, cached until they change
 * (ModelGraph.shapesRevision). Do not change it.
 */
export function shapesIndexOf(g: ModelGraph): ShapesIndex {
    const cached = indexes.get(g);
    if (cached?.revision === g.shapesRevision) return cached.index;
    const index = readShapes(g.shapesAndVocabulary());
    indexes.set(g, { revision: g.shapesRevision, index });
    return index;
}

/** Read the shapes of `quads` (quads of the shapes graphs, with their graphs). */
export function readShapes(quads: Iterable<Quad>): ShapesIndex {
    const ds: Dataset = rdf.dataset([...quads]);
    const objects = (s: Term, p: NamedNode) => [...ds.match(s, p)].map(q => q.object).sort((a, b) => cmp(a.value, b.value));
    const one = (s: Term, p: NamedNode) => objects(s, p)[0];
    const int = (s: Term, p: NamedNode) => { const v = one(s, p)?.value; return v === undefined || isNaN(Number(v)) ? undefined : Number(v); };
    const str = (s: Term, p: NamedNode) => one(s, p)?.value;
    const list = (head: Term | undefined): Term[] => {
        const items: Term[] = [];
        const seen = new Set<string>();
        for (let h = head; h && !h.equals(S.nil) && !seen.has(key(h)); h = one(h, S.rest)) {
            seen.add(key(h));
            const item = one(h, S.first);
            if (!item) break;
            items.push(item);
        }
        return items;
    };
    const text = (t: Term, depth = 0): string => {
        if (t.termType === 'NamedNode' && !isSkolem(t)) return t.equals(S.nil) ? '()' : compactIri(t.value);
        if (t.termType === 'Literal') return JSON.stringify(t.value) + (t.language ? '@' + t.language : '');
        if (depth > 2) return '[…]';
        if (one(t, S.first)) return `( ${list(t).map(x => text(x, depth + 1)).join(' ')} )`;
        const inner = [...ds.match(t)].map(q => `${compactIri(q.predicate.value)} ${text(q.object, depth + 1)}`).sort(cmp);
        return `[ ${inner.join(' ; ')} ]`;
    };
    const rawOf = (s: Term, known: NamedNode[]) => [...ds.match(s)].filter(q => !known.some(k => k.equals(q.predicate)))
        .map(q => `${compactIri(q.predicate.value)} ${text(q.object)}`).sort(cmp);

    // The structure decides, not the term type: a node with a path predicate or a list is a complex path; another IRI is a predicate.
    const path = (t: Term, depth = 0): PathJSON => {
        if (depth > 8) return { kind: 'unsupported', text: text(t) };
        const inverse = one(t, S.inversePath);
        if (inverse) return { kind: 'inverse', path: path(inverse, depth + 1) };
        const alternative = one(t, S.alternativePath);
        if (alternative) return { kind: 'alternative', items: list(alternative).map(x => path(x, depth + 1)) };
        if (one(t, S.first)) return { kind: 'sequence', items: list(t).map(x => path(x, depth + 1)) };
        for (const [p, op] of [[S.zeroOrMorePath, '*'], [S.oneOrMorePath, '+'], [S.zeroOrOnePath, '?']] as const) {
            const inner = one(t, p);
            if (inner) return { kind: 'unsupported', text: `(${formatPath(path(inner, depth + 1))})${op}` };
        }
        if (t.termType === 'NamedNode' && !t.equals(S.nil)) return { kind: 'iri', iri: t.value };
        return { kind: 'unsupported', text: text(t) };
    };

    const graphOf = (s: Term) => [...ds.match(s)].map(q => q.graph as NamedNode).sort((a, b) => cmp(a.value, b.value))[0];

    // Node shapes.
    const candidates = rdf.termSet<NamedNode>();
    for (const p of [S.targetClass, S.property, S.or, S.xone, S.and, S.not]) {
        for (const q of ds.match(null, p)) candidates.add(q.subject as NamedNode);
    }
    for (const q of ds.match(null, S.type, S.NodeShape)) candidates.add(q.subject as NamedNode);
    // Members of a property-level sh:or are part of the range of the property shape, not node shapes of the model.
    const orMembers = new Set([...ds.match(null, S.or)].filter(q => one(q.subject, S.path)).flatMap(q => list(q.object)).map(t => t.value));
    const shapeTerms = [...candidates].filter(t => !one(t, S.path) && !orMembers.has(t.value)).sort((a, b) => cmp(a.value, b.value));

    // A shape that only says "skos:inScheme has this value (or one of these)": the schemes.
    const LABELS = [S.name, S.label, S.description, S.comment];
    const schemesOf = (node: Term): string[] | undefined => {
        if (node.termType === 'Literal') return undefined;
        const others = [...ds.match(node)].filter(q => !q.predicate.equals(S.property) && !(q.predicate.equals(S.type) && q.object.equals(S.NodeShape))
            && !LABELS.some(l => l.equals(q.predicate)));
        const props = objects(node, S.property);
        if (others.length || props.length !== 1) return undefined;
        const ps = props[0];
        const pathTerm = one(ps, S.path);
        if (!pathTerm?.equals(S.inScheme)) return undefined;
        const allowed = [S.path, S.hasValue, S.in, S.minCount, S.type];
        if ([...ds.match(ps)].some(q => !allowed.some(a => a.equals(q.predicate)))) return undefined;
        const values = [...objects(ps, S.hasValue), ...list(one(ps, S.in))].filter(v => v.termType === 'NamedNode').map(v => v.value);
        return values.length ? [...new Set(values)] : undefined;
    };
    // A shape with dct:source a collection and sh:in (the members): the collection.
    const collectionOf = (node: Term): string | undefined => {
        if (node.termType !== 'NamedNode') return undefined;
        const source = one(node, S.source);
        if (!source || !ds.match(source, S.type, S.Collection).size || !one(node, S.in)) return undefined;
        const others = [...ds.match(node)].filter(q => ![S.source, S.in].some(p => p.equals(q.predicate)) && !(q.predicate.equals(S.type) && q.object.equals(S.NodeShape))
            && !LABELS.some(l => l.equals(q.predicate)));
        return others.length ? undefined : source.value;
    };
    const helperShapes = new Set(shapeTerms.filter(t => schemesOf(t) || collectionOf(t)).map(t => t.value));
    const modelShapes = shapeTerms.filter(t => !helperShapes.has(t.value));
    const shapeIds = new Map(modelShapes.map(t => [t.value, elementId(t)]));

    const PROPERTY_KNOWN = [S.path, S.name, S.description, S.minCount, S.maxCount, S.datatype, S.nodeKind, S.class, S.node, S.in, S.pattern,
        S.minLength, S.maxLength, S.languageIn, S.order];
    const nodeKindOf = (t: Term | undefined): NodeKind | undefined => {
        const k = t?.value.startsWith(SH) ? t.value.slice(SH.length) : undefined;
        return NODE_KINDS.includes(k as NodeKind) ? k as NodeKind : undefined;
    };

    /** The range statements of `t` (a property shape, or a member of its sh:or): the range, the statements it does not use, sh:node kept as text. */
    const rangeOf = (t: Term) => {
        const raw: string[] = [];
        const node = one(t, S.node), cls = one(t, S.class), datatype = one(t, S.datatype), inHead = one(t, S.in);
        const nodeKind = nodeKindOf(one(t, S.nodeKind));
        const schemes = node && schemesOf(node);
        const collection = node && !schemes ? collectionOf(node) : undefined;
        let range: Range;
        let nodeRef: string | undefined;
        if (schemes) range = { kind: 'scheme', schemes };
        else if (collection) range = { kind: 'collection', collection };
        else if (node && shapeIds.has(node.value)) range = { kind: 'node', shape: shapeIds.get(node.value)! };
        else if (cls) range = { kind: 'class', class: cls.value };
        else if (inHead) range = { kind: 'in', values: list(inHead).map(termToJSON).filter((x): x is TermJSON => !!x) };
        else if (datatype) range = { kind: 'datatype', datatype: datatype.value };
        else if (nodeKind) range = { kind: 'nodeKind', nodeKind };
        else range = { kind: 'any' };
        if (node && !schemes && !collection && range.kind !== 'node') {
            nodeRef = isSkolem(node) ? text(node) : node.value;
            raw.push(`sh:node ${text(node)}`);
        }
        // A class next to a scheme is part of the scheme range (skos:Concept); another class is kept as raw.
        if (cls && range.kind !== 'class' && !(range.kind === 'scheme' && cls.equals(S.Concept))) raw.push(`sh:class ${text(cls)}`);
        if (datatype && range.kind !== 'datatype') raw.push(`sh:datatype ${text(datatype)}`);
        if (inHead && range.kind !== 'in') raw.push(`sh:in ${text(inHead)}`);
        const key = range.kind === 'node' ? 'node:' + node!.value
            : range.kind === 'class' ? 'class:' + range.class
            : range.kind === 'datatype' ? 'datatype:' + range.datatype
            : range.kind === 'nodeKind' ? 'nodeKind:' + range.nodeKind
            : range.kind === 'in' ? 'in:' + range.values.map(v => v.value).join(' ')
            : range.kind === 'scheme' ? 'scheme:' + range.schemes.join(' ')
            : range.kind === 'collection' ? 'collection:' + range.collection : 'any';
        return { range, raw, nodeRef, nodeKind, key };
    };

    /**
     * The members of a property-level sh:or list as ranges; undefined when a member is not only a range (one range statement, and
     * sh:nodeKind sh:IRI next to a scheme or collection; rdf:type, labels).
     */
    const orAlternatives = (head: Term) => {
        const items = list(head);
        if (!items.length) return undefined;
        const out: { range: SimpleRange; key: string }[] = [];
        for (const item of items) {
            if (item.termType === 'Literal') return undefined;
            const r = rangeOf(item);
            if (r.range.kind === 'any' || r.raw.length) return undefined;
            if (r.nodeKind && r.range.kind !== 'nodeKind' && !(r.nodeKind === 'IRI' && isValueSetRange(r.range))) return undefined;
            const other = [...ds.match(item)].filter(q => ![S.class, S.node, S.datatype, S.nodeKind, S.in, ...LABELS].some(k => k.equals(q.predicate))
                && !(q.predicate.equals(S.type) && (q.object.equals(S.NodeShape) || q.object.equals(S.PropertyShape))));
            if (other.length) return undefined;
            out.push({ range: r.range as SimpleRange, key: r.key });
        }
        return out;
    };

    const readProperty = (ps: Quad_Subject): Omit<PropertyShape, 'id' | 'owner' | 'constraint'> & { rangeKey: string; pathKey: string } => {
        const p = path(one(ps, S.path)!);
        const orHeads = objects(ps, S.or);
        const alternatives = orHeads.length === 1 ? orAlternatives(orHeads[0]) : undefined;
        let range: Range, rangeKey: string, nodeRef: string | undefined, nodeKind: NodeKind | undefined, raw: string[];
        if (alternatives) {
            // sh:or of ranges. Other range statements of the property shape (except sh:nodeKind) are not mapped.
            raw = rawOf(ps, [...PROPERTY_KNOWN.filter(k => ![S.class, S.node, S.datatype, S.in].includes(k)), S.or]);
            range = { kind: 'or', alternatives: alternatives.map(a => a.range) };
            rangeKey = 'or:' + alternatives.map(a => a.key).join('|');
            nodeKind = nodeKindOf(one(ps, S.nodeKind));
        } else {
            const own = rangeOf(ps);
            ({ range, nodeRef, nodeKind } = own);
            rangeKey = own.key;
            raw = [...rawOf(ps, PROPERTY_KNOWN), ...own.raw];
        }
        raw = raw.filter(r => r !== 'rdf:type sh:PropertyShape');
        const languageIn = list(one(ps, S.languageIn)).map(t => t.value);
        return {
            path: p, pathKey: formatPath(p, iri => `<${iri}>`), rangeKey, range,
            name: str(ps, S.name), description: str(ps, S.description),
            minCount: int(ps, S.minCount), maxCount: int(ps, S.maxCount),
            nodeKind: range.kind === 'nodeKind' ? undefined : nodeKind, nodeRef,
            pattern: str(ps, S.pattern), minLength: int(ps, S.minLength), maxLength: int(ps, S.maxLength),
            languageIn: languageIn.length ? languageIn : undefined, order: int(ps, S.order), raw
        };
    };

    const index: ShapesIndex = {
        model: emptyShapes(), nodeShape: new Map(), property: new Map(), constraint: new Map(), byTerm: new Map(), valueSet: new Map(),
        schemeShape: new Map(), memberShapes: new Map()
    };
    for (const t of shapeTerms) {
        const schemes = schemesOf(t);
        if (schemes?.length === 1 && !index.schemeShape.has(schemes[0])) index.schemeShape.set(schemes[0], t);
        const c = collectionOf(t);
        if (c) index.memberShapes.set(c, [...(index.memberShapes.get(c) ?? []), t]);
    }
    const NODE_KNOWN = [S.type, S.targetClass, S.name, S.label, S.description, S.comment, S.property, S.closed, S.or, S.xone, S.and, S.not];
    const usedIds = new Set<string>();
    for (const s of modelShapes) {
        const id = shapeIds.get(s.value)!;
        const graph = graphOf(s);
        const targets = objects(s, S.targetClass);
        const shape: NodeShape = {
            id, uri: s.value,
            label: str(s, S.name) ?? str(s, S.label) ?? labelFromIri(s.value),
            targetClass: targets[0]?.value,
            closed: str(s, S.closed) === 'true' || undefined,
            description: str(s, S.description) ?? str(s, S.comment),
            file: fileOfGraph(graph.value), properties: [], constraints: [],
            raw: [...rawOf(s, NODE_KNOWN).filter(r => r !== 'rdf:type sh:NodeShape'), ...targets.slice(1).map(t => `sh:targetClass ${text(t)}`)]
        };
        index.model.nodeShapes[id] = shape;
        index.nodeShape.set(id, { term: s, graph });

        const used = new Map<string, number>();
        const addProperty = (ps: Quad_Subject, placement: Placement, constraint?: string): string | undefined => {
            if (!one(ps, S.path)) return undefined;
            const r = readProperty(ps);
            // Its element id (unless two node shapes use it: the second gets a derived id).
            let pid = elementId(ps as NamedNode);
            if (usedIds.has(pid)) {
                const base = propertyShapeId(s, r.pathKey, r.rangeKey);
                const count = (used.get(base) ?? 0) + 1;
                used.set(base, count);
                pid = propertyShapeId(s, r.pathKey, r.rangeKey, count);
            }
            usedIds.add(pid);
            const { rangeKey: _r, pathKey: _p, ...fields } = r;
            index.model.properties[pid] = { id: pid, uri: ps.value, owner: id, ...(constraint ? { constraint } : {}), ...fields };
            index.property.set(pid, { term: ps, owner: s, graph, placement });
            if (!index.byTerm.has(key(ps))) index.byTerm.set(key(ps), pid);
            shape.properties.push(pid);
            return pid;
        };
        for (const ps of objects(s, S.property)) {
            if (ps.termType === 'Literal') continue;
            if (!addProperty(ps as Quad_Subject, { via: 'property' })) shape.raw.push(`sh:property ${text(ps)} (no sh:path)`);
        }
        for (const operator of LIST_OPERATORS) {
            // Order: by the text of the members, so that the n-th constraint of an operator is stable while its members do not change.
            const heads = objects(s, S[operator]).map(h => ({ h, t: list(h).map(x => text(x)).join(' ') })).sort((a, b) => cmp(a.t, b.t));
            heads.forEach(({ h }, i) => {
                const cid = constraintId(operator, s, i + 1);
                const c: LogicalConstraint = { id: cid, owner: id, operator, members: [], raw: [] };
                for (const item of list(h)) {
                    const pid = item.termType !== 'Literal' ? addProperty(item as Quad_Subject, { via: 'list', operator, head: h }, cid) : undefined;
                    if (pid) c.members.push(pid);
                    else c.raw.push(text(item));
                }
                index.model.constraints[cid] = c;
                index.constraint.set(cid, { owner: s, graph, operator, head: h });
                shape.constraints.push(cid);
            });
        }
        objects(s, S.not).forEach((x, i) => {
            const cid = constraintId('not', s, i + 1);
            const pid = x.termType !== 'Literal' ? addProperty(x as Quad_Subject, { via: 'not' }, cid) : undefined;
            if (!pid) { shape.raw.push(`sh:not ${text(x)}`); return; }
            index.model.constraints[cid] = { id: cid, owner: id, operator: 'not', members: [pid], raw: [] };
            index.constraint.set(cid, { owner: s, graph, operator: 'not', head: x });
            shape.constraints.push(cid);
        });
        shape.properties.sort(cmp);
    }

    // Value sets: concept schemes and collections.
    const labelOf = (t: Term) => {
        const labels = [...ds.match(t, S.prefLabel)].map(q => q.object as Term & { language?: string });
        const pick = labels.find(l => !l.language) ?? labels.find(l => l.language?.startsWith('en')) ?? labels[0];
        return pick?.value ?? str(t, S.label) ?? labelFromIri(t.value);
    };
    for (const [kind, type] of [['scheme', S.ConceptScheme], ['collection', S.Collection]] as const) {
        for (const q of ds.match(null, S.type, type)) {
            const t = q.subject;
            if (t.termType !== 'NamedNode') continue;
            const id = elementId(t);
            if (index.model.valueSets[id]) continue;
            const members = rdf.termSet<Term>();
            if (kind === 'scheme') {
                for (const m of ds.match(null, S.inScheme, t)) members.add(m.subject);
                for (const m of ds.match(null, S.topConceptOf, t)) members.add(m.subject);
                for (const m of ds.match(t, S.hasTopConcept)) members.add(m.object);
            } else for (const m of ds.match(t, S.member)) members.add(m.object);
            index.model.valueSets[id] = {
                id, uri: t.value, kind, label: labelOf(t), file: fileOfGraph(graphOf(t).value),
                members: [...members].filter(m => m.termType === 'NamedNode').map(m => ({
                    uri: m.value, label: labelOf(m),
                    broader: [...new Set([...ds.match(m, S.broader)].map(q => q.object.value).concat([...ds.match(null, S.narrower, m)].map(q => q.subject.value)))].sort()
                })).sort((a, b) => cmp(a.label, b.label) || cmp(a.uri, b.uri))
            };
            index.valueSet.set(id, { term: t, graph: graphOf(t) });
        }
    }
    return index;
}
