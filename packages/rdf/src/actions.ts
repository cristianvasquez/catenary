// The facts of a selection for the action model (packages/model/src/actions.ts): kinds and types of each element, placements,
// Model explorer rows, files, property shape facts, target classes and classes without a node shape. From the store and its read
// model; the frontend gets the actions that apply (RPC `selectionActions`) and never computes them.

import type { NamedNode, Term } from '@rdfjs/types';
import {
    ActionTarget, Doc, ElementKind, ItemFacts, NS, SelectionActions, SelectionFacts, View, applicableActions, boxOf, displayCards, elementOfId, lineProblem,
    isTakenOut
} from '@catenary/model';
import { ExplorerContext, explorerPaths } from './explorer';
import { VALIDATION_GRAPH } from './graph';
import { elementTerm } from './ids';
import { shapeable, unshapedClasses } from './shape-proposal';

export interface ActionContext extends ExplorerContext {
    /** The read model of the target: its elements and its view (scoped-doc.ts). */
    doc: Doc;
    /** The read model of one view (with its placement ids). */
    viewOf: (viewId: string) => View | undefined;
    /** The files with statements of an element. */
    filesOf: (id: string) => string[];
}

const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX sh: <${NS.sh}>`;

function select(ctx: ActionContext, query: string): Record<string, Term>[] {
    return ctx.g.store.select(`${PREFIXES} ${query}`) as unknown as Record<string, Term>[];
}

/** All kinds of an element: the records of the read model that have it, and the mark kind of its box in `view`. */
export function kindsOf(doc: Doc, view: View | undefined, id: string): ElementKind[] {
    const kinds: ElementKind[] = [];
    if (doc.shapes.nodeShapes[id]) kinds.push('shape');
    if (doc.shapes.valueSets[id]) kinds.push('valueSet');
    if (doc.instances[id]) kinds.push('instance');
    if (doc.relations[id]) kinds.push('relation');
    if (doc.views[id]) kinds.push('view');
    if (doc.shapes.properties[id]) kinds.push('property');
    if (doc.shapes.constraints[id]) kinds.push('constraint');
    const box = boxOf(view, id);
    if (box && box.kind !== 'card') kinds.push(box.kind);
    if (view?.arrows.some(a => a.id === id)) kinds.push('arrow');
    return kinds;
}

type ClassFacts = Pick<ItemFacts, 'types' | 'classShapes' | 'unshaped'>;

/**
 * rdf:type of an IRI element, any graph except the SHACL report. A class: the node shapes that target it, and itself when there is
 * none. Another element: its types in the model graph that no node shape targets.
 */
function classFacts(ctx: ActionContext, term: NamedNode): ClassFacts {
    const t = `<${term.value}>`;
    const types = select(ctx, `SELECT DISTINCT ?c WHERE { GRAPH ?g { ${t} a ?c } FILTER (isIRI(?c) && ?g != <${VALIDATION_GRAPH}>) }`).map(r => r.c.value);
    const isClass = types.some(c => [NS.rdfs + 'Class', 'http://www.w3.org/2002/07/owl#Class'].includes(c))
        || ctx.g.store.select(`${PREFIXES} SELECT ?x WHERE { { GRAPH ?g { ?x a ${t} } FILTER (?g != <${VALIDATION_GRAPH}>) } UNION { GRAPH ?h { ?x sh:targetClass ${t} } } } LIMIT 1`).length > 0;
    if (!isClass) return { types, unshaped: unshapedClasses(ctx.g, [term]) };
    const classShapes = Object.values(ctx.shapes.nodeShapes).filter(s => s.targetClass === term.value).map(s => s.id);
    return { types, classShapes, unshaped: classShapes.length || !shapeable(term.value) ? [] : [term.value] };
}

/** The facts of the items of a target. A placement id of `target.view` gives its element. */
export function selectionFacts(ctx: ActionContext, target: ActionTarget): SelectionFacts {
    const { doc } = ctx;
    const view = target.view ? ctx.viewOf(target.view) : undefined;
    const scope = view ? target.view : undefined;
    const items = [...new Set(target.ids)].map((id): ItemFacts => {
        const element = elementOfId(view, id);
        const kinds = kindsOf(doc, view, element);
        // A mark is known only by its view: its kind comes from the selected id (its placement) in that view.
        if (!kinds.length && element !== id) kinds.push(...kindsOf(doc, view, id));
        const term = !doc.relations[element] && !doc.shapes.properties[element] && !doc.shapes.constraints[element] ? elementTerm(element) : undefined;
        const { types, classShapes, unshaped }: ClassFacts = term ? classFacts(ctx, term) : { types: [], unshaped: [] };
        const views = ctx.placements.get(element) ?? new Set<string>();
        const p = doc.shapes.properties[element];
        return {
            id, element, kinds, types,
            // A placement id, a box or an arrow of the view of the selection, or an element that the view places.
            placed: !!scope && (views.has(scope) || element !== id || !!boxOf(view, id) || !!view?.arrows.some(a => a.id === id)),
            placedInActive: !!target.activeView && views.has(target.activeView),
            views: views.size,
            revealable: kinds.includes('view') || explorerPaths(ctx, element).length > 0,
            files: ctx.filesOf(element).length,
            property: p ? { owner: p.owner, fixed: lineProblem(p), takenOut: view ? isTakenOut(view, p) : undefined } : undefined,
            classShapes, unshaped
        };
    });
    return { view: scope, activeView: target.activeView, items };
}

/** The actions of a target and the facts to run them. */
export function selectionActions(ctx: ActionContext, target: ActionTarget): SelectionActions {
    const facts = selectionFacts(ctx, target);
    return { actions: applicableActions(facts), items: facts.items, cards: displayCards(ctx.doc, facts.view, facts.items) };
}
