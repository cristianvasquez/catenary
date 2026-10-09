// Each file Model pane (ADR 0006): the sections of the explorer plugins of the backend (Classes, Shapes). A folder asks the
// backend for its rows when it opens, one page at a time. A filter shows one flat list of the best matches.
// It shows and sets the selection of the window (SelectionModel). The files: the Theia file navigator (ADR 0004).

import { CancellationToken, CommandService, Emitter, MenuPath, QuickInputService } from '@theia/core';
import {
    ApplicationShell, CompositeTreeNode, ContextMenuRenderer, ExpandableTreeNode, NodeProps, Saveable, SaveableSource, SelectableTreeNode,
    Tree, TreeImpl, TreeModel, TreeNode, TreeProps, TreeSelection, TreeWidget, codicon
} from '@theia/core/lib/browser';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { EXPLORER_PAGE, ExplorerRow, EXPLORER_DRAG, ExplorerDrag, fuzzyMatch, baseName, panelsUnchanged } from '@catenary/model';
import { ActionService, whenActionsKnown } from '../action-service';
import { ModelActions } from '../actions';
import { ModelFrontend } from '../model-client';
import { SelectionModel, sameIds } from '../selection-model';

export const FILE_EXPLORER_ID = 'catenary-file-explorer';
/** The Open in… command (ModelCommands.OPEN_IN): this file cannot import commands.ts, which imports it. */
const OPEN_IN = 'catenary.openIn';
/** Context menu of the explorers: each command shows when it applies to the selected nodes. */
export const EXPLORER_CONTEXT_MENU: MenuPath = ['catenary-model-explorer-context'];

/** A row of the Model explorer: an ExplorerRow of the backend as a tree node. */
export interface CatenaryNode extends SelectableTreeNode, Omit<ExplorerRow, 'folder' | 'name' | 'description' | 'icon'> {
    /** Codicon name (ExplorerRow.icon). */
    icon?: string;
    /** Short text after the name (ExplorerRow.description). */
    description?: string;
}
export type CatenaryFolder = CatenaryNode & ExpandableTreeNode;

/** The last row of a folder with more rows than it shows: a click shows the next page. */
interface MoreNode extends SelectableTreeNode { more: true }
const isMore = (node: unknown): node is MoreNode => !!node && typeof node === 'object' && 'more' in node;

export namespace CatenaryNode {
    export function is(node: unknown): node is CatenaryNode {
        return !!node && typeof node === 'object' && 'key' in node && SelectableTreeNode.is(node as unknown as TreeNode);
    }
    /** A row of an element: it can be the selection of the model. A folder can be one (a class, a node shape). */
    export function isElement(node: unknown): node is CatenaryNode {
        return is(node) && !!node.element;
    }
    export function isFolder(node: unknown): node is CatenaryFolder {
        return is(node) && ExpandableTreeNode.is(node);
    }
    /** The element id of an element row. */
    export function elementId(node: CatenaryNode): string {
        return node.element ?? node.key;
    }
}

/**
 * The tree of the backend (ADR 0006): the children of a node are pages of `explorerChildren(key)`. Node ids are the path of keys
 * ('folder:<top key>/<key>/…'), stable over refreshes, so expansion and selection survive. With a filter, the root has the rows of
 * `explorerSearch` ('search:<key>').
 */
@injectable()
export class ModelTree extends TreeImpl {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    file?: string;
    filter = '';
    /** Node id of a folder -> the number of its rows to show (pages of EXPLORER_PAGE). */
    protected shown = new Map<string, number>();

    /** Show the next page of the folder of a "more" row. */
    async showMore(node: TreeNode): Promise<void> {
        const parent = node.parent;
        if (!isMore(node) || !parent) return;
        this.shown.set(parent.id, (this.shown.get(parent.id) ?? EXPLORER_PAGE) + EXPLORER_PAGE);
        await this.refresh(parent);
    }

