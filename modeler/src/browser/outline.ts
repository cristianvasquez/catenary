// Outline of the current view editor: groups with the groups and cards inside them, and for each card the relations
// that the view shows. Select a node: select the element. Open (double-click, Enter): select and center it. The nodes of the
// selected elements are shown selected. A group node selects the group and the groups and cards inside it, as on the canvas.
// Context menu: the actions of the canvas (action-commands.ts) on the selected nodes. The tree is a backend query of the view
// graph (ModelService.outline, ADR 0007); this class keeps the expansion state only.

import { GLSPDiagramWidget } from '@eclipse-glsp/theia-integration';
import { MenuPath } from '@theia/core';
import { ApplicationShell, ContextMenuRenderer, FrontendApplicationContribution, SelectableTreeNode, TreeNode, TreeProps } from '@theia/core/lib/browser';
import * as React from '@theia/core/shared/react';
import { inject, injectable } from '@theia/core/shared/inversify';
import { OutlineViewService } from '@theia/outline-view/lib/browser/outline-view-service';
import { OutlineViewTreeModel } from '@theia/outline-view/lib/browser/outline-view-tree-model';
import { OutlineSymbolInformationNode, OutlineViewWidget } from '@theia/outline-view/lib/browser/outline-view-widget';
import { ActionTarget, OutlineKind, OutlineNode, panelsUnchanged } from '@catenary/model';
import { VIEW_SCHEME } from '../common/protocol';
import { ActionService, whenActionsKnown } from './action-service';
import { ViewEditors } from './diagram/view-editors';
import { ModelFrontend } from './model-client';
import { SelectionModel } from './selection-model';

/** Context menu of the Outline: the actions (action-commands.ts). */
export const OUTLINE_CONTEXT_MENU: MenuPath = ['catenary-outline-context'];

export interface ViewOutlineNode extends OutlineSymbolInformationNode {
    catenaryView: string;
    kind: OutlineKind;
    /** Diagram element id: instance, relation or group id. */
    element: string;
}
export namespace ViewOutlineNode {
    export function is(node: unknown): node is ViewOutlineNode {
        return OutlineSymbolInformationNode.is(node as never) && 'catenaryView' in (node as object) && 'element' in (node as object);
    }

    /** The selection of nodes of one view: each node's element; a group also gives the groups and cards inside it. */
    export function target(nodes: readonly unknown[]): ActionTarget | undefined {
        const rows = nodes.filter(is);
        if (!rows.length) return undefined;
        const view = rows[0].catenaryView;
        const ids: string[] = [];
        const add = (n: ViewOutlineNode) => {
            ids.push(n.element);
            if (n.kind === 'group') for (const c of n.children) if (is(c) && c.kind !== 'out' && c.kind !== 'in') add(c);
        };
        rows.filter(n => n.catenaryView === view).forEach(add);
        return { view, ids: [...new Set(ids)] };
    }
}

/** The Outline widget with the context menu of the actions. Rows of a text editor outline have no menu. */
@injectable()
export class ViewOutlineWidget extends OutlineViewWidget {
    @inject(ActionService) protected readonly actionService: ActionService;

    constructor(
        @inject(TreeProps) props: TreeProps,
        @inject(OutlineViewTreeModel) model: OutlineViewTreeModel,
        @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer
    ) {
        super(props, model, contextMenuRenderer);
    }

    /** The target of the selected rows. */
    selectedTarget(): ActionTarget | undefined {
        return ViewOutlineNode.target(this.model.selectedNodes);
    }

    protected override toContextMenuArgs(_node: SelectableTreeNode): ActionTarget[] | undefined {
        const t = this.selectedTarget();
        return t ? [t] : undefined;
    }

    /** As the Model explorer: select the row (if not selected), then open the menu after the actions of the target are known. */
    protected override handleContextMenuEvent(node: TreeNode | undefined, event: React.MouseEvent<HTMLElement>): void {
        const menuPath = this.props.contextMenuPath;
        event.stopPropagation();
        event.preventDefault();
        if (!ViewOutlineNode.is(node) || !menuPath) return;
        if (!node.selected) this.model.selectNode(node);
        this.focusService.setFocus(node);
        const { x, y } = event.nativeEvent;
        const context = event.currentTarget;
        const args = this.toContextMenuArgs(node);
        if (!args) return;
        void whenActionsKnown(this.actionService, this.actionService.targetOf(args[0]))
            .then(() => this.contextMenuRenderer.render({ menuPath, context, anchor: { x, y }, args }));
    }
}

