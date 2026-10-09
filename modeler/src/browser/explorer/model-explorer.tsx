// Each file Model pane (ADR 0006): every folder is a SPARQL query of the backend, run when the folder opens or
// refreshes. Top: one folder per type of every graph, No class, Relations (by predicate), Concepts (schemes, broader concepts).
// It shows and sets the selection of the window (SelectionModel). The files: the Theia file navigator (ADR 0004).

import { CancellationToken, Emitter, MenuPath, QuickInputService } from '@theia/core';
import {
    ApplicationShell, CompositeTreeNode, ContextMenuRenderer, ExpandableTreeNode, NodeProps, Saveable, SaveableSource, SelectableTreeNode,
    Tree, TreeImpl, TreeModel, TreeNode, TreeProps, TreeSelection, TreeWidget, codicon
} from '@theia/core/lib/browser';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { ActionTarget, ExplorerKind, ExplorerRow, EXPLORER_DRAG, ExplorerDrag, fuzzyMatch, baseName, classKey, iriId, panelsUnchanged } from '@catenary/model';
import { ActionService, whenActionsKnown } from '../action-service';
import { ViewEditors } from '../diagram/view-editors';
import { colorValue } from '../diagram/views';
import { ModelActions } from '../actions';
import { ModelFrontend } from '../model-client';
import { SelectionModel, sameIds } from '../selection-model';

export const FILE_EXPLORER_ID = 'catenary-file-explorer';
/** Prefix of the key of a class folder (packages/model/src/explorer.ts `classKey`). */
const CLASS_KEY = classKey('');
/** Context menu of the explorers: each command shows when it applies to the selected nodes. */
export const EXPLORER_CONTEXT_MENU: MenuPath = ['catenary-model-explorer-context'];

/** Kinds of rows of the Model explorer (ExplorerRow.kind). */
export type CatenaryKind = ExplorerKind;

/** A row of the Model explorer: an ExplorerRow of the backend as a tree node. */
export interface CatenaryNode extends SelectableTreeNode, Omit<ExplorerRow, 'folder' | 'name' | 'description' | 'icon'> {
    error?: string;
    /** Codicon name (ExplorerRow.icon). */
    icon?: string;
    /** Short text after the name (ExplorerRow.description). */
    description?: string;
}
export type CatenaryFolder = CatenaryNode & ExpandableTreeNode;

export namespace CatenaryNode {
    export function is(node: unknown): node is CatenaryNode {
        return !!node && typeof node === 'object' && 'kind' in node && 'key' in node && SelectableTreeNode.is(node as unknown as TreeNode);
    }
    /** Element ids of the rows of one kind. */
    export function ids(nodes: readonly unknown[], kind: CatenaryKind): string[] {
        return [...new Set(nodes.filter(isElement).filter(n => n.kind === kind).map(elementId))];
    }
    /** A row of an element: it can be the selection of the model. Every row of a resource is one. */
    export function isElement(node: unknown): node is CatenaryNode {
        return is(node) && !!node.element;
    }
    /** The element id of an element row. */
    export function elementId(node: CatenaryNode): string {
        return node.element ?? node.key;
    }
}

/**
 * The tree of the backend rules (ADR 0006): the children of a node are `explorerChildren(key)`. Node ids are the path of keys
 * ('folder:<top key>/<key>/…'), stable over refreshes, so expansion and selection survive.
 */
@injectable()
export class ModelTree extends TreeImpl {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    file?: string;
    filter = '';
    protected beforeFilter = new Map<string, boolean>();

    setFilter(filter: string): void {
        const visit = (node: TreeNode) => {
            if (ExpandableTreeNode.is(node)) {
                if (!this.filter) this.beforeFilter.set(node.id, node.expanded);
                else if (!filter) node.expanded = this.beforeFilter.get(node.id) ?? false;
            }
            if (CompositeTreeNode.is(node)) node.children.forEach(visit);
        };
        if (!this.filter) this.beforeFilter.clear();
        if (this.root) visit(this.root);
        this.filter = filter;
    }

