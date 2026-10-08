// Commands, menus, keybindings, toolbar items and the explorer views (Workspace tab: Views and Files; Model tab).

import { GLSPDiagramWidget, TheiaGLSPContextMenu } from '@eclipse-glsp/theia-integration';
import { Command, CommandRegistry, MAIN_MENU_BAR, MenuModelRegistry, MessageService, QuickInputService, SelectionService, URI } from '@theia/core';
import {
    AbstractViewContribution, ApplicationShell, FrontendApplication, FrontendApplicationContribution, KeybindingContext, KeybindingRegistry,
    OpenHandler, StorageService, Widget
} from '@theia/core/lib/browser';
import { PERSPECTIVE_LAYOUTS_STORAGE_KEY } from '@theia/core/lib/browser/shell/shell-layout-restorer';
import { TabBarToolbarContribution, TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { UriAwareCommandHandler } from '@theia/core/lib/common/uri-command-handler';
import { inject, injectable } from '@theia/core/shared/inversify';
import { EditorManager, EditorWidget } from '@theia/editor/lib/browser';
import { NavigatorContextMenu } from '@theia/navigator/lib/browser/navigator-contribution';
import { FileNavigatorWidget } from '@theia/navigator/lib/browser/navigator-widget';
import { FileStatNode } from '@theia/filesystem/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { OutlineViewContribution } from '@theia/outline-view/lib/browser/outline-view-contribution';
import { PropertyViewContribution } from '@theia/property-view/lib/browser/property-view-contribution';
import { FileContent, openModes } from '@catenary/model';
import { VIEW_SCHEME } from '../common/protocol';
import { ModelActions } from './actions';
import { ViewEditors, viewIdOf } from './diagram/view-editors';
import { ViewsExport } from './diagram/views-export';
import { ViewHistory } from './diagram/view-history';
import { COLOR_NAMES, COLOR_ORDER, PRESETS } from './diagram/views';
import { EXPLORER_CONTEXT_MENU, MODEL_EXPLORER_ID, ModelExplorerWidget, CatenaryNode, CatenaryTreeWidget } from './explorer/model-explorer';
import { FileNavigatorContribution } from '@theia/navigator/lib/browser/navigator-contribution';
import { WorkspaceSettingsContribution, WorkspaceSettingsWidget } from './prefixes/workspace-settings';
import { RecentWorkspaces } from './explorer/recent-workspaces';
import { SidePanelSizes } from './side-panel-sizes';
import { ModelFrontend } from './model-client';
import { SelectionModel } from './selection-model';
import { AppearanceContribution } from './properties/appearance-widget';
import { NoteEditor } from './notes/note-editor';
import { LinksContribution } from './properties/links-widget';
import { SearchContribution, SearchWidget } from './search/search-widget';
import { addMenuItems } from './menus';

const category = 'Model';
const cmd = (id: string, label: string, iconClass?: string): Command => ({ id, label, category, iconClass });

export namespace OpenModelCommands {
    export const OPEN = cmd('catenary.open', 'Open Workspace…');
    export const NEW = cmd('catenary.new', 'New Workspace…');
    export const OPEN_RECENT = cmd('catenary.openRecent', 'Open Recent Workspace…');
    export const OPEN_FILE_AS_MODEL = cmd('catenary.openFileAsModel', 'Open as Workspace');
    export const SAVE = cmd('catenary.save', 'Save Workspace');
    export const EXPORT_VIEWS_HTML = cmd('catenary.exportViewsHtml', 'Export Views as HTML…');
    export const SHOW_TRIG = cmd('catenary.showTrig', 'Open Workspace File as Text');
    export const WORKSPACE_SETTINGS = cmd('catenary.openWorkspaceSettings', 'Workspace Settings');
    /** The canvas/text toggle (ADR 0004): the Turtle or TriG text of a view editor or of the settings view, and back. */
    export const SHOW_TEXT = cmd('catenary.showText', 'Show Text', 'codicon codicon-file-code');
    export const SHOW_CANVAS = cmd('catenary.showCanvas', 'Show Canvas', 'codicon codicon-type-hierarchy');
    export const UNDO = cmd('catenary.undo', 'Undo Model Change', 'codicon codicon-discard');
    export const REDO = cmd('catenary.redo', 'Redo Model Change', 'codicon codicon-redo');
}

export namespace ModelCommands {
    export const NEW_VIEW = cmd('catenary.newView', 'New View', 'codicon codicon-new-file');
    /** File navigator: a new view file in the selected folder (a file: its folder; nothing selected: the workspace folder). */
    export const NEW_VIEW_IN_FOLDER = cmd('catenary.newViewInFolder', 'New View', 'codicon codicon-type-hierarchy');
    export const NEW_NODE_SHAPE_HERE = cmd('catenary.newNodeShapeHere', 'New Node Shape');
    export const EDIT_PATH = cmd('catenary.editPath', 'Edit Path…');
    export const NEW_INSTANCE = cmd('catenary.newInstance', 'New Instance…', 'codicon codicon-add');
    export const NEW_INSTANCE_HERE = cmd('catenary.newInstanceHere', 'New Instance…');
    export const RENAME = cmd('catenary.rename', 'Rename');
    export const DELETE_FROM_MODEL = cmd('catenary.deleteFromModel', 'Delete from Model…');
    export const DELETE_UNPLACED = cmd('catenary.deleteUnplaced', 'Delete Elements Not Placed in a View…');
    /** Node shapes proposed from the data for every class of the data file without a node shape (SHACLxtract), shown in a new view. */
    export const PROPOSE_ALL_SHAPES = cmd('catenary.proposeAllShapes', 'Propose Missing Shapes');
    export const COLLAPSE = cmd('catenary.collapseExplorer', 'Collapse Folders', 'codicon codicon-collapse-all');
    // View editor
    export const REMOVE_FROM_VIEW = cmd('catenary.removeFromView', 'Remove from View');
    export const TOGGLE_HIDDEN = cmd('catenary.toggleHidden', 'Show Hidden Edges', 'codicon codicon-eye');
    export const NEW_GROUP = cmd('catenary.newGroup', 'New Group…', 'codicon codicon-symbol-namespace');
    export const COLLECT = cmd('catenary.collect', 'Collect into One Box', 'codicon codicon-group-by-ref-type');
    export const UNCOLLECT = cmd('catenary.uncollect', 'Expand Collection', 'codicon codicon-ungroup-by-ref-type');
    export const LAYOUT_VIEW = cmd('catenary.layoutView', 'Apply Layout…', 'codicon codicon-type-hierarchy-sub');
    export const SELECT_IN_EXPLORER = cmd('catenary.selectInExplorer', 'Reveal in Explorer');
    export const FIND_ELEMENT = cmd('catenary.findElement', 'Find Element…', 'codicon codicon-search');
    export const NEXT_OCCURRENCE = cmd('catenary.nextOccurrence', 'Show in Next View');
    export const PREVIOUS_OCCURRENCE = cmd('catenary.previousOccurrence', 'Show in Previous View');
    export const BACK = cmd('catenary.back', 'Go Back to Previous View', 'codicon codicon-arrow-left');
    export const FORWARD = cmd('catenary.forward', 'Go Forward to Next View', 'codicon codicon-arrow-right');
    /** Display of the selected cards and of the cards inside the selected groups: checked when all are detailed. */
    export const DETAILS = cmd('catenary.display.details', 'Show Details');
    /** Color of the selected view elements: '' (default), "none" and the presets "1".."6", "white". Icon: a box with the color (modeler.css). */
    export const COLORS: [string, Command][] = [['', cmd('catenary.color.default', 'Color: Default', 'catenary-swatch')],
        ...COLOR_ORDER.map(k => [k, COLOR_NAMES[k]] as const).map(([k, name]) =>
            [k, cmd(`catenary.color.${k}`, `Color: ${name[0].toUpperCase()}${name.slice(1)}`, `catenary-swatch catenary-swatch-${k}`)] as [string, Command])];
}

export const MODEL_MENU = [...MAIN_MENU_BAR, '5_model'];
const MODEL_MENU_CREATE = [...MODEL_MENU, '3_create'];

/** Actions of a surface (no selection needed), after the groups of the actions on the selection (action-commands.ts). */
const EXPLORER_SURFACE = [...EXPLORER_CONTEXT_MENU, '4_surface'];
const DIAGRAM_SURFACE = [...TheiaGLSPContextMenu.CONTEXT_MENU, 'catenary_4_surface'];

/**
 * Stored layouts of an older version are discarded once. Version 4 discards explorers that no longer exist (the Workspace tab: Views,
 * Files). Version 5 discards side panel widths that a window resize after the layout restore made too narrow (SidePanelSizes).
 */
const LAYOUT_VERSION = 5;
const LAYOUT_VERSION_KEY = 'catenary.layoutVersion';

/**
 * The Model tab: one tree of classes, shapes, instances, relations and concepts; the commands of the explorers. The Theia file navigator
 * (the files of the workspace, ADR 0004) is the first tab on the left.
 */
@injectable()
export class ModelExplorerContribution extends AbstractViewContribution<ModelExplorerWidget>
    implements FrontendApplicationContribution, TabBarToolbarContribution {

    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(ModelActions) protected readonly actions: ModelActions;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(SelectionService) protected readonly selection: SelectionService;
    @inject(WorkspaceService) protected readonly workspace: WorkspaceService;
    @inject(EditorManager) protected readonly editorManager: EditorManager;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(PropertyViewContribution) protected readonly propertyView: PropertyViewContribution;
    @inject(AppearanceContribution) protected readonly appearance: AppearanceContribution;
    @inject(LinksContribution) protected readonly links: LinksContribution;
    @inject(OutlineViewContribution) protected readonly outline: OutlineViewContribution;
    @inject(SearchContribution) protected readonly search: SearchContribution;
    @inject(SelectionModel) protected readonly elements: SelectionModel;
    @inject(NoteEditor) protected readonly noteEditor: NoteEditor;
    @inject(ViewHistory) protected readonly history: ViewHistory;
    @inject(FileNavigatorContribution) protected readonly navigator: FileNavigatorContribution;
    @inject(WorkspaceSettingsContribution) protected readonly settings: WorkspaceSettingsContribution;
    @inject(RecentWorkspaces) protected readonly recent: RecentWorkspaces;
    @inject(StorageService) protected readonly storage: StorageService;
    @inject(ViewsExport) protected readonly viewsExport: ViewsExport;
    @inject(SidePanelSizes) protected readonly panelSizes: SidePanelSizes;
    protected readonly showHidden = new Set<string>();

    constructor() {
        super({
            widgetId: MODEL_EXPLORER_ID, widgetName: 'Model',
            defaultWidgetOptions: { area: 'left', rank: 150 }, toggleCommandId: 'catenary.toggleModel', toggleKeybinding: 'ctrlcmd+shift+m'
        });
    }

    async onStart(_app: FrontendApplication): Promise<void> {
        const swatches = document.createElement('style');
        swatches.textContent = Object.entries(PRESETS).map(([k, v]) => `.catenary-swatch-${k} { --catenary-swatch: ${v}; }`).join('\n');
        document.head.appendChild(swatches);
        // Before the shell restores the layout.
        if (await this.storage.getData(LAYOUT_VERSION_KEY) !== LAYOUT_VERSION) {
            await this.storage.setData('layout', undefined);
            await this.storage.setData(PERSPECTIVE_LAYOUTS_STORAGE_KEY, undefined);
            await this.storage.setData(LAYOUT_VERSION_KEY, LAYOUT_VERSION);
        }
        await this.model.start();
        if (!this.model.isOpen) await this.openDefaultModel();
    }

    async initializeLayout(): Promise<void> {
        // The file navigator first and active (ADR 0004: the files are the model), then the Model tab (the start panel when no workspace is open).
        await this.navigator.openView({ activate: this.model.isOpen, reveal: this.model.isOpen });
        await this.openView({ activate: !this.model.isOpen, reveal: !this.model.isOpen });
        await this.search.openView({ activate: false, reveal: false });
        // Right side panel, in this order: Properties, Appearance, Links, Outline.
        await this.propertyView.openView({ activate: false, reveal: true, area: 'right', rank: 100 });
        await this.appearance.openView({ activate: false, reveal: false });
        await this.links.openView({ activate: false, reveal: false });
        await this.outline.openView({ activate: false, reveal: false, area: 'right', rank: 500 });
        this.freshLayout = true;
    }
    protected freshLayout = false;

    async onDidInitializeLayout(): Promise<void> {
        // Side panels wide enough for tree labels and forms, also after the window manager resizes the window.
        this.panelSizes.start(this.freshLayout);
        (await this.widget).onOpen(node => this.openNode(node));
        // Model already open in the backend (page reload) and no view editor restored: open the first view.
        await this.model.start();
        const views = await this.model.viewsSorted();
        const requestedView = new URLSearchParams(window.location.search).get('view');
        if (requestedView !== null) {
            if (views.some(view => view.id === requestedView)) {
                await this.editors.open(requestedView);
                return;
            }
            void this.messages.error('The requested view is not in the current workspace.');
        }
        const first = views[0];
        if (first && !this.editors.all().length) await this.editors.open(first.id);
    }

    /**
     * The last opened workspace file of this window (first recent entry). Else, or if it cannot be opened, the first Theia workspace
     * root as a folder: its workspace.trig, its only workspace file, or the folder with the default settings. A folder with several
     * workspace files: a message with a button for each .trig file.
     */
    protected async openDefaultModel(): Promise<void> {
        await this.recent.ready;
        const last = this.recent.paths[0];
        if (last) {
            // Views open in onDidInitializeLayout: the shell is not attached to the DOM yet.
            const result = await this.model.service.open(last);
            if (result.ok) return;
            console.warn(`Cannot open the last workspace ${last}: ${result.error}`);
        }
        const roots = await this.workspace.roots;
        if (!roots.length || !roots[0].isDirectory) return;
        // Views open in onDidInitializeLayout: the shell is not attached to the DOM yet.
        const result = await this.model.service.open(roots[0].resource.path.fsPath());
        if (result.ok) return;
        const trig = (roots[0].children ?? []).filter(c => c.isFile && c.name.endsWith('.trig')).slice(0, 5);
        const answer = await this.messages.error(result.error, ...trig.map(c => c.name));
        const pick = trig.find(c => c.name === answer);
        if (pick) await this.model.report(this.model.service.open(pick.resource.path.fsPath()));
    }

    protected async openNode(node: CatenaryNode): Promise<void> {
        if (CatenaryNode.isElement(node)) await this.editors.show(CatenaryNode.elementId(node));
    }

    // ------------------------------------------------------------ selections

    /** Folders selected in the Model Explorer: the class of New Instance and Delete Elements Not Placed in a View. Not model elements. */
    protected explorerFolders(): CatenaryNode[] {
        const sel = this.selection.selection;
        return Array.isArray(sel) ? sel.filter(CatenaryNode.is).filter(n => n.kind === 'folder') : [];
    }

    // ------------------------------------------------------------ commands

    override registerCommands(registry: CommandRegistry): void {
        super.registerCommands(registry);
        const a = this.actions;
        const open = () => this.model.isOpen;
        registry.registerCommand(OpenModelCommands.OPEN, { execute: () => a.openModel() });
        registry.registerCommand(OpenModelCommands.NEW, { execute: () => a.newModel() });
        registry.registerCommand(OpenModelCommands.OPEN_RECENT, { execute: () => a.openRecent(this.recent.paths), isEnabled: () => this.recent.paths.length > 0 });
        registry.registerCommand(OpenModelCommands.SAVE, { execute: () => a.save(), isEnabled: open });
        // Arguments (CLI, scripts): view ids, file path. Without them: a pick and a save dialog.
        registry.registerCommand(OpenModelCommands.EXPORT_VIEWS_HTML, {
            execute: (ids?: unknown, file?: unknown) => this.viewsExport.exportHtml(Array.isArray(ids) ? ids.map(String) : undefined, typeof file === 'string' ? file : undefined),
            isEnabled: () => open() && this.model.snapshot.files.views.length > 0
        });
        registry.registerCommand(OpenModelCommands.WORKSPACE_SETTINGS, { execute: () => this.settings.openView({ activate: true, reveal: true }), isEnabled: open });
        // The file behind a widget: a view editor → its view file; the settings view → the workspace file.
        const fileOf = (w?: Widget): string | undefined => {
            if (w instanceof GLSPDiagramWidget && w.uri.scheme === VIEW_SCHEME) return this.model.snapshot.files.views.find(v => v.view === viewIdOf(w))?.path;
            if (w instanceof WorkspaceSettingsWidget) return this.model.snapshot.file;
            return undefined;
        };
        const current = (w?: unknown) => (w instanceof Widget ? w : this.shell.currentWidget);
        registry.registerCommand(OpenModelCommands.SHOW_TEXT, {
            execute: (w?: unknown) => { const f = fileOf(current(w)); if (f) return this.editorManager.open(URI.fromFilePath(f), { mode: 'activate' }); },
            isVisible: (w?: unknown) => !!fileOf(current(w)), isEnabled: (w?: unknown) => !!fileOf(current(w))
        });
        // A text editor of a view file → its canvas; of the workspace file → its settings view.
        const canvasOf = (w?: Widget): string | undefined => {
            const path = w instanceof EditorWidget ? w.editor.uri.path.fsPath() : undefined;
            if (!path) return undefined;
            if (path === this.model.snapshot.file) return 'settings';
            return this.model.snapshot.files.views.find(v => v.path === path)?.view;
        };
        registry.registerCommand(OpenModelCommands.SHOW_CANVAS, {
            execute: (w?: unknown) => {
                const target = canvasOf(current(w));
                if (target === 'settings') return this.settings.openView({ activate: true, reveal: true });
                if (target) return this.editors.open(target);
            },
            isVisible: (w?: unknown) => !!canvasOf(current(w)), isEnabled: (w?: unknown) => !!canvasOf(current(w))
        });
        registry.registerCommand(OpenModelCommands.SHOW_TRIG, {
            execute: () => this.editorManager.open(URI.fromFilePath(this.model.snapshot.file!), { mode: 'activate' }), isEnabled: open
        });
        registry.registerCommand(OpenModelCommands.UNDO, { execute: () => this.model.service.undo(), isEnabled: () => this.model.snapshot.canUndo });
        registry.registerCommand(OpenModelCommands.REDO, { execute: () => this.model.service.redo(), isEnabled: () => this.model.snapshot.canRedo });
        // File explorer (navigator) context menu.
        const trig = (uri: URI) => uri.path.ext === '.trig';
        const navigator = (command: Command, execute: (uri: URI) => unknown, applies: (uri: URI) => boolean, needsOpen = true) =>
            registry.registerCommand(command, UriAwareCommandHandler.MonoSelect(this.selection, {
                execute, isVisible: applies, isEnabled: uri => applies(uri) && (!needsOpen || this.model.isOpen)
            }));
        navigator(OpenModelCommands.OPEN_FILE_AS_MODEL, uri => a.openModel(uri), trig, false);

        registry.registerCommand(ModelCommands.BACK, { execute: () => this.history.back(), isEnabled: () => this.history.canGoBack() });
        registry.registerCommand(ModelCommands.FORWARD, { execute: () => this.history.forward(), isEnabled: () => this.history.canGoForward() });
        registry.registerCommand(ModelCommands.FIND_ELEMENT, {
            execute: async () => {
                const id = await a.findElement();
                if (id) await this.editors.show(id);
            },
            isEnabled: open
        });
        registry.registerCommand(ModelCommands.NEW_VIEW, { execute: () => a.newView(), isEnabled: open });
        registry.registerCommand(ModelCommands.NEW_VIEW_IN_FOLDER, {
            execute: () => {
                const sel = this.selection.selection;
                const node = Array.isArray(sel) ? sel.find(FileStatNode.is) : undefined;
                const uri = node ? (node.fileStat.isDirectory ? node.uri : node.uri.parent) : undefined;
                const file = this.model.snapshot.file;
                return a.newView((uri ?? (file ? URI.fromFilePath(file).parent : undefined))?.path.fsPath());
            },
            isEnabled: open, isVisible: open
        });
        const inDiagram = () => this.shell.currentWidget instanceof GLSPDiagramWidget && (this.shell.currentWidget as GLSPDiagramWidget).uri.scheme === VIEW_SCHEME;
        /** The view of the focused view editor; undefined when no view editor has the focus. */
        const view = () => inDiagram() ? viewIdOf(this.shell.currentWidget as GLSPDiagramWidget) : undefined;
        // Class picker, then the new instance: in the focused view editor at the pointer (else at the canvas center); else in no view.
        registry.registerCommand(ModelCommands.NEW_INSTANCE, {
            execute: () => {
                const w = inDiagram() ? this.shell.currentWidget as GLSPDiagramWidget : undefined;
                const p = w && this.editors.pointerAt.get(w);
                return a.newInstance(undefined, w && viewIdOf(w), p && this.editors.toModel(w, p.x, p.y));
            },
            isEnabled: open
        });
        // The actions on the selection (rename, delete, remove, reveal, …): action-commands.ts. Here: the actions of a surface.
        const viewWidget = (w?: Widget) => (w instanceof GLSPDiagramWidget ? w : this.editors.current());
        const onView = (w?: Widget) => (w instanceof GLSPDiagramWidget ? w.uri.scheme === VIEW_SCHEME : inDiagram());
        /** The selection made in the view editor `v`: its elements (a card or an edge by its element, a mark by its placement). */
        const selectedIn = async (v: string) => this.elements.selection.view === v ? this.elements.resolve() : undefined;
        // Placement: a card of an instance or a placed edge of a relation, in any view. Any folder: the elements under it (backend).
        registry.registerCommand(ModelCommands.DELETE_UNPLACED, {
            execute: async () => {
                const w = this.tryGetWidget();
                if (!w) return;
                const ids = (await Promise.all(this.explorerFolders().map(f => w.elementsIn(f)))).flat();
                const unplaced = await this.model.service.unplaced(ids);
                if (unplaced.length) return a.delete(unplaced);
                this.messages.info('All elements of the folder are placed in a view.');
            },
            isVisible: () => this.explorerFolders().length > 0
        });
        registry.registerCommand(ModelCommands.PROPOSE_ALL_SHAPES, { execute: () => a.proposeShapes(), isEnabled: open });
        registry.registerCommand(ModelCommands.COLLAPSE, {
            execute: async (widget?: Widget) => {
                const w = widget instanceof CatenaryTreeWidget ? widget : await this.widget;
                const root = w.model.root;
                if (root && 'children' in root) for (const c of (root as { children: readonly unknown[] }).children) w.model.collapseNode(c as never);
            },
            isVisible: (w?: Widget) => w instanceof CatenaryTreeWidget
        });
        registry.registerCommand(ModelCommands.TOGGLE_HIDDEN, {
            execute: (w?: Widget) => {
                const widget = viewWidget(w);
                if (!widget) return;
                const show = !this.showHidden.has(widget.id);
                if (show) this.showHidden.add(widget.id); else this.showHidden.delete(widget.id);
                widget.actionDispatcher.dispatch({ kind: 'catenarySetShowHidden', show } as never);
            },
            isToggled: (w?: Widget) => this.showHidden.has(viewWidget(w)?.id ?? ''),
            isVisible: onView
        });
        // Argument 2 (Appearance): the algorithm; without it, a pick.
        registry.registerCommand(ModelCommands.LAYOUT_VIEW, {
            execute: (w?: Widget, algorithm?: unknown) => { const widget = viewWidget(w); if (widget) void a.layoutView(widget, typeof algorithm === 'string' ? algorithm : undefined); },
            isVisible: onView
        });
        // New … Here: on the canvas with nothing selected in it (spec 0.4: a surface adds its actions when nothing is selected).
        const nothingSelectedIn = () => { const v = view(); const s = this.elements.selection; return !!v && !(s.view === v && s.ids.length); };
        registry.registerCommand(ModelCommands.NEW_INSTANCE_HERE, {
            execute: () => {
                const w = this.editors.current();
                if (w) a.newInstance(undefined, viewIdOf(w), this.editors.menuAt.get(w));
            },
            isVisible: (w?: Widget) => onView(w) && (w instanceof GLSPDiagramWidget || nothingSelectedIn())
        });
        registry.registerCommand(ModelCommands.NEW_NODE_SHAPE_HERE, {
            execute: () => {
                const w = this.editors.current();
                if (w) a.newNodeShape(viewIdOf(w), this.editors.menuAt.get(w));
            },
            isVisible: (w?: Widget) => onView(w) && (w instanceof GLSPDiagramWidget || nothingSelectedIn())
        });
        // Around the selected cards, groups, notes and view references (edges have no box); else at the canvas center.
        registry.registerCommand(ModelCommands.NEW_GROUP, {
            execute: async () => {
                const w = this.editors.current();
                if (!w) return;
                const v = viewIdOf(w);
                const s = await selectedIn(v);
                const around = s ? [...s.instances, ...s.groups, ...s.notes, ...s.references, ...s.collections, ...s.shapes, ...s.valueSets] : [];
                a.newGroup(v, around);
            },
            isVisible: onView
        });
    }

    override registerMenus(menus: MenuModelRegistry): void {
        super.registerMenus(menus);
        menus.registerSubmenu(MODEL_MENU, 'Model');
        // File and Edit entries of the model: menus.ts.
        const c = ModelCommands;
        addMenuItems(menus, MODEL_MENU_CREATE, c.NEW_VIEW.id, c.NEW_INSTANCE.id, c.PROPOSE_ALL_SHAPES.id, ['catenary.toggleModel', 'Model Explorer']);
        addMenuItems(menus, EXPLORER_SURFACE, c.DELETE_UNPLACED.id, c.PROPOSE_ALL_SHAPES.id);
        addMenuItems(menus, DIAGRAM_SURFACE, c.NEW_GROUP.id, c.NEW_INSTANCE_HERE.id, c.NEW_NODE_SHAPE_HERE.id, c.TOGGLE_HIDDEN.id, c.LAYOUT_VIEW.id);
        const o = OpenModelCommands;
        addMenuItems(menus, NavigatorContextMenu.NAVIGATION, o.OPEN_FILE_AS_MODEL.id);
        // After New File and New Folder (Theia: no order, sorted by label).
        menus.registerMenuAction(NavigatorContextMenu.NAVIGATION, { commandId: c.NEW_VIEW_IN_FOLDER.id, label: 'New View', when: 'explorerResourceIsFolder', order: 'z' });
    }

    override registerKeybindings(keybindings: KeybindingRegistry): void {
        super.registerKeybindings(keybindings);
        keybindings.registerKeybinding({ command: OpenModelCommands.UNDO.id, keybinding: 'ctrlcmd+z', context: ExplorerFocusContext.ID });
        keybindings.registerKeybinding({ command: OpenModelCommands.REDO.id, keybinding: 'ctrlcmd+shift+z', context: ExplorerFocusContext.ID });
        keybindings.registerKeybinding({ command: OpenModelCommands.REDO.id, keybinding: 'ctrlcmd+y', context: ExplorerFocusContext.ID });
        keybindings.registerKeybinding({ command: ModelCommands.RENAME.id, keybinding: 'f2', context: ExplorerFocusContext.ID });
        keybindings.registerKeybinding({ command: ModelCommands.FIND_ELEMENT.id, keybinding: 'ctrlcmd+t' });
        keybindings.registerKeybinding({ command: ModelCommands.BACK.id, keybinding: 'alt+left', when: '!editorTextFocus' });
        keybindings.registerKeybinding({ command: ModelCommands.FORWARD.id, keybinding: 'alt+right', when: '!editorTextFocus' });
        keybindings.registerKeybinding({ command: ModelCommands.NEXT_OCCURRENCE.id, keybinding: 'f3', when: '!editorTextFocus' });
        keybindings.registerKeybinding({ command: ModelCommands.PREVIOUS_OCCURRENCE.id, keybinding: 'shift+f3', when: '!editorTextFocus' });
        keybindings.registerKeybinding({ command: ModelCommands.DELETE_FROM_MODEL.id, keybinding: 'ctrlcmd+delete', context: ExplorerFocusContext.ID });
    }

    registerToolbarItems(toolbar: TabBarToolbarRegistry): void {
        const c = ModelCommands;
        const o = OpenModelCommands;
        // View editors have no toolbar items: Back/Forward are in the tool palette, Layout and Show Hidden Edges in Appearance, the
        // text of a view in Go to Source. Open/New/Recent workspace: File menu and the start panel.
        toolbar.registerItem({ id: c.COLLAPSE.id, command: c.COLLAPSE.id, tooltip: 'Collapse folders', isVisible: (w?: Widget) => w instanceof CatenaryTreeWidget } as never);
        toolbar.registerItem({
            id: c.NEW_VIEW_IN_FOLDER.id, command: c.NEW_VIEW_IN_FOLDER.id, tooltip: 'New view in the selected folder', priority: 1,
            isVisible: (w?: Widget) => w instanceof FileNavigatorWidget && this.model.isOpen
        } as never);
        // The text/form toggle: Show Text on the settings view, Show Canvas on text editors of view files and of the workspace file.
        toolbar.registerItem({ id: o.SHOW_TEXT.id, command: o.SHOW_TEXT.id, tooltip: 'Show the TriG text of the workspace file', priority: 10, isVisible: (w?: Widget) => w instanceof WorkspaceSettingsWidget } as never);
        toolbar.registerItem({ id: o.SHOW_CANVAS.id, command: o.SHOW_CANVAS.id, tooltip: 'Show the canvas (a view) or the settings (the workspace file)', priority: 10 } as never);
    }

}

/** True when a listing of elements has the focus: the Model explorer or Search. Keys: F2, Ctrl+Del (spec 0.4: no Del). */
@injectable()
export class ExplorerFocusContext implements KeybindingContext {
    static readonly ID = 'catenary.explorerFocus';
    readonly id = ExplorerFocusContext.ID;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    isEnabled(): boolean {
        return this.shell.activeWidget instanceof CatenaryTreeWidget || this.shell.activeWidget instanceof SearchWidget;
    }
}

/**
 * A file opens as what it holds that Catenary edits, from its content, not its name: a workspace in the workspace editor (the open
 * workspace: its settings), a view in its view editor. A file with several of these (normally not: a workspace and a view) asks which.
 * Other files: the next handler, the text editor. "Open With" keeps the text editor for every file.
 */
@injectable()
export class CatenaryFileOpenHandler implements OpenHandler {
    readonly id = 'catenary-file';
    readonly label = 'Catenary';
    @inject(ModelActions) protected readonly actions: ModelActions;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(QuickInputService) protected readonly quick: QuickInputService;
    @inject(WorkspaceSettingsContribution) protected readonly settings: WorkspaceSettingsContribution;

    /** Views and workspaces are TriG files. Undefined: another file, or the backend cannot read it. */
    protected async content(uri: URI): Promise<FileContent | undefined> {
        if (uri.scheme !== 'file' || uri.path.ext.toLowerCase() !== '.trig') return undefined;
        return this.model.service.fileContent(uri.path.fsPath()).catch(() => undefined);
    }

    async canHandle(uri: URI): Promise<number> {
        const c = await this.content(uri);
        return c && openModes(c).length ? 200 : 0;
    }

    async open(uri: URI): Promise<object | undefined> {
        const c = await this.content(uri);
        if (!c) return undefined;
        const name = uri.path.base;
        const items = openModes(c).map(m => m.kind === 'workspace'
            ? { label: 'Workspace', description: name, run: () => this.openWorkspace(uri) }
            : { label: `View: ${m.label}`, description: name, run: () => this.actions.openView(m.id, c.workspaceFile) });
        const pick = items.length > 1 ? await this.quick.showQuickPick(items, { placeholder: `${name} holds ${items.length} things that Catenary edits. Open it as:` }) : items[0];
        await pick?.run();
        return undefined;
    }

    protected async openWorkspace(uri: URI): Promise<void> {
        if (this.model.snapshot.file === uri.path.fsPath()) await this.settings.openView({ activate: true, reveal: true });
        else await this.actions.openModel(uri);
    }
}

