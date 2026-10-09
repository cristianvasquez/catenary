// Workspace commands, menus, keybindings and file presentations.

import { GLSPDiagramWidget, TheiaGLSPContextMenu } from '@eclipse-glsp/theia-integration';
import { Command, CommandContribution, CommandRegistry, MAIN_MENU_BAR, MenuContribution, MenuModelRegistry, MessageService, QuickInputService, SelectionService, URI } from '@theia/core';
import {
    ApplicationShell, FrontendApplication, FrontendApplicationContribution, KeybindingContribution, KeybindingContext, KeybindingRegistry,
    OpenHandler, WidgetOpenerOptions, StorageService, Widget, WidgetManager
} from '@theia/core/lib/browser';
import { PERSPECTIVE_LAYOUTS_STORAGE_KEY } from '@theia/core/lib/browser/shell/shell-layout-restorer';
import { TabBarToolbarContribution, TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { inject, injectable } from '@theia/core/shared/inversify';
import { EditorContextMenu, EditorManager, EditorWidget, EditorOpenerOptions, Range } from '@theia/editor/lib/browser';
import { NavigatorContextMenu } from '@theia/navigator/lib/browser/navigator-contribution';
import { FileNavigatorWidget } from '@theia/navigator/lib/browser/navigator-widget';
import { FileStatNode } from '@theia/filesystem/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { OutlineViewContribution } from '@theia/outline-view/lib/browser/outline-view-contribution';
import { PropertyViewContribution } from '@theia/property-view/lib/browser/property-view-contribution';
import { FileContent, mixedFileProblem, previewInWorkspace } from '@catenary/model';
import { VIEW_SCHEME } from '../common/protocol';
import { ModelActions } from './actions';
import { ViewEditors, viewIdOf } from './diagram/view-editors';
import { MarkdownExport } from './diagram/markdown-export';
import { InsertView } from './insert-view';
import { ViewHistory } from './diagram/view-history';
import { COLOR_NAMES, COLOR_ORDER, PRESETS } from './diagram/views';
import { EXPLORER_CONTEXT_MENU, FILE_EXPLORER_ID, ModelExplorerWidget, CatenaryNode } from './explorer/model-explorer';
import { FileNavigatorContribution } from '@theia/navigator/lib/browser/navigator-contribution';
import { WORKSPACE_SETTINGS_ID, WorkspaceSettingsWidget } from './prefixes/workspace-settings';
import { RecentWorkspaces } from './explorer/recent-workspaces';
import { SidePanelSizes } from './side-panel-sizes';
import { ModelFrontend } from './model-client';
import { SelectionModel } from './selection-model';
import { AppearanceContribution } from './properties/appearance-widget';
import { LinksContribution } from './properties/links-widget';
import { SearchContribution, SearchWidget } from './search/search-widget';
import { addMenuItems } from './menus';

const category = 'Model';
const cmd = (id: string, label: string, iconClass?: string): Command => ({ id, label, category, iconClass });

export namespace OpenModelCommands {
    export const OPEN = cmd('catenary.open', 'Open Workspace…');
    export const NEW = cmd('catenary.new', 'New Workspace…');
    export const OPEN_RECENT = cmd('catenary.openRecent', 'Open Recent Workspace…');
    export const OPEN_AS = cmd('catenary.openAs', 'Open as…', 'codicon codicon-go-to-file');
    export const OPEN_BESIDE = cmd('catenary.openBeside', 'Open beside…', 'codicon codicon-split-horizontal');
    export const SAVE = cmd('catenary.save', 'Save Workspace');
    export const EXPORT_MARKDOWN = cmd('catenary.exportMarkdown', 'Export Markdown…');
    export const INSERT_VIEW = cmd('catenary.insertView', 'Insert View…');
    export const WORKSPACE_SETTINGS = cmd('catenary.openWorkspaceSettings', 'Workspace Settings');
    /** RDF files from outside the workspace: read-only Turtle copies in imported/ (spec/manifest.hs §2.6). Arguments: the paths. */
    export const IMPORT_FILE = cmd('catenary.importFile', 'Import RDF Files…');
    /** File navigator: mark the selected model file or view file as imported (read only) or as own (manifest ws:imported). */
    export const MARK_IMPORTED = cmd('catenary.markImported', 'Mark as Imported');
    export const MARK_OWN = cmd('catenary.markOwn', 'Mark as Own');
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
    export const COPY_AS_RDF = cmd('catenary.copyAsRdf', 'Copy as RDF');
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

/** Discard layouts with the removed global Model sidebar once. */
const LAYOUT_VERSION = 6;
const LAYOUT_VERSION_KEY = 'catenary.layoutVersion';

export type Presentation = 'Source' | 'Model' | 'Canvas' | 'Settings';

/** One file opener for the default presentation and explicit presentation navigation. */
@injectable()
export class CatenaryFileOpenHandler implements OpenHandler {
    readonly id = 'catenary-file';
    readonly label = 'Catenary';
    @inject(ModelActions) protected readonly actions: ModelActions;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(QuickInputService) protected readonly quick: QuickInputService;
    @inject(EditorManager) protected readonly editorManager: EditorManager;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(WidgetManager) protected readonly widgets: WidgetManager;
    @inject(SelectionService) protected readonly selection: SelectionService;
    @inject(MessageService) protected readonly messages: MessageService;

    /** The file behind a document, a navigator selection, or an explicit URI/path. */
    fileOf(target?: unknown): string | undefined {
        if (typeof target === 'string') return target;
        if (target instanceof URI) return target.scheme === 'file' ? target.path.fsPath() : undefined;
        const w = target instanceof Widget ? target : this.shell.currentWidget;
        if (w instanceof EditorWidget) return w.editor.uri.scheme === 'file' ? w.editor.uri.path.fsPath() : undefined;
        if (w instanceof GLSPDiagramWidget && w.uri.scheme === VIEW_SCHEME) return this.model.snapshot.files.views.find(v => v.view === viewIdOf(w))?.path;
        if (w instanceof WorkspaceSettingsWidget) return this.model.snapshot.file;
        if (w instanceof ModelExplorerWidget) return w.file;
        if (!(w instanceof FileNavigatorWidget)) return undefined;
        const nodes = this.selection.selection;
        const node = Array.isArray(nodes) ? nodes.find(FileStatNode.is) : undefined;
        return node && !node.fileStat.isDirectory ? node.uri.path.fsPath() : undefined;
    }

    /** Menus test this synchronously: a TriG file outside the index can hold another workspace or view, and choose() inspects it. */
    hasPresentations(target?: unknown): boolean {
        const file = this.fileOf(target), s = this.model.snapshot;
        return !!file && (file === s.file || [...s.files.files, ...s.files.views].some(f => f.path === file) || file.toLowerCase().endsWith('.trig'));
    }

    /** Use the loaded file index; inspect content only for TriG files outside it. */
    protected async content(uri: URI): Promise<FileContent | undefined> {
        if (uri.scheme !== 'file') return undefined;
        const path = uri.path.fsPath(), s = this.model.snapshot;
        if (path === s.file) return { workspace: true, views: [] };
        const view = s.files.views.find(v => v.path === path);
        if (view) return { workspace: false, views: [{ id: view.view, label: uri.path.base }], workspaceFile: s.file };
        const file = s.files.files.find(f => f.path === path);
        if (file) return { workspace: false, views: [], error: file.error };
        if (uri.path.ext.toLowerCase() !== '.trig') return undefined;
        const c = await this.model.service.fileContent(path).catch(() => undefined);
        return c && (c.workspace || c.views.length) ? c : undefined;
    }

    async canHandle(uri: URI): Promise<number> {
        const c = await this.content(uri);
        return c && !c.error ? 200 : 0;
    }

    async open(uri: URI, options?: WidgetOpenerOptions & { preview?: boolean }): Promise<Widget | undefined> {
        const c = await this.content(uri);
        if (!c) return undefined;
        const problem = mixedFileProblem(c);
        if (problem) this.messages.warn(`${uri.path.base}: ${problem}`);
        if (problem || c.error || (options?.preview && (c.workspace || c.views.length) && !previewInWorkspace(c, uri.path.fsPath(), this.model.snapshot.file))) {
            return this.openSource(uri, options);
        }
        return this.present(uri, c, c.workspace ? 'Settings' : c.views.length ? 'Canvas' : 'Model', options);
    }

    /** Open as keeps the current pane; Open beside uses Theia's split placement for a new pane. */
    async choose(target?: unknown, beside = false, presentation?: Presentation): Promise<Widget | undefined> {
        const file = this.fileOf(target);
        if (!file) return undefined;
        const candidate = target instanceof Widget ? target : this.shell.currentWidget;
        const ref = candidate && this.shell.getAreaFor(candidate) === 'main' ? candidate : undefined;
        const uri = URI.fromFilePath(file), c = await this.content(uri);
        if (!c || c.error || mixedFileProblem(c)) return this.openSource(uri);
        const choices: Presentation[] = ['Source', 'Model', ...(c.views.length ? ['Canvas' as const] : []), ...(c.workspace ? ['Settings' as const] : [])];
        const pick = presentation ?? (await this.quick.showQuickPick(choices.map(label => ({ label })), { placeholder: `${uri.path.base}: ${beside ? 'Open beside' : 'Open as'}` }))?.label;
        if (!pick || !choices.includes(pick as Presentation)) return undefined;
        return this.present(uri, c, pick as Presentation, { widgetOptions: { area: 'main', ref, ...(beside ? { mode: 'split-right' } : {}) } });
    }

    async openModel(file: string): Promise<ModelExplorerWidget> {
        return await this.present(URI.fromFilePath(file), { workspace: false, views: [] }, 'Model') as ModelExplorerWidget;
    }

    async openSource(uri: URI, options?: EditorOpenerOptions & { selection?: Range }): Promise<EditorWidget> {
        const existing = this.editorManager.all.find(e => e.editor.uri.toString() === uri.toString());
        if (!existing) return this.editorManager.open(uri, options);
        if (options?.mode === 'reveal') await this.shell.revealWidget(existing.id);
        else if (options?.mode !== 'open') await this.shell.activateWidget(existing.id);
        if (options?.selection) {
            existing.editor.selection = { ...options.selection, direction: 'ltr' };
            existing.editor.revealRange(options.selection);
        }
        return existing;
    }

    protected async present(uri: URI, c: FileContent, presentation: Presentation, options?: WidgetOpenerOptions): Promise<Widget | undefined> {
        let w: Widget | undefined;
        if (presentation === 'Source') return this.openSource(uri, options);
        if (presentation === 'Model') {
            // The explorer queries the open workspace: first open the workspace that owns the file, as Settings and Canvas do.
            const owner = c.workspace ? uri.path.fsPath() : c.workspaceFile;
            if (owner && !await this.actions.openWorkspace(owner)) return undefined;
            w = await this.widgets.getOrCreateWidget<ModelExplorerWidget>(FILE_EXPLORER_ID, { file: uri.path.fsPath() });
        } else if (presentation === 'Settings') {
            if (!await this.actions.openWorkspace(uri.path.fsPath())) return undefined;
            w = await this.widgets.getOrCreateWidget<WorkspaceSettingsWidget>(WORKSPACE_SETTINGS_ID);
        } else {
            const view = c.views.length === 1 ? c.views[0] : await this.quick.showQuickPick(c.views, { placeholder: 'Open canvas' });
            if (!view) return undefined;
            return this.actions.openView(view.id, c.workspaceFile, options);
        }
        if (!w.isAttached) this.shell.addWidget(w, { area: 'main', ...options?.widgetOptions });
        if (options?.mode === 'reveal') await this.shell.revealWidget(w.id);
        else if (options?.mode !== 'open') await this.shell.activateWidget(w.id);
        return w;
    }
}

@injectable()
export class ModelContribution implements FrontendApplicationContribution, CommandContribution, MenuContribution, KeybindingContribution, TabBarToolbarContribution {
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(CatenaryFileOpenHandler) protected readonly files: CatenaryFileOpenHandler;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(ModelActions) protected readonly actions: ModelActions;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(SelectionService) protected readonly selection: SelectionService;
    @inject(WorkspaceService) protected readonly workspace: WorkspaceService;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(PropertyViewContribution) protected readonly propertyView: PropertyViewContribution;
    @inject(AppearanceContribution) protected readonly appearance: AppearanceContribution;
    @inject(LinksContribution) protected readonly links: LinksContribution;
    @inject(OutlineViewContribution) protected readonly outline: OutlineViewContribution;
    @inject(SearchContribution) protected readonly search: SearchContribution;
    @inject(SelectionModel) protected readonly elements: SelectionModel;
    @inject(ViewHistory) protected readonly history: ViewHistory;
    @inject(FileNavigatorContribution) protected readonly navigator: FileNavigatorContribution;
    @inject(RecentWorkspaces) protected readonly recent: RecentWorkspaces;
    @inject(StorageService) protected readonly storage: StorageService;
    @inject(MarkdownExport) protected readonly markdownExport: MarkdownExport;
    @inject(InsertView) protected readonly insertView: InsertView;
    @inject(SidePanelSizes) protected readonly panelSizes: SidePanelSizes;
    protected readonly showHidden = new Set<string>();

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
        await this.navigator.openView({ activate: true, reveal: true });
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

    // ------------------------------------------------------------ selections

    /** Folders selected in the Model Explorer: the class of New Instance and Delete Elements Not Placed in a View. Not model elements. */
    protected explorerFolders(): CatenaryNode[] {
        const sel = this.selection.selection;
        return Array.isArray(sel) ? sel.filter(CatenaryNode.is).filter(n => n.kind === 'folder') : [];
    }

    // ------------------------------------------------------------ commands

    registerCommands(registry: CommandRegistry): void {
        const a = this.actions;
        const open = () => this.model.isOpen;
        registry.registerCommand(OpenModelCommands.OPEN, { execute: () => a.openModel() });
        registry.registerCommand(OpenModelCommands.NEW, { execute: () => a.newModel() });
        registry.registerCommand(OpenModelCommands.OPEN_RECENT, { execute: () => a.openRecent(this.recent.paths), isEnabled: () => this.recent.paths.length > 0 });
        registry.registerCommand(OpenModelCommands.SAVE, { execute: () => a.save(), isEnabled: open });
        // The folder of the navigator selection. Arguments (CLI, scripts): source folder, destination folder (absolute paths).
        const selectedFolder = () => {
            const sel = this.selection.selection;
            const node = Array.isArray(sel) ? sel.find(FileStatNode.is) : undefined;
            return node?.fileStat.isDirectory ? node.uri.path.fsPath() : undefined;
        };
        const folderArg = (source?: unknown) => (typeof source === 'string' ? source : source instanceof URI ? source.path.fsPath() : selectedFolder());
        registry.registerCommand(OpenModelCommands.EXPORT_MARKDOWN, {
            execute: (source?: unknown, destination?: unknown) => {
                const folder = folderArg(source);
                if (folder) return this.markdownExport.exportFolder(folder, typeof destination === 'string' ? destination : undefined);
            },
            isEnabled: (source?: unknown) => !!folderArg(source), isVisible: (source?: unknown) => !!folderArg(source)
        });
        // Argument (CLI, scripts): the IRI of the view. Without it: a view picker.
        registry.registerCommand(OpenModelCommands.INSERT_VIEW, {
            execute: (iri?: unknown) => this.insertView.insert(typeof iri === 'string' ? iri : undefined),
            isEnabled: () => open() && !!this.insertView.editor(), isVisible: () => !!this.insertView.editor()
        });
        registry.registerCommand(OpenModelCommands.WORKSPACE_SETTINGS, { execute: () => this.files.choose(this.model.snapshot.file, false, 'Settings'), isEnabled: open });
        registry.registerCommand(OpenModelCommands.IMPORT_FILE, {
            execute: (...files: unknown[]) => {
                const paths = files.flat().filter((f): f is string => typeof f === 'string');
                return a.importFiles(paths.length ? paths.map(f => URI.fromFilePath(f)) : undefined);
            },
            isEnabled: open
        });
        // The file of the navigator selection, when it is a model file or a view file of the workspace.
        const selectedFile = () => {
            const sel = this.selection.selection;
            const node = Array.isArray(sel) ? sel.find(FileStatNode.is) : undefined;
            const file = node && !node.fileStat.isDirectory ? node.uri.path.fsPath() : undefined;
            const { files, views } = this.model.snapshot.files;
            return file ? [...files, ...views].find(f => f.path === file) : undefined;
        };
        registry.registerCommand(OpenModelCommands.MARK_IMPORTED, {
            execute: () => { const f = selectedFile(); if (f) void this.model.report(this.model.service.setImported(f.path, true)); },
            isVisible: () => { const f = open() ? selectedFile() : undefined; return !!f && !f.imported; }
        });
        registry.registerCommand(OpenModelCommands.MARK_OWN, {
            execute: () => { const f = selectedFile(); if (f) void this.model.report(this.model.service.setImported(f.path, false)); },
            isVisible: () => open() && !!selectedFile()?.imported
        });
        for (const [command, beside] of [[OpenModelCommands.OPEN_AS, false], [OpenModelCommands.OPEN_BESIDE, true]] as const) {
            registry.registerCommand(command, {
                execute: (target?: unknown, presentation?: Presentation) => this.files.choose(target, beside, presentation),
                isVisible: (target?: unknown) => this.files.hasPresentations(target),
                isEnabled: (target?: unknown) => this.files.hasPresentations(target)
            });
        }
        registry.registerCommand(OpenModelCommands.UNDO, { execute: () => this.model.undo(), isEnabled: () => this.model.snapshot.canUndo });
        registry.registerCommand(OpenModelCommands.REDO, { execute: () => this.model.redo(), isEnabled: () => this.model.snapshot.canRedo });
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
                const w = this.shell.currentWidget;
                if (!(w instanceof ModelExplorerWidget)) return;
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
                const w = widget ?? this.shell.currentWidget;
                if (!(w instanceof ModelExplorerWidget)) return;
                const root = w.model.root;
                if (root && 'children' in root) for (const c of (root as { children: readonly unknown[] }).children) w.model.collapseNode(c as never);
            },
            isVisible: (w?: Widget) => w instanceof ModelExplorerWidget
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

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerSubmenu(MODEL_MENU, 'Model');
        // File and Edit entries of the model: menus.ts.
        const c = ModelCommands;
        addMenuItems(menus, MODEL_MENU_CREATE, c.NEW_VIEW.id, c.NEW_INSTANCE.id, c.PROPOSE_ALL_SHAPES.id);
        addMenuItems(menus, EXPLORER_SURFACE, c.DELETE_UNPLACED.id, c.PROPOSE_ALL_SHAPES.id);
        addMenuItems(menus, DIAGRAM_SURFACE, c.NEW_GROUP.id, c.NEW_INSTANCE_HERE.id, c.NEW_NODE_SHAPE_HERE.id, c.TOGGLE_HIDDEN.id, c.LAYOUT_VIEW.id);
        addMenuItems(menus, [...TheiaGLSPContextMenu.CONTEXT_MENU, 'catenary_3_clipboard'], c.COPY_AS_RDF.id);
        const o = OpenModelCommands;
        addMenuItems(menus, NavigatorContextMenu.NAVIGATION, o.OPEN_AS.id, o.OPEN_BESIDE.id);
        for (const path of [EditorContextMenu.NAVIGATION, [...EXPLORER_CONTEXT_MENU, '0_file'], [...TheiaGLSPContextMenu.CONTEXT_MENU, 'catenary_0_file']]) {
            addMenuItems(menus, path, o.OPEN_AS.id, o.OPEN_BESIDE.id);
        }
        // After New File and New Folder (Theia: no order, sorted by label).
        menus.registerMenuAction(NavigatorContextMenu.NAVIGATION, { commandId: c.NEW_VIEW_IN_FOLDER.id, label: 'New View', when: 'explorerResourceIsFolder', order: 'z' });
        addMenuItems(menus, NavigatorContextMenu.MODIFICATION, o.MARK_IMPORTED.id, o.MARK_OWN.id);
        menus.registerMenuAction(NavigatorContextMenu.MODIFICATION, { commandId: o.EXPORT_MARKDOWN.id, when: 'explorerResourceIsFolder', order: 'c' });
        menus.registerMenuAction(EditorContextMenu.MODIFICATION, { commandId: o.INSERT_VIEW.id, order: 'a' });
    }

    registerKeybindings(keybindings: KeybindingRegistry): void {
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
        // File presentations share navigation controls. Canvas actions remain in the palette and Appearance.
        toolbar.registerItem({ id: c.COLLAPSE.id, command: c.COLLAPSE.id, tooltip: 'Collapse folders', isVisible: (w?: Widget) => w instanceof ModelExplorerWidget } as never);
        toolbar.registerItem({
            id: c.NEW_VIEW_IN_FOLDER.id, command: c.NEW_VIEW_IN_FOLDER.id, tooltip: 'New view in the selected folder', priority: 1,
            isVisible: (w?: Widget) => w instanceof FileNavigatorWidget && this.model.isOpen
        } as never);
        for (const command of [o.OPEN_AS, o.OPEN_BESIDE]) {
            toolbar.registerItem({ id: command.id, command: command.id, tooltip: command.label, priority: 10 });
        }
    }

}

/** True when a listing of elements has the focus: the Model explorer or Search. Keys: F2, Ctrl+Del (spec 0.4: no Del). */
@injectable()
export class ExplorerFocusContext implements KeybindingContext {
    static readonly ID = 'catenary.explorerFocus';
    readonly id = ExplorerFocusContext.ID;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    isEnabled(): boolean {
        return this.shell.activeWidget instanceof ModelExplorerWidget || this.shell.activeWidget instanceof SearchWidget;
    }
}