    override async resolveChildren(parent: CompositeTreeNode): Promise<TreeNode[]> {
        const top = parent.id === 'catenary-root';
        if (CatenaryNode.is(parent)) for (let ancestor = parent.parent; ancestor; ancestor = ancestor.parent) {
            if (CatenaryNode.is(ancestor) && ancestor.key === parent.key) return [];
        }
        if (top && !this.model.isOpen) return [];
        let rows: ExplorerRow[];
        try {
            const file = this.file, filter = this.filter;
            rows = await this.model.service.explorerChildren(top ? undefined : (parent as unknown as CatenaryNode).key, this.editors.currentViewId(), file, filter);
            if (file !== this.file || filter !== this.filter) return this.resolveChildren(parent);
        } catch (e) {
            console.error('[catenary] explorer', e);
            return [];
        }
        return rows.map(({ folder, color, ...row }) => {
            const node: CatenaryNode = { ...row, id: (top ? 'folder:' : parent.id + '/') + row.key, parent, selected: false, color: color && colorValue(color) };
            const result = this.keep(folder ? { ...node, children: [], expanded: false } as CatenaryFolder : node);
            if (this.filter && ExpandableTreeNode.is(result)) result.expanded = true;
            return result;
        });
    }

    /**
     * Expansion and selection by node id, taken before each refresh: a refresh removes the old nodes of a folder before it resolves
     * the open folders inside it again, so `getNode` alone loses the state of nested open folders.
     */
    protected readonly state = new Map<string, { expanded?: boolean; selected: boolean }>();

    override async refresh(raw?: CompositeTreeNode, cancellationToken?: CancellationToken): Promise<CompositeTreeNode | undefined> {
        const visit = (n: TreeNode) => {
            if (CatenaryNode.is(n)) this.state.set(n.id, { expanded: ExpandableTreeNode.is(n) ? n.expanded : undefined, selected: n.selected });
            if (CompositeTreeNode.is(n)) n.children.forEach(visit);
        };
        const from = raw ?? this.root;
        if (from) visit(from);
        return super.refresh(raw, cancellationToken);
    }

    /** Selection and expansion of the node with the same id before the refresh. */
    protected keep<T extends CatenaryNode>(node: T): T {
        const old = this.getNode(node.id) as CatenaryNode | undefined;
        const state = old ? { expanded: ExpandableTreeNode.is(old) ? old.expanded : undefined, selected: old.selected } : this.state.get(node.id);
        if (state) {
            node.selected = state.selected;
            if (ExpandableTreeNode.is(node) && state.expanded !== undefined) node.expanded = state.expanded;
        }
        return node;
    }
}

class ModelSaveable implements Saveable {
    readonly onDirtyChangedEmitter = new Emitter<void>();
    readonly onDirtyChanged = this.onDirtyChangedEmitter.event;
    readonly onContentChangedEmitter = new Emitter<void>();
    readonly onContentChanged = this.onContentChangedEmitter.event;
    constructor(protected readonly model: ModelFrontend) {}
    get dirty(): boolean { return this.model.snapshot.dirty; }
    async save(): Promise<void> { await this.model.report(this.model.service.save()); }
}

/** A file Model document with shared selection, filtering and resource navigation. */
@injectable()
export class ModelExplorerWidget extends TreeWidget implements SaveableSource {
    @inject(ModelFrontend) protected readonly modelFrontend: ModelFrontend;
    @inject(Tree) protected readonly modelTree: ModelTree;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(SelectionModel) protected readonly elements: SelectionModel;
    @inject(ModelActions) protected readonly actions: ModelActions;
    @inject(QuickInputService) protected readonly quick: QuickInputService;
    @inject(ActionService) protected readonly actionService: ActionService;
    readonly saveable: ModelSaveable;
    /** True while the tree shows the SelectionModel: that tree selection change is not a user gesture. */
    protected applying = false;

    constructor(
        @inject(TreeProps) props: TreeProps,
        @inject(TreeModel) model: TreeModel,
        @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer
    ) {
        super(props, model, contextMenuRenderer);
        this.title.closable = true;
        this.addClass('catenary-explorer');
    }

    protected filterTimer?: ReturnType<typeof setTimeout>;
    protected filterInput: HTMLInputElement | null = null;

    protected filterChanged(value: string): void {
        this.modelTree.setFilter(value);
        this.update();
        clearTimeout(this.filterTimer);
        this.filterTimer = setTimeout(() => { if (!this.isDisposed) void this.model.refresh(); }, 120);
    }

    /** Typing on a row and typing in the input use the same filter, including unloaded descendants. */
    protected typeToFilter(event: KeyboardEvent): void {
        if (!this.modelFrontend.isOpen || (event.target as HTMLElement)?.closest('input, textarea, [contenteditable]') || event.isComposing) return;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
            event.preventDefault(); event.stopPropagation();
            this.filterInput?.focus(); this.filterInput?.select();
            return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
        event.preventDefault(); event.stopPropagation();
        this.filterChanged(this.modelTree.filter + event.key);
        this.filterInput?.focus();
        // React updates the controlled input after this event. Keep the caret after the inserted character.
        if (this.filterInput) {
            this.filterInput.value = this.modelTree.filter;
            this.filterInput.setSelectionRange(this.filterInput.value.length, this.filterInput.value.length);
        }
    }

