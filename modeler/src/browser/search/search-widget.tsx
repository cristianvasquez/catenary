// Search panel: a faceted search (text, type, "linked to") on the store, with the number of things for each facet value. The result
// list holds instances, views, node shapes, property shapes, concept schemes, collections and predicates. The backend runs the search
// (ModelService.search, packages/rdf/src/search.ts); the panel holds the facets and the last result. The rows show and set the selection of
// the window (SelectionModel), as the Model Explorer does. Drag results onto a view, add them to the current view, or double-click one to go to it.

import { CommandService, MenuPath } from '@theia/core';
import { AbstractViewContribution, ContextMenuRenderer, ReactWidget, codicon } from '@theia/core/lib/browser';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { Classes, NS, SearchFacets, SearchHit, SearchResult, classDef, localName, predicateName, panelsUnchanged } from '@catenary/model';
import { ActionService, whenActionsKnown } from '../action-service';
import { DND_INSTANCES, DND_VIEW } from '../diagram/canvas';
import { ViewEditors, ViewLabels } from '../diagram/view-editors';
import { ModelFrontend } from '../model-client';
import { SelectionModel } from '../selection-model';

export const SEARCH_ID = 'catenary-search';
/** Context menu of a result row: the actions of the selection (action-commands.ts). */
export const SEARCH_CONTEXT_MENU: MenuPath = ['catenary-search-context'];
/** Most rows in the result list. */
const LIMIT = 200;

/** Card that a view shows for a hit: the hit itself, or the node shape of a property shape. Views and predicates have no card. */
function cardOf(h: SearchHit): string | undefined {
    if (h.kind === 'property') return h.owner;
    return h.kind === 'view' || h.kind === 'predicate' ? undefined : h.id;
}

/** The name of a type: its class name (shapes), else the local name of its IRI. rdfs:Resource: "no type". */
const typeName = (meta: Classes, type: string) => type === NS.rdfs + 'Resource' ? 'no type' : classDef(meta, type)?.name ?? localName(type);

/** The type text of a row. */
function typeText(meta: Classes, h: SearchHit): string {
    switch (h.kind) {
        case 'instance': return h.types.map(t => typeName(meta, t)).join(', ') || 'no type';
        case 'shape': return 'node shape';
        case 'property': return 'property shape';
        case 'valueSet': return h.types.includes(NS.skos + 'ConceptScheme') ? 'concept scheme' : 'collection';
        case 'view': return 'view';
        case 'predicate': return 'predicate';
    }
}

@injectable()
export class SearchWidget extends ReactWidget {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(ViewLabels) protected readonly labels: ViewLabels;
    @inject(SelectionModel) protected readonly elements: SelectionModel;
    @inject(ActionService) protected readonly actionService: ActionService;
    @inject(ContextMenuRenderer) protected readonly contextMenu: ContextMenuRenderer;
    @inject(CommandService) protected readonly commands: CommandService;

    protected criteria: SearchFacets = {};
    /** The answer of the backend to the current facets. */
    protected result: SearchResult = { hits: [], more: false, types: [] };
    protected run = 0;
    /** Last clicked row: the other end of a Shift+click range. */
    protected anchor?: string;
    /** The selection when it is one instance: the target of "Linked to". */
    protected only?: { id: string; label: string };

    constructor() {
        super();
        this.id = SEARCH_ID;
        this.title.label = 'Search';
        this.title.caption = 'Search model elements';
        this.title.iconClass = codicon('search');
        this.title.closable = true;
        this.addClass('catenary-search');
        this.node.tabIndex = 0;
    }

    @postConstruct()
    protected init(): void {
        this.toDispose.push(this.model.onDidChange(s => panelsUnchanged(s.change) || this.search()));
        this.toDispose.push(this.editors.onDidChangeCurrentView(() => this.update()));
        this.toDispose.push(this.elements.onDidChange(() => this.update()));
        this.toDispose.push(this.elements.onDidResolve(s => void this.selectedInstance(s.elements.length === 1 ? s.instances[0] : undefined)));
        this.toDispose.push(this.actionService.onDidChange(() => this.update()));
        this.search();
    }