    override async resolveChildren(parent: CompositeTreeNode): Promise<TreeNode[]> {
        const top = parent.id === 'catenary-root';
        if (CatenaryNode.is(parent)) for (let ancestor = parent.parent; ancestor; ancestor = ancestor.parent) {
            if (CatenaryNode.is(ancestor) && ancestor.key === parent.key) return [];
        }
        if (top && !this.model.isOpen) return [];
        const file = this.file, filter = this.filter;
        let rows: ExplorerRow[], total: number;
        try {
            if (top && filter) {
                rows = await this.model.service.explorerSearch(filter, file);
                total = rows.length;
            } else {
                const key = top ? undefined : (parent as unknown as CatenaryNode).key, limit = this.shown.get(parent.id) ?? EXPLORER_PAGE;
                ({ rows, total } = await this.model.service.explorerChildren(key, file, 0));
                while (rows.length < Math.min(limit, total)) rows = [...rows, ...(await this.model.service.explorerChildren(key, file, rows.length)).rows];
            }
            if (file !== this.file || filter !== this.filter) return this.resolveChildren(parent);
        } catch (e) {
            console.error('[catenary] explorer', e);
            return [];
        }
        const prefix = top ? (filter ? 'search:' : 'folder:') : parent.id + '/';
        const nodes: TreeNode[] = rows.map(({ folder, ...row }) => {
            const node: CatenaryNode = { ...row, id: prefix + row.key, parent, selected: false };
            return this.keep(folder ? { ...node, children: [], expanded: false } as CatenaryFolder : node);
        });
        if (total > rows.length) {
            const more: MoreNode = { more: true, id: parent.id + '/#more', name: `Show ${Math.min(EXPLORER_PAGE, total - rows.length)} more (${rows.length} of ${total})`, parent, selected: false };
            nodes.push(more);
        }
        return nodes;
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
    @inject(SelectionModel) protected readonly elements: SelectionModel;
    @inject(ModelActions) protected readonly actions: ModelActions;
    @inject(QuickInputService) protected readonly quick: QuickInputService;
    @inject(ActionService) protected readonly actionService: ActionService;
    @inject(CommandService) protected readonly commands: CommandService;
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
        this.modelTree.filter = value;
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
        // A selection of element rows is the selection of the model: elements, with no view (spec 0.4: Del has no action on them).
        // A "more" row shows the next page of its folder.
        this.toDispose.push(this.model.onSelectionChanged(nodes => {
            const more = nodes.find(isMore);
            if (more) return void this.modelTree.showMore(more);
            if (this.applying || this.shell.activeWidget !== this) return;
            const ids = [...new Set(nodes.filter(CatenaryNode.isElement).map(CatenaryNode.elementId))];
            if (ids.length || nodes.length) this.elements.set({ ids });
        }));
        this.toDispose.push(this.elements.onDidChange(() => this.showSelection()));
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
        if (this.modelTree.filter) this.filterChanged('');
        await this.model.refresh();
        const paths = await this.modelFrontend.service.explorerPaths(id, this.modelTree.file);
        const path = paths.length > 1
            ? (await this.quick.showQuickPick(paths.map(p => ({ label: p.name, path: p })), { placeholder: 'Reveal in folder' }))?.path
            : paths[0];
        if (!path) return;
        let parentId = 'catenary-root', nodeId = 'folder:' + path.keys[0];
        for (const [i, key] of path.keys.entries()) {
            if (i > 0) [parentId, nodeId] = [nodeId, nodeId + '/' + key];
            // A row after the shown pages: show the next page of its folder until it is there.
            let node = this.model.getNode(nodeId);
            for (let more = this.model.getNode(parentId + '/#more'); !node && more; more = this.model.getNode(parentId + '/#more')) {
                await this.modelTree.showMore(more);
                node = this.model.getNode(nodeId);
            }
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
        if (isMore(node)) return <span className={`${codicon('ellipsis')} catenary-tree-icon`} />;
        if (!CatenaryNode.is(node)) return undefined;
        return <span className={`${codicon(node.icon ?? 'symbol-misc')} catenary-tree-icon`} />;
    }

    protected override renderCaption(node: TreeNode, props: NodeProps): React.ReactNode {
        if (isMore(node)) return <span className='catenary-tree-caption muted'>{node.name}</span>;
        if (!CatenaryNode.is(node)) return super.renderCaption(node, props);
        const cls = ['catenary-tree-caption', CatenaryNode.isFolder(node) ? 'folder' : ''].join(' ');
        return <span className={cls} title={node.tooltip ?? node.name}>
            <span className='catenary-tree-name'>{this.captionText(node.name ?? '')}</span>
            {node.description ? <span className='catenary-tree-description'>{node.description}</span> : undefined}
            {node.count !== undefined ? <span className='catenary-tree-badge'>{node.count}</span> : undefined}
        </span>;
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

    protected override createNodeAttributes(node: TreeNode, props: NodeProps): React.Attributes & React.HTMLAttributes<HTMLElement> {
        const attrs = super.createNodeAttributes(node, props);
        if (!CatenaryNode.is(node)) return attrs;
        return { ...attrs, draggable: true, onDragStart: (e: React.DragEvent) => {
            const nodes = node.selected ? this.selectedNodes : [node];
            const payload: ExplorerDrag = {
                file: this.modelTree.file,
                ids: nodes.filter(n => !CatenaryNode.isFolder(n) && n.element).map(n => n.element!),
                folders: nodes.filter(CatenaryNode.isFolder).map(n => n.key)
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

    /** Double-click or Enter on a leaf row of an element: Open in… (a folder row expands). */
    protected override handleDblClickEvent(node: TreeNode | undefined, event: React.MouseEvent<HTMLElement>): void {
        if (CatenaryNode.isElement(node) && !CatenaryNode.isFolder(node)) {
            void this.commands.executeCommand(OPEN_IN, { ids: [CatenaryNode.elementId(node)] });
            event.stopPropagation();
        } else super.handleDblClickEvent(node, event);
    }

    protected override handleEnter(event: KeyboardEvent): void {
        const node = this.model.getFocusedNode();
        if (CatenaryNode.isElement(node) && !CatenaryNode.isFolder(node)) void this.commands.executeCommand(OPEN_IN, { ids: [CatenaryNode.elementId(node)] });
        else super.handleEnter(event);
    }

}
