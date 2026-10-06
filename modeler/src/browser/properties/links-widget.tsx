// Links of the selected elements, of any kind: the views that show them, and the statements of the model and shapes graphs from and
// to them (one SPARQL query in the backend, `ModelService.links`; labels, kinds and relations come with it, ADR 0007).
// Theia tree: context menu with the actions of the row (action-commands.ts: a relation row acts on the relation, an end row on the
// element, a view row on the placements in that view), F2 and Ctrl+Del on the row (spec 0.4: no Del), Enter or double-click (go to).

import { Command, CommandContribution, CommandRegistry, CommandService, MenuContribution, MenuModelRegistry, MenuPath } from '@theia/core';
import {
    AbstractViewContribution, ApplicationShell, CompositeTreeNode, ContextMenuRenderer, ExpandableTreeNode, KeybindingContext, KeybindingContribution,
    KeybindingRegistry, NodeProps, SelectableTreeNode, TreeModel, TreeNode, TreeProps, TreeWidget, codicon
} from '@theia/core/lib/browser';
import { TabBarToolbarContribution, TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { ActionTarget, LinkElement, SelectionLinks, panelsUnchanged } from '@catenary/model';
import { ActionService, whenActionsKnown } from '../action-service';
import { ModelActions } from '../actions';
import { ViewEditors } from '../diagram/view-editors';
import { ModelFrontend } from '../model-client';
import { addMenuItems } from '../menus';
import { Head } from './controls';
import { SelectionModel } from '../selection-model';

export const LINKS_ID = 'catenary-links';
export const LINKS_CONTEXT_MENU: MenuPath = ['catenary-links-context'];

/** Not a CatenaryNode (no `kind`/`key`): a selection in this tree does not change the selected element. */
export interface LinkNode extends SelectableTreeNode {
    /** 'head': first row, the class and the name of the element. */
    link: 'head' | 'folder' | 'view' | 'out' | 'in' | 'end';
    /** Selected elements that the node is about. */
    elements: string[];
    /** View of a 'view' node. */
    view?: string;
    /** Relation (a statement between two instances) of an 'out' or 'in' node. */
    relation?: string;
    /** Element at the other end: 'out', 'in' and 'end' nodes. Undefined: the other end is not an element. */
    target?: string;
    description?: string;
    muted?: boolean;
    tooltip?: string;
}
export namespace LinkNode {
    export function is(node: unknown): node is LinkNode {
        return !!node && typeof node === 'object' && 'link' in node && SelectableTreeNode.is(node as unknown as TreeNode);
    }
}
type LinkFolder = LinkNode & ExpandableTreeNode;

@injectable()
export class LinksWidget extends TreeWidget {
    @inject(ModelFrontend) protected readonly modelFrontend: ModelFrontend;
    @inject(SelectionModel) protected readonly elements: SelectionModel;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(ActionService) protected readonly actionService: ActionService;

    constructor(
        @inject(TreeProps) props: TreeProps,
        @inject(TreeModel) model: TreeModel,
        @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer
    ) {
        super(props, model, contextMenuRenderer);
        this.id = LINKS_ID;
        this.title.label = 'Links';
        this.title.caption = 'Views and relations of the selected element';
        this.title.iconClass = codicon('references');
        this.title.closable = true;
        this.addClass('catenary-links');
    }

    @postConstruct()
    protected override init(): void {
        super.init();
        this.toDispose.push(this.modelFrontend.onDidChange(s => panelsUnchanged(s.change) || this.rebuild()));
        this.toDispose.push(this.elements.onDidChange(() => this.rebuild()));
        this.toDispose.push(this.editors.onDidChangeCurrentView(() => this.rebuild()));
        this.toDispose.push(this.model.onSelectionChanged(nodes => {
            const n = nodes[0];
            if (nodes.length === 1 && LinkNode.is(n) && this.shell.activeWidget === this) this.selectInView(n);
        }));
        this.rebuild();
    }

    get selectedLinks(): LinkNode[] {
        return this.model.selectedNodes.filter(LinkNode.is);
    }

    /** The selected elements (any kind), as the last answer of the backend gives them. */
    subject(): LinkElement[] {
        return this.modelFrontend.isOpen ? this.links.elements : [];
    }


    protected links: SelectionLinks = EMPTY;
    protected request = 0;

    /** Query the links of the selection, then build the tree. A result of an older request is dropped. */
    protected async rebuild(): Promise<void> {
        const { ids, view } = this.elements.selection;
        const n = ++this.request;
        const links = this.modelFrontend.isOpen && ids.length ? await this.modelFrontend.service.links([...ids], view).catch(() => EMPTY) : EMPTY;
        if (n !== this.request) return;
        this.links = links;
        this.build();
    }

    protected build(): void {
        const old = new Map<string, TreeNode>();
        const walk = (n: TreeNode) => {
            old.set(n.id, n);
            if (CompositeTreeNode.is(n)) n.children.forEach(walk);
        };
        if (this.model.root) walk(this.model.root);
        const root: CompositeTreeNode = { id: 'catenary-links-root', name: 'Links', parent: undefined, children: [], visible: false };
        const add = <T extends LinkNode>(parent: CompositeTreeNode, node: Omit<T, 'parent' | 'selected'>): T => {
            const prev = old.get(node.id) as LinkNode | undefined;
            const n = { ...node, parent, selected: prev?.selected ?? false } as unknown as T;
            if (ExpandableTreeNode.is(prev) && ExpandableTreeNode.is(n)) n.expanded = prev.expanded;
            (parent.children as TreeNode[]).push(n);
            return n;
        };
        const folder = (id: string, name: string, elements: string[], count: number) =>
            add<LinkFolder>(root, { id, name, link: 'folder', elements, description: String(count), children: [], expanded: true });

        const elements = this.subject();
        const ids = elements.map(e => e.id);
        const current = this.editors.currentViewId();
        const labels = new Map(elements.map(e => [e.id, e.label]));
        const many = ids.length > 1;
        const views3 = 'F3: show in the next view, Shift+F3: in the previous view.';
        if (!ids.length) {
            this.model.root = root;
            return;
        }
        // Several elements: the kind name of the first element of each kind.
        add(root, {
            id: 'head', name: many ? `${ids.length} elements` : elements[0].label, link: 'head', elements: ids,
            description: elements.filter((e, i) => elements.findIndex(x => x.kind === e.kind) === i).map(e => e.kindName).join(', ')
        });

        // Views: one row for each view, with the selected elements that it shows.
        const byView = new Map<string, { label: string; elements: string[]; hidden: number }>();
        for (const v of this.links.views) {
            const e = byView.get(v.view) ?? { label: v.label, elements: [], hidden: 0 };
            e.elements.push(v.element);
            if (v.hidden) e.hidden++;
            byView.set(v.view, e);
        }
        const viewRows = [...byView].sort(([, a], [, b]) => a.label.localeCompare(b.label));
        const vf = folder('views', 'Views', ids, viewRows.length);
        vf.tooltip = views3;
        for (const [id, { label, elements, hidden }] of viewRows) {
            const allHidden = hidden === elements.length;
            add(vf, {
                id: `view:${id}`, name: label, link: 'view', elements, view: id, muted: allHidden, tooltip: views3,
                description: [id === current ? 'current' : '', many ? `${elements.length} of ${ids.length}` : '', allHidden ? 'hidden' : ''].filter(x => x).join(', ') || undefined
            });
        }

        // Outgoing and incoming: one row for each (predicate, other end), with the selected elements that have it.
        for (const dir of ['out', 'in'] as const) {
            const rows = new Map<string, LinkNode & { predicateName: string }>();
            for (const r of this.links.rows.filter(x => x.dir === dir)) {
                const target = r.id;
                const key = `${r.predicate} ${target ?? r.iri ?? `_${rows.size}`}`;
                const prev = rows.get(key);
                if (prev) { prev.elements.push(r.element); continue; }
                const unknown = !!r.undeclared;
                rows.set(key, {
                    id: `${dir}:${key}`, name: r.name, link: dir, elements: [r.element],
                    relation: r.relation, target, predicateName: r.predicateName, muted: unknown || !target,
                    tooltip: `${r.predicate}${r.iri ? `\n${r.iri}` : ''}${unknown ? '\nNot declared in the shapes of this class.' : ''}${target ? '' : '\nNot an element of the model.'}`
                } as LinkNode & { predicateName: string });
            }
            const list = [...rows.values()].map(n => ({
                ...n, description: [n.predicateName, many ? (n.elements.length > 1 ? `${n.elements.length} of ${ids.length}` : `${dir === 'out' ? 'from' : 'to'} ${labels.get(n.elements[0])}`) : ''].filter(x => x).join(' · ')
            })).sort((a, b) => a.description!.localeCompare(b.description!) || (a.name ?? '').localeCompare(b.name ?? ''));
            const f = folder(dir, dir === 'out' ? 'Outgoing' : 'Incoming', ids, list.length);
            list.forEach(n => add(f, n));
        }

        // Ends of the selected relations.
        const relations = elements.filter(e => e.ends);
        if (relations.length) {
            const ends = relations.flatMap(({ id, label, ends: x }) => [['from', x!.subject, x!.subjectLabel, id, label], ['to', x!.object, x!.objectLabel, id, label]] as const);
            const ef = folder('ends', 'Ends', relations.map(e => e.id), ends.length);
            for (const [side, target, name, id, label] of ends) {
                add(ef, { id: `end:${side}:${id}`, name, link: 'end', elements: [id], target, description: many ? `${side} · ${label}` : side });
            }
        }
        this.model.root = root;
    }

    /**
     * A click on a 'view' node selects the element in that view and shows its editor, if it is open.
     * Other nodes do not change the selection: this tree is about the selected element. "Show Relation Properties" selects a relation.
     */
    protected selectInView(n: LinkNode): void {
        if (n.link !== 'view' || !n.view) return;
        const w = this.editors.find(n.view);
        if (w) this.shell.revealWidget(w.id);
        this.elements.set({ view: n.view, ids: n.elements });
    }

    /** Enter or double-click: open the view and center the element, or go to the element at the other end (head: the element). */
    async open(n: LinkNode): Promise<void> {
        if (n.link === 'head') { if (n.elements.length === 1) await this.editors.show(n.elements[0]); }
        else if (n.link === 'view' && n.view) await this.editors.reveal(n.view, n.elements);
        else if (n.target) await this.editors.show(n.target);
    }

    protected override handleDblClickEvent(node: TreeNode | undefined, event: React.MouseEvent<HTMLElement>): void {
        if (LinkNode.is(node) && node.link !== 'folder') {
            this.open(node);
            event.stopPropagation();
        } else {
            super.handleDblClickEvent(node, event);
        }
    }

    protected override handleEnter(event: KeyboardEvent): void {
        const node = this.model.getFocusedNode();
        if (LinkNode.is(node) && node.link !== 'folder') this.open(node);
        else super.handleEnter(event);
    }

    /**
     * The target of the actions on a row: a view row its placements in that view; a statement row its relation, else the element at
     * the other end; the head the elements of the panel (no view). A folder: nothing. Never the window selection (it can be a canvas).
     */
    rowTarget(n: TreeNode | undefined): ActionTarget | undefined {
        if (!LinkNode.is(n)) return undefined;
        if (n.link === 'view' && n.view) return { view: n.view, ids: n.elements };
        if (n.link === 'out' || n.link === 'in') return { ids: n.relation ? [n.relation] : n.target ? [n.target] : [] };
        if (n.link === 'end') return { ids: n.target ? [n.target] : [] };
        if (n.link === 'head') return { ids: n.elements };
        return { ids: [] };
    }

    /** The row under the focus (keys). */
    focusedTarget(): ActionTarget | undefined {
        return this.rowTarget(this.model.getFocusedNode());
    }

    protected override toContextMenuArgs(node: SelectableTreeNode): ActionTarget[] | undefined {
        const t = this.rowTarget(node);
        return t ? [t] : undefined;
    }

    /** As the base class, but the menu opens after the actions of the row are known (action-menus.ts). */
    protected override handleContextMenuEvent(node: TreeNode | undefined, event: React.MouseEvent<HTMLElement>): void {
        const menuPath = this.props.contextMenuPath;
        if (!SelectableTreeNode.is(node) || !menuPath) return super.handleContextMenuEvent(node, event);
        this.model.selectNode(node);
        this.focusService.setFocus(node);
        const { x, y } = event.nativeEvent;
        const context = event.currentTarget;
        const args = this.toContextMenuArgs(node);
        event.stopPropagation();
        event.preventDefault();
        void whenActionsKnown(this.actionService, this.actionService.targetOf(args?.[0]))
            .then(() => this.contextMenuRenderer.render({ menuPath, context, anchor: { x, y }, args }));
    }

    protected override renderIcon(node: TreeNode, _props: NodeProps): React.ReactNode {
        if (!LinkNode.is(node) || node.link === 'head') return undefined;
        const icon = node.link === 'view' ? 'type-hierarchy' : node.link === 'out' ? 'arrow-right' : node.link === 'in' ? 'arrow-left'
            : node.link === 'end' ? 'symbol-object' : node.id === 'views' ? 'layers' : node.id === 'in' ? 'arrow-left' : node.id === 'out' ? 'arrow-right' : 'references';
        return <span className={`${codicon(icon)} catenary-tree-icon`} />;
    }

    protected override renderCaption(node: TreeNode, props: NodeProps): React.ReactNode {
        if (!LinkNode.is(node)) return super.renderCaption(node, props);
        if (node.link === 'head') return <Head kind={node.description ?? ''} title={node.name ?? ''} />;
        const cls = ['catenary-tree-caption', node.muted ? 'muted' : '', node.link === 'folder' ? 'folder' : ''].join(' ');
        return <span className={cls} title={node.tooltip}>
            {node.name}
            {node.description ? <span className={node.link === 'folder' ? 'catenary-tree-badge' : 'catenary-tree-description'}>{node.description}</span> : undefined}
            {node.muted && node.link !== 'view' ? <span className='codicon codicon-warning catenary-tree-warning' /> : undefined}
        </span>;
    }

    protected override renderTree(model: TreeModel): React.ReactNode {
        if (!this.modelFrontend.isOpen) return <div className='theia-widget-noInfo'>No model is open.</div>;
        if (!this.subject().length) return <div className='theia-widget-noInfo'>Select one or more elements.</div>;
        return super.renderTree(model);
    }
}

// ------------------------------------------------------------------ commands, menus, keys

const cmd = (id: string, label: string, iconClass?: string): Command => ({ id, label, category: 'Links', iconClass });
export namespace LinksCommands {
    export const GO_TO = cmd('catenary.links.goTo', 'Go To');
    export const SELECT_RELATION = cmd('catenary.links.selectRelation', 'Show Relation Properties');
    /** Keys on the focused row: the shared action with the row as its target (spec 0.4: F2 rename, Ctrl+Del delete; no Del). */
    export const RENAME_ROW = { id: 'catenary.links.renameRow' };
    export const DELETE_ROW = { id: 'catenary.links.deleteRow' };
}

const LINKS_NAVIGATE = [...LINKS_CONTEXT_MENU, '0_navigate'];

/** True when the Links view has the focus. */
@injectable()
export class LinksFocusContext implements KeybindingContext {
    static readonly ID = 'catenary.linksFocus';
    readonly id = LinksFocusContext.ID;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    isEnabled(): boolean {
        return this.shell.activeWidget instanceof LinksWidget;
    }
}

@injectable()
export class LinksContribution extends AbstractViewContribution<LinksWidget>
    implements CommandContribution, MenuContribution, KeybindingContribution, TabBarToolbarContribution {

    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(ModelActions) protected readonly actions: ModelActions;
    @inject(SelectionModel) protected readonly elements: SelectionModel;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(CommandService) protected readonly commands: CommandService;

    constructor() {
        super({
            widgetId: LINKS_ID, widgetName: 'Links',
            defaultWidgetOptions: { area: 'right', rank: 300 },
            toggleCommandId: 'catenary.toggleLinks'
        });
    }

    protected nodes(): LinkNode[] {
        return this.tryGetWidget()?.selectedLinks ?? [];
    }

    protected relations(): string[] {
        return [...new Set(this.nodes().map(n => n.relation).filter((r): r is string => !!r))];
    }

    override registerCommands(registry: CommandRegistry): void {
        super.registerCommands(registry);
        const one = () => this.nodes().length === 1 ? this.nodes()[0] : undefined;
        registry.registerCommand(LinksCommands.GO_TO, {
            execute: () => { const n = one(); if (n) this.tryGetWidget()?.open(n); },
            isVisible: () => !!one() && one()!.link !== 'folder'
        });
        registry.registerCommand(LinksCommands.SELECT_RELATION, {
            execute: () => this.elements.set({ ids: this.relations() }),
            isVisible: () => this.relations().length > 0
        });
        // The keys run the shared actions on the focused row (its target), as the context menu does.
        const onRow = (id: string) => ({
            execute: () => { const t = this.tryGetWidget()?.focusedTarget(); if (t) return this.commands.executeCommand(id, t); },
            isEnabled: () => !!this.tryGetWidget()?.focusedTarget()?.ids.length
        });
        registry.registerCommand(LinksCommands.RENAME_ROW, onRow('catenary.rename'));
        registry.registerCommand(LinksCommands.DELETE_ROW, onRow('catenary.deleteFromModel'));
    }

    override registerMenus(menus: MenuModelRegistry): void {
        super.registerMenus(menus);
        // The actions of the row: action-commands.ts (groups 1_open, 2_edit, 3_delete).
        addMenuItems(menus, LINKS_NAVIGATE, LinksCommands.GO_TO.id, LinksCommands.SELECT_RELATION.id);
    }

    override registerKeybindings(keybindings: KeybindingRegistry): void {
        super.registerKeybindings(keybindings);
        keybindings.registerKeybinding({ command: LinksCommands.RENAME_ROW.id, keybinding: 'f2', context: LinksFocusContext.ID });
        keybindings.registerKeybinding({ command: LinksCommands.DELETE_ROW.id, keybinding: 'ctrlcmd+delete', context: LinksFocusContext.ID });
    }

    registerToolbarItems(toolbar: TabBarToolbarRegistry): void {
        // The shared action, on the selection (the subject of Links).
        toolbar.registerItem({
            id: 'catenary.links.addToView', command: 'catenary.addToView', tooltip: 'Add to the current view', priority: 0, icon: codicon('add'),
            isVisible: (w?: unknown) => w instanceof LinksWidget
        } as never);
    }
}

const EMPTY: SelectionLinks = { elements: [], views: [], rows: [] };