    /** Ask the backend for the hits of the criteria. An instance of "linked to" that is gone removes the criterion. */
    protected async search(): Promise<void> {
        const run = ++this.run;
        const result = await this.model.service.search(this.criteria, LIMIT);
        if (run !== this.run) return;
        if (this.criteria.linkedTo && !result.linked) {
            this.criteria = { ...this.criteria, linkedTo: undefined, predicate: undefined, direction: undefined };
            return this.search();
        }
        this.result = result;
        this.update();
    }

    /** Selected elements of the window (a selected placement: its element), as the backend last resolved them. */
    protected get selected(): Set<string> {
        return new Set(this.elements.resolved.elements);
    }

    protected async selectedInstance(id?: string): Promise<void> {
        const label = id ? (await this.model.service.elementRows([id]))[0]?.label : undefined;
        this.only = id && label !== undefined ? { id, label } : undefined;
        this.update();
    }

    protected set(patch: Partial<SearchFacets>): void {
        this.criteria = { ...this.criteria, ...patch };
        this.update();
        this.search();
    }

    /** A click selects in the window selection, as the Model Explorer. Ctrl toggles, Shift adds a range. */
    protected click(e: React.MouseEvent, id: string, rows: string[]): void {
        const selected = this.selected;
        if (e.shiftKey && this.anchor && rows.includes(this.anchor)) {
            const [a, b] = [rows.indexOf(this.anchor), rows.indexOf(id)].sort((x, y) => x - y);
            rows.slice(a, b + 1).forEach(r => selected.add(r));
        } else if (e.ctrlKey || e.metaKey) {
            if (!selected.delete(id)) selected.add(id);
            this.anchor = id;
        } else {
            selected.clear();
            selected.add(id);
            this.anchor = id;
        }
        // Elements, with no view (spec 0.4): the canvases show their placements; Del has no action on them.
        this.elements.set({ ids: [...selected] });
    }