    get file(): string | undefined { return this.modelTree.file; }

    configure(file: string): void {
        this.modelTree.file = file;
        this.id = FILE_EXPLORER_ID + ':' + file;
        this.title.label = `${baseName(file)} · Model`;
        this.title.caption = file;
        void this.model.refresh();
    }

    protected override renderTree(model: TreeModel): React.ReactNode {
        const tree = this.modelTree;
        if (!this.modelFrontend.isOpen) return super.renderTree(model);
        const accept = (e: React.DragEvent) => {
            if (tree.file && e.dataTransfer.types.includes(EXPLORER_DRAG)) {
                e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
            }
        };
        return <div className='catenary-file-tree' onDragEnter={accept} onDragOver={accept} onDrop={e => {
            if (!tree.file || !e.dataTransfer.types.includes(EXPLORER_DRAG)) return;
            e.preventDefault(); e.stopPropagation();
            const payload = e.dataTransfer.getData(EXPLORER_DRAG);
            void this.dropInFile(payload, tree.file);
        }}>
            <input ref={input => { this.filterInput = input; }} className='theia-input' aria-label='Filter model elements' placeholder='Fuzzy filter…' value={tree.filter}
                onKeyDown={e => {
                    e.stopPropagation();
                    if (e.key === 'Escape') {
                        e.preventDefault(); this.filterChanged(''); this.node.focus();
                    } else if (e.key === 'ArrowDown') {
                        e.preventDefault(); this.node.focus();
                    }
                }} onChange={e => this.filterChanged(e.target.value)} />
            {super.renderTree(model)}
        </div>;
    }

    protected async dropInFile(raw: string, destination: string): Promise<void> {
        let selection: ExplorerDrag;
        try { selection = JSON.parse(raw); } catch { return; }
        if (!selection.file) {
            await this.actions.confirm('Move elements', 'Drag from a file-scoped Model explorer to move source statements.', 'OK');
            return;
        }
        if (selection.file === destination) return;
        const ids = await this.modelFrontend.service.explorerDrag(selection);
        if (!ids.length) return;
        if (!await this.actions.confirm('Move elements', `Move ${ids.length} elements from ${selection.file} to ${destination}? Only statements from the source file move.`, 'Move')) return;
        await this.modelFrontend.execute({ kind: 'moveElementsToFile', source: selection.file, destination, ids });
    }

    /** The rows of an element in the loaded folders (an element has a row under each of its types, and concept rows). */
    protected nodesOf(id: string): CatenaryNode[] {
        const rows: CatenaryNode[] = [];
        const visit = (n: TreeNode) => {
            if (CatenaryNode.isElement(n) && n.element === id) rows.push(n);
            if (CompositeTreeNode.is(n)) n.children.forEach(visit);
        };
        if (this.model.root) visit(this.model.root);
        return rows;
    }

    /** True when the node shows in the tree: all its folders are expanded. */
    protected isShown(node: TreeNode): boolean {
        for (let p = node.parent; p && p.id !== 'catenary-root'; p = p.parent) if (!ExpandableTreeNode.isExpanded(p)) return false;
        return true;
    }

