// A view as text lines that an agent reads in one pass (CLI `view <id> --compact`, spec/manifest.hs §11.1 law_compactLinesCoverBoxes).

import type { Doc, ViewBox } from './doc';
import { idIri } from './ids';
import { compactIri } from './shapes-doc';
import { NS } from './terms';

/** A label with a space, a quote or no text goes in double quotes (JSON string escapes). */
const word = (text: string) => /[\s"]/.test(text) || text === '' ? JSON.stringify(text) : text;

const int = (n: number) => String(Math.round(n));
const xy = (b: ViewBox) => `${int(b.x)} ${int(b.y)}`;
const xywh = (b: ViewBox) => `${xy(b)} ${int(b.width)} ${int(b.height)}`;
const oneLine = (text: string) => text.replace(/\r?\n/g, '\\n');

/** Label, class CURIE and IRI of the element of a card: an instance, else a node shape or a value set of a shapes view. */
function element(doc: Doc, id: string): { label: string; cls: string; iri: string } {
    const i = doc.instances[id];
    if (i) return { label: i.label, cls: i.types.length ? i.types.map(compactIri).join(',') : '-', iri: i.uri };
    const shape = doc.shapes.nodeShapes[id];
    if (shape) return { label: shape.label, cls: compactIri(NS.sh + 'NodeShape'), iri: shape.uri };
    const set = doc.shapes.valueSets[id];
    if (set) return { label: set.label, cls: compactIri(NS.skos + (set.kind === 'scheme' ? 'ConceptScheme' : 'Collection')), iri: set.uri };
    return { label: id, cls: '-', iri: idIri(id) ?? '-' };
}

const labelOf = (doc: Doc, id: string) => element(doc, id).label;

/** The name of a box in an arrow line. A collection has no label: the labels of its members, comma-separated. */
function boxName(doc: Doc, b: ViewBox): string {
    switch (b.kind) {
        case 'card': return labelOf(doc, b.element);
        case 'group': return b.label;
        case 'note': return oneLine(b.text);
        case 'reference': return referenceName(doc, b);
        case 'collection': return b.members.map(m => labelOf(doc, m)).join(', ');
    }
}

function referenceName(doc: Doc, b: Extract<ViewBox, { kind: 'reference' }>): string {
    if (b.target) return doc.views[b.target]?.label ?? b.target;
    return b.file ?? '-';
}

function boxLine(doc: Doc, b: ViewBox): string {
    switch (b.kind) {
        case 'card': {
            const e = element(doc, b.element);
            return `card ${word(e.label)} ${e.cls} ${e.iri} ${xywh(b)}`;
        }
        case 'group': return `group ${word(b.label)} ${xywh(b)}`;
        case 'note': return `note ${xy(b)}: ${oneLine(b.text)}`;
        case 'reference': return `reference ${word(referenceName(doc, b))} ${xy(b)}`;
        case 'collection': return `collection ${word(boxName(doc, b))} ${xywh(b)}`;
    }
}

/**
 * The lines of view `viewId` of `doc`: the view, then one line per box in view order, one per edge, one per arrow.
 * Empty when the doc has no such view.
 */
export function compactView(doc: Doc, viewId: string): string[] {
    const view = doc.views[viewId];
    if (!view) return [];
    const byId = new Map(view.boxes.map(b => [b.id, b]));
    const end = (id: string) => { const b = byId.get(id); return word(b ? boxName(doc, b) : id); };
    return [
        `view ${word(view.label)} ${view.uri}`,
        ...view.boxes.map(b => boxLine(doc, b)),
        ...view.edges.map(e => {
            const r = doc.relations[e.relation];
            const line = r ? `edge ${word(labelOf(doc, r.subject))} ${compactIri(r.predicate)} ${word(labelOf(doc, r.object))}` : `edge ${e.relation} - -`;
            return e.hidden ? `${line} hidden` : line;
        }),
        ...view.arrows.map(a => `arrow ${end(a.from)} ${end(a.to)}`)
    ];
}