    protected render(): React.ReactNode {
        const { meta } = this.model;
        const c = this.criteria;
        const { hits: shown, more, types } = this.result;
        const linked = c.linkedTo ? this.result.linked : undefined;
        const rows = shown.map(h => h.id);
        const view = this.editors.currentViewId();
        const label = view ? this.labels.labels[view] : undefined;
        const inCurrent = (h: SearchHit) => !!view && !!h.views?.includes(view);
        const selected = this.selected;
        const chosen = shown.filter(h => selected.has(h.id));
        const only = this.only;
        // "Add to view": the action of the selection (action-commands.ts); the number of the elements the current view does not place.
        const target = this.actionService.selectionTarget();
        const add = this.actionService.state('catenary.addToView', target);
        const addable = add?.enabled ? this.actionService.items(target).filter(i => !i.placedInActive && i.kinds.some(k => ['instance', 'relation', 'shape', 'valueSet'].includes(k))).length : 0;
        return <div className='catenary-search-body'>
            <input className='theia-input' type='search' placeholder='Label, IRI, type, path or value' value={c.text ?? ''} autoFocus
                onChange={e => this.set({ text: e.currentTarget.value })} />
            <select className='theia-select' value={c.type ?? ''} title='Type of the things (the number: with the other facets)'
                onChange={e => this.set({ type: e.currentTarget.value || undefined })}>
                <option value=''>All types</option>
                {c.type && !types.some(t => t.value === c.type) && <option value={c.type}>{typeName(meta, c.type)} (0)</option>}
                {types.map(t => <option key={t.value} value={t.value} title={t.value}>{typeName(meta, t.value)} ({t.count})</option>)}
            </select>
            {!linked && <button className='theia-button secondary' disabled={!only}
                title='Search the instances related to the selected instance'
                onClick={() => only && this.set({ linkedTo: only.id, predicate: undefined, direction: undefined })}>
                {only ? `Linked to "${only.label}"` : 'Linked to the selection (select one instance)'}</button>}
            {linked && <div className='linked'>
                <span className='label' title={linked.iri}>Linked to <b>{linked.label}</b></span>
                <select className='theia-select' value={c.direction ? `${c.direction} ${c.predicate}` : ''}
                    onChange={e => {
                        const [direction, predicate] = e.currentTarget.value.split(' ');
                        this.set(direction ? { direction: direction as 'out' | 'in', predicate } : { direction: undefined, predicate: undefined });
                    }}>
                    <option value=''>any relation</option>
                    {linked.links.map(({ value: { direction, predicate }, count }) =>
                        <option key={`${direction} ${predicate}`} value={`${direction} ${predicate}`}>
                            {direction === 'out' ? `${predicateName(meta, predicate)} →` : `← ${predicateName(meta, predicate)}`} ({count})</option>)}
                </select>
                <span className={codicon('close', true)} title='Remove this criterion'
                    onClick={() => this.set({ linkedTo: undefined, predicate: undefined, direction: undefined })} />
            </div>}
            <div className='summary'>
                <span>{shown.length}{more ? '+' : ''} {shown.length === 1 && !more ? 'element' : 'elements'}{more ? ` (first ${LIMIT})` : ''}</span>
                <button className='theia-button secondary' disabled={!add?.enabled}
                    title={add?.reason ?? (view ? `Add the selected elements to "${label}"` : 'Open a view')}
                    onClick={() => this.commands.executeCommand('catenary.addToView')}>Add to view{addable ? ` (${addable})` : ''}</button>
            </div>
            <div className='results'>
                {shown.map(h => <div key={h.id} draggable
                    className={`row${selected.has(h.id) ? ' selected' : ''}`}
                    title={h.iri}
                    onClick={e => this.click(e, h.id, rows)}
                    onDoubleClick={() => this.editors.show(h.id)}
                    onContextMenu={e => this.menu(e, h.id, rows)}
                    onDragStart={e => this.drag(e, h, selected.has(h.id) ? chosen : [h])}>
                    <span className='name'>{h.label}</span>
                    <span className='class'>{typeText(meta, h)}</span>
                    {inCurrent(h) && <span className={codicon('eye', true)} title='In the current view' />}
                </div>)}
            </div>
        </div>;
    }

    /**
     * Drag data of the dragged row and the selected rows. A view: a reference to it. Else the cards of the selected instances, node
     * shapes, value sets and property shapes (their node shape). Predicates have no card.
     */
    protected drag(e: React.DragEvent, h: SearchHit, hits: SearchHit[]): void {
        if (h.kind === 'view') e.dataTransfer.setData(DND_VIEW, h.id);
        else e.dataTransfer.setData(DND_INSTANCES, [...new Set(hits.map(cardOf).filter(Boolean))].join('\n'));
        e.dataTransfer.effectAllowed = 'copy';
    }

    /** Right click: the row joins the selection if it is not in it; the actions of the selection, after their answer arrived. */
    protected async menu(e: React.MouseEvent, id: string, rows: string[]): Promise<void> {
        e.preventDefault();
        e.stopPropagation();
        if (!this.selected.has(id)) this.click(e, id, rows);
        const anchor = { x: e.clientX, y: e.clientY };
        await whenActionsKnown(this.actionService, this.actionService.selectionTarget());
        this.contextMenu.render({ menuPath: SEARCH_CONTEXT_MENU, anchor, context: this.node });
    }
}

@injectable()
export class SearchContribution extends AbstractViewContribution<SearchWidget> {
    constructor() {
        super({
            widgetId: SEARCH_ID, widgetName: 'Search',
            defaultWidgetOptions: { area: 'left', rank: 160 },
            toggleCommandId: 'catenary.toggleSearch'
        });
    }
}