    @postConstruct()
    protected override init(): void {
        super.init();
        this.title.iconClass = codicon('symbol-class');
        const onKeyDown = (event: KeyboardEvent) => this.typeToFilter(event);
        this.node.addEventListener('keydown', onKeyDown, true);
        this.toDispose.push({ dispose: () => {
            clearTimeout(this.filterTimer);
            this.node.removeEventListener('keydown', onKeyDown, true);
        } });
        (this as { saveable: ModelSaveable }).saveable = new ModelSaveable(this.modelFrontend);
        const root: CompositeTreeNode = { id: 'catenary-root', name: 'Model', parent: undefined, children: [], visible: false } as CompositeTreeNode;
        this.model.root = root;
        this.toDispose.push(this.modelFrontend.onDidChange(async s => {
            // A write or a move of placements: the rows stay; only the dirty state can change. Rows show violation counts.
            if (panelsUnchanged(s.change, true)) {
                this.saveable.onDirtyChangedEmitter.fire();
                return;
            }
            const refreshed = this.model.refresh();
            this.saveable.onDirtyChangedEmitter.fire();
            this.update();
            await refreshed;
            await this.showSelection();
        }));
        // A selection of element rows is the selection of the model: elements, with no view (spec 0.4: Del has no action on them);
        // a row of a placement or a mark has the view of its graph. Folders only: nothing is selected (their actions: the folder target).
        this.toDispose.push(this.model.onSelectionChanged(nodes => {
            if (this.applying || this.shell.activeWidget !== this) return;
            const rows = nodes.filter(CatenaryNode.isElement);
            const ids = [...new Set(rows.map(CatenaryNode.elementId))];
            if (ids.length) this.elements.set({ view: rows.find(n => n.view)?.view, ids });
            else if (nodes.length) this.elements.set({ ids: [] });
            // One view row selected: open the view, the focus stays in the tree.
            if (rows.length === 1 && nodes.length === 1 && rows[0].kind === 'view') void this.editors.open(rows[0].element!, 'reveal');
        }));
        this.toDispose.push(this.elements.onDidChange(() => this.showSelection()));
        // Another view editor becomes the current one: mark the elements of that view.
        this.toDispose.push(this.editors.onDidChangeCurrentView(() => this.model.refresh()));
        this.modelFrontend.start().then(() => this.model.refresh());
    }

    /**
     * Select the nodes of the selected elements that show: a selection does not expand folders (Reveal in Explorer does).
     * A selected folder stays selected when no element node is.
     */
    protected async showSelection(): Promise<void> {
        const selection = this.elements.selection;
        const { elements } = await this.elements.resolve();
        if (this.elements.selection !== selection) return;
        const nodes = [...new Set(elements.flatMap(id => this.nodesOf(id)).filter(n => this.isShown(n)))];
        const current = this.selectedNodes.filter(n => CatenaryNode.isElement(n)).map(n => n.id);
        if (sameIds(current, nodes.map(n => n.id))) return;
        this.applying = true;
        try {
            if (!nodes.length) {
                if (current.length) this.model.clearSelection();
            } else {
                this.model.selectNode(nodes[0]);
                for (const node of nodes.slice(1)) this.model.addSelection({ node, type: TreeSelection.SelectionType.TOGGLE });
            }
        } finally {
            this.applying = false;
        }
    }

    get selectedNodes(): CatenaryNode[] {
        return this.model.selectedNodes.filter(CatenaryNode.is);
    }

    /** Expand the folders of a row of an element and select it. Several rows (types, concept tree): the user picks one. */
    async reveal(id: string): Promise<void> {
        await this.model.refresh();
        const paths = await this.modelFrontend.service.explorerPaths(id);
        const path = paths.length > 1
            ? (await this.quick.showQuickPick(paths.map(p => ({ label: p.name, path: p })), { placeholder: 'Reveal in folder' }))?.path
            : paths[0];
        if (!path) return;
        let nodeId = 'folder:' + path.keys[0];
        for (const [i, key] of path.keys.entries()) {
            if (i > 0) nodeId += '/' + key;
            const node = this.model.getNode(nodeId);
            if (i === path.keys.length - 1) {
                if (SelectableTreeNode.is(node)) this.model.selectNode(node);
            } else if (ExpandableTreeNode.is(node)) {
                await this.model.expandNode(node);
            } else {
                return;
            }
        }
    }

    /** The element ids under a folder, at any depth (explorerElements of the backend). */
    elementsIn(folder: CatenaryNode): Promise<string[]> {
        return this.modelFrontend.service.explorerElements(folder.key, this.modelTree.file);
    }

    protected override renderIcon(node: TreeNode, _props: NodeProps): React.ReactNode {
        if (!CatenaryNode.is(node)) return undefined;
        const icon = node.icon ?? (node.kind === 'relation' ? 'arrow-right' : node.kind === 'instance' ? 'symbol-object' : 'symbol-class');
        return <span className={`${codicon(icon)} catenary-tree-icon`} style={node.color ? { color: node.color } : undefined} />;
    }

    protected override renderCaption(node: TreeNode, props: NodeProps): React.ReactNode {
        if (!CatenaryNode.is(node)) return super.renderCaption(node, props);
        const folder = node.kind === 'folder';
        const cls = ['catenary-tree-caption', node.muted ? 'muted' : '', node.inView ? 'in-view' : '', folder ? 'folder' : '', node.error ? 'error' : ''].join(' ');
        return <span className={cls} title={this.tooltip(node)}>
            <span className='catenary-tree-name'>{this.captionText(node.name ?? '')}</span>
            {node.description ? <span className='catenary-tree-description'>{node.description}</span> : undefined}
            {node.problems ? <span className='catenary-tree-problems' title={`${node.problems} violations`}>{node.problems}</span> : undefined}
            {node.badge !== undefined ? <span className='catenary-tree-badge'>{node.badge}</span> : undefined}
            {this.renderActions(node)}
        </span>;
    }