@injectable()
export class ViewOutline implements FrontendApplicationContribution {
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(OutlineViewService) protected readonly outline: OutlineViewService;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(SelectionModel) protected readonly selection: SelectionModel;

    /** Nodes of the last publish, by id. The outline tree changes their `expanded` state in place. */
    protected published = new Map<string, ViewOutlineNode>();

    onStart(): void {
        this.shell.onDidChangeCurrentWidget(() => this.update());
        this.shell.onDidChangeActiveWidget(() => this.update());
        // The outline shows the containment of boxes in groups: a move in the current view changes it, a write does not.
        this.model.onDidChange(s => s.change?.reason === 'save' || (panelsUnchanged(s.change) && !s.change?.views?.includes(this.editors.currentViewId() ?? '')) || this.update());
        this.selection.onDidChange(() => this.update());
        this.outline.onDidChangeOpenState(open => open && this.update());
        this.outline.onDidSelect(() => this.select());
        this.outline.onDidOpen(node => this.open(node));
    }

    protected get widget(): ViewOutlineWidget | undefined {
        const w = (this.outline as unknown as { widget?: unknown }).widget;
        return w instanceof ViewOutlineWidget ? w : undefined;
    }

    /** The selected rows give the window selection. Only a click in the outline: a publish also changes the tree selection. */
    protected select(): void {
        if (this.shell.activeWidget?.id !== this.outline.id) return;
        const t = this.widget?.selectedTarget();
        if (t) this.selection.set(t);
    }

    protected open(node: OutlineSymbolInformationNode): void {
        if (!ViewOutlineNode.is(node)) return;
        void this.editors.reveal(node.catenaryView, ViewOutlineNode.target([node])!.ids);
    }

    /** Number of the last request: an older answer is dropped. */
    protected request = 0;

    protected async update(): Promise<void> {
        if (!this.outline.open) return;
        const active = this.shell.activeWidget ?? this.shell.currentWidget;
        // Another editor (for example a text editor) owns the outline while it is active.
        if (active && this.isEditor(active) && !(active instanceof GLSPDiagramWidget && active.uri.scheme === VIEW_SCHEME)) return;
        const viewId = this.editors.currentViewId();
        const request = ++this.request;
        let tree: OutlineNode[] = [];
        if (viewId && this.model.isOpen) {
            try {
                tree = await this.model.service.outline(viewId, this.selection.selection);
            } catch (e) {
                console.error('[catenary] outline', e);
            }
        }
        if (request !== this.request) return;
        const roots = viewId ? this.build(viewId, tree) : [];
        if (!roots.length && !this.published.size) return;
        const next = new Map<string, ViewOutlineNode>();
        const walk = (nodes: ViewOutlineNode[]) => nodes.forEach(n => { next.set(n.id, n); walk(n.children as ViewOutlineNode[]); });
        walk(roots);
        this.published = next;
        this.outline.publish(roots);
    }

    protected isEditor(w: object): boolean {
        return 'editor' in w || w instanceof GLSPDiagramWidget;
    }

    /** Outline nodes of the backend tree, with the expansion state of the last publish. */
    protected build(viewId: string, tree: OutlineNode[]): ViewOutlineNode[] {
        // `icon` is the suffix of the outline widget's `codicon-symbol-<icon>` class.
        const icons = { group: 'folder', card: 'object', out: 'catenary-outline-rel codicon-arrow-right', in: 'catenary-outline-rel codicon-arrow-left' };
        const convert = (n: OutlineNode, parent: ViewOutlineNode | undefined): ViewOutlineNode => {
            const id = n.kind === 'group' ? `${viewId}/group/${n.key}` : n.kind === 'card' ? `${viewId}/${parent?.element ?? ''}/${n.key}` : `${parent!.id}/${n.kind}/${n.key}`;
            const old = this.published.get(id);
            const node: ViewOutlineNode = {
                id, name: n.name, iconClass: icons[n.kind], catenaryView: viewId, kind: n.kind, element: n.element, parent: parent as never, children: [],
                selected: n.selected, expanded: old ? old.expanded : n.kind === 'group'
            };
            node.children = n.children.map(c => convert(c, node));
            return node;
        };
        return tree.map(n => convert(n, undefined));
    }
}
