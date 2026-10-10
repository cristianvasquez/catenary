import { reasonPredicates } from '@catenary/shacl/common';
import { iriId } from './ids';
import { formatPath, shortIri } from './shapes-doc';
// Doc + one view -> graph model schema (GLSP / Sprotty). Used by the GLSP server.
// The SHACL and value-set elements come from the notation engine (notation-schema.ts, ADR 0014); instance cards, relations and marks
// from the read model of the view (diagram-schema.ts).

import { Classes } from './metamodel';
import { Doc } from './doc';
import { ElementSchema, GraphOptions, TYPES, edgeLanes, arrowElements, dataElements, viewElements } from './diagram-schema';
import { notationElements } from './notation-schema';

export function toSchema(doc: Doc, meta: Classes, viewId: string, opts: GraphOptions): ElementSchema {
    const view = doc.views[viewId];
    if (!view) return { type: TYPES.GRAPH, id: 'root', children: [] };
    const shapes = opts.notation ? notationElements(doc, opts.notation, opts) : { edges: [], cards: [], overlays: [], ids: new Set<string>() };
    const data = dataElements(doc, meta, view, opts, shapes.ids);
    const { groups, references, notes } = viewElements(doc, view);
    const boxes = [...data.cards, ...shapes.cards, ...data.collections, ...shapes.overlays, ...references, ...notes];
    const arrows = arrowElements(view, new Set([...groups, ...boxes].map(b => b.id)));
    const placements = new Map(boxes.filter(b => typeof b.element === 'string').map(b => [b.element as string, b.id]));
    const matches = (opts.applicability ?? []).flatMap(m => {
        if (m.node.termType !== 'NamedNode') return [];
        const source = placements.get(iriId(m.node.value)), target = placements.get(iriId(m.shape));
        return source && target ? [{ m, source, target }] : [];
    });
    const lanes = edgeLanes(matches.map(m => [m.source, m.target]));
    const applicability = matches.map(({ m, source, target }) => ({ type: TYPES.TARGETING,
        id: `${source}_checks_${target}`, sourceId: source, targetId: target,
        name: reasonPredicates(m.reasons),
        details: m.reasons.map(r => {
            const property = r.property ? doc.shapes.properties[iriId(r.property)] : undefined;
            return [`${reasonPredicates([r])}: ${r.target.termType === 'NamedNode' ? shortIri(r.target.value) : r.target.value}`,
                r.sourceShape ? `Source shape: ${shortIri(r.sourceShape)}` : '',
                r.sourceNode ? `Source: ${r.sourceNode.termType === 'NamedNode' ? shortIri(r.sourceNode.value) : r.sourceNode.value}` : '',
                property ? `Path: ${formatPath(property.path)}` : ''].filter(Boolean).join('\n');
        }).join('\n\n'), ...lanes(source, target) }));
    // Paint order: groups (large first), edges, cards, collections, pills and logical constraints, view references, notes, arrows.
    return {
        type: TYPES.GRAPH, id: 'root', viewId,
        children: [...groups, ...data.edges, ...shapes.edges, ...applicability, ...boxes, ...arrows]
    };
}
