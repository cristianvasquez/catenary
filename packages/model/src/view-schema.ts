// Doc + one view -> graph model schema (GLSP / Sprotty). Used by the GLSP server.
// The SHACL and value-set elements come from the notation engine (notation-schema.ts, ADR 0014); instance cards, relations and marks
// from the read model of the view (diagram-schema.ts).

import { Classes } from './metamodel';
import { Doc } from './doc';
import { ElementSchema, GraphOptions, TYPES, arrowElements, dataElements, viewElements } from './diagram-schema';
import { notationElements } from './notation-schema';

export function toSchema(doc: Doc, meta: Classes, viewId: string, opts: GraphOptions): ElementSchema {
    const view = doc.views[viewId];
    if (!view) return { type: TYPES.GRAPH, id: 'root', children: [] };
    const shapes = opts.notation ? notationElements(doc, opts.notation, opts) : { edges: [], cards: [], overlays: [], ids: new Set<string>() };
    const data = dataElements(doc, meta, view, opts, shapes.ids);
    const { groups, references, notes } = viewElements(doc, view);
    const boxes = [...data.cards, ...shapes.cards, ...data.collections, ...shapes.overlays, ...references, ...notes];
    const arrows = arrowElements(view, new Set([...groups, ...boxes].map(b => b.id)));
    // Paint order: groups (large first), edges, cards, collections, pills and logical constraints, view references, notes, arrows.
    return {
        type: TYPES.GRAPH, id: 'root', viewId,
        children: [...groups, ...data.edges, ...shapes.edges, ...boxes, ...arrows]
    };
}