    /** One class folder selected (no element rows): the class is the target of the actions of the context menu (Propose Node Shapes from Data). */
    protected override toContextMenuArgs(_node: SelectableTreeNode): ActionTarget[] | undefined {
        const nodes = this.selectedNodes;
        const iri = nodes.length === 1 && nodes[0].kind === 'folder' && nodes[0].key.startsWith(CLASS_KEY) ? nodes[0].key.slice(CLASS_KEY.length) : undefined;
        return iri ? [{ ids: [iriId(iri)] }] : undefined;
    }

    /** As the base class, but the menu opens after the actions of its target are known (action-menus.ts). */
    protected override handleContextMenuEvent(node: TreeNode | undefined, event: React.MouseEvent<HTMLElement>): void {
        const menuPath = this.props.contextMenuPath;
        if (!SelectableTreeNode.is(node) || !menuPath) return super.handleContextMenuEvent(node, event);
        if (!this.props.multiSelect || !node.selected) {
            const type = this.props.multiSelect && this.hasCtrlCmdMask(event) ? TreeSelection.SelectionType.TOGGLE : TreeSelection.SelectionType.DEFAULT;
            this.model.addSelection({ node, type });
        }
        this.focusService.setFocus(node);
        const { x, y } = event.nativeEvent;
        const context = event.currentTarget;
        const args = this.toContextMenuArgs(node);
        event.stopPropagation();
        event.preventDefault();
        void whenActionsKnown(this.actionService, this.actionService.targetOf(args?.[0]))
            .then(() => this.contextMenuRenderer.render({ menuPath, context, anchor: { x, y }, args }));
    }

    /** Buttons at the end of a row, shown on hover. */
    protected renderActions(_node: CatenaryNode): React.ReactNode {
        return undefined;
    }

    protected tooltip(node: CatenaryNode): string {
        if (node.tooltip) return node.tooltip;
        switch (node.kind) {
            case 'instance': return `${node.name}: in ${node.badge} view(s)${node.muted ? ' (not placed in a view)' : ''}${node.inView ? ', also in the current view' : ''}. Double-click to show, drag to a view.`;
            case 'relation': return `${node.name}: shown in ${node.badge} view(s)${node.inView ? ', also in the current view' : ''}. Drag to a view to add its subject and object.`;
            default: return node.name ?? '';
        }
    }

    protected override createNodeAttributes(node: TreeNode, props: NodeProps): React.Attributes & React.HTMLAttributes<HTMLElement> {
        const attrs = super.createNodeAttributes(node, props);
        if (!CatenaryNode.is(node) || !(node.element || node.kind === 'folder')) return attrs;
        return { ...attrs, draggable: true, onDragStart: (e: React.DragEvent) => {
            const nodes = node.selected ? this.selectedNodes : [node];
            const payload: ExplorerDrag = {
                file: this.modelTree.file,
                ids: nodes.filter(n => n.kind !== 'folder' && n.element).map(n => n.element!),
                folders: nodes.filter(n => n.kind === 'folder').map(n => n.key)
            };
            e.dataTransfer.setData(EXPLORER_DRAG, JSON.stringify(payload));
            e.dataTransfer.effectAllowed = 'copyMove';
            e.stopPropagation();
        } };
    }

    protected captionText(name: string): React.ReactNode {
        const indices = new Set(fuzzyMatch(name, this.modelTree.filter)?.indices ?? []);
        return name.split('').map((c, i) => indices.has(i) ? <mark key={i}>{c}</mark> : c);
    }

    protected override handleDblClickEvent(node: TreeNode | undefined, event: React.MouseEvent<HTMLElement>): void {
        if (CatenaryNode.isElement(node)) {
            void this.editors.show(CatenaryNode.elementId(node));
            event.stopPropagation();
        } else super.handleDblClickEvent(node, event);
    }

    protected override handleEnter(event: KeyboardEvent): void {
        const node = this.model.getFocusedNode();
        if (CatenaryNode.isElement(node)) void this.editors.show(CatenaryNode.elementId(node));
        else super.handleEnter(event);
    }

}
