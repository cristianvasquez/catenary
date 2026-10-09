// User actions with dialogs and pickers. Commands, the explorer and the canvas call these.
// Port of the command part of claude-attempt/src/ui/app.ts, with Theia dialogs and quick pick.

import { CommandService, MessageService, QuickInputButton, QuickInputService, QuickPickItem, QuickPickSeparator, URI } from '@theia/core';
import { ConfirmDialog, SingleTextInputDialog, WidgetOpenerOptions } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FileDialogService } from '@theia/filesystem/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import {
    COMMON_DATATYPES, CommandResult, baseName, dirName, relativePath, freeViewFile, copyViewFile, viewFileInput, VIEW_EXT, SimpleRange, iriId, alternativesOf, orRange, propertyNodeId, targetCard, rangeKey, rangeText, EditCommand, LogicalOperator, Migration, NODE_KINDS, NodeShapePatch, PathJSON, PropertyShapePatch, NewInstance, NewShapeTarget, Point, Range, ShapesModel, Side, byLabel, compactIri, expandIri, formatPath, labelProblem, SEARCH_KINDS, SEARCH_KIND_NAMES, type SearchHit, hitCard, boxes, nextCardinality, termIri, classIri, parseIri, rangeOfShape, shortIri, cardOf, VIEW_CLASS, localName, type PropertyShape, type View
} from '@catenary/model';
import type { GLSPDiagramWidget } from '@eclipse-glsp/theia-integration';
import { LAYOUT_ALGORITHMS } from '../common/protocol';
import { LayoutPreferences } from './diagram/layout-preferences';
import { showPopupPicker } from './diagram/popup-picker';
import { ViewEditors } from './diagram/view-editors';
import { FollowUp, FollowUpField } from './follow-up';
import { ModelFrontend } from './model-client';
import { SelectionModel } from './selection-model';

const WORKSPACE_FILTER = { 'Workspace (TriG)': ['trig'] };
/** The formats that Catenary reads (rdf-files RDF_FORMATS). */
const IMPORT_FILTER = { 'RDF files': ['ttl', 'turtle', 'trig', 'nt', 'nq', 'jsonld', 'json', 'n3', 'rdf', 'owl', 'xml'] };

type PickItem = QuickPickItem & { run?: () => unknown };
type Creator = { label: string; run: (text: string) => Promise<unknown> };
/** Client coordinates: pickers open there, next to the element, instead of at the top of the window. */
type Anchor = { x: number; y: number };

/** Row buttons of Find Element: Show, Open in… (F12). */
const FIND_BUTTONS: QuickInputButton[] = [
    { iconClass: 'codicon codicon-eye', tooltip: 'Show (Alt+Enter)' },
    { iconClass: 'codicon codicon-go-to-file', tooltip: 'Open in…' }
];

@injectable()
export class ModelActions {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(SelectionModel) protected readonly selection: SelectionModel;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(QuickInputService) protected readonly quick: QuickInputService;
    @inject(CommandService) protected readonly commands: CommandService;
    @inject(LayoutPreferences) protected readonly layoutPreferences: LayoutPreferences;
    @inject(FollowUp) protected readonly follow: FollowUp;
    @inject(FileDialogService) protected readonly fileDialog: FileDialogService;
    @inject(WorkspaceService) protected readonly workspace: WorkspaceService;

    protected get meta() { return this.model.meta; }
    protected get service() { return this.model.service; }

    // ------------------------------------------------------------ files

    /** Before another workspace replaces the current one: ask when there are unsaved changes. */
    protected async canReplaceModel(): Promise<boolean> {
        return !this.model.snapshot.dirty || this.confirm('Discard changes?', 'The workspace has unsaved changes.', 'Discard');
    }

    protected async pickFile(title: string, filters: Record<string, string[]>, uri?: URI): Promise<string | undefined> {
        const target = uri ?? await this.fileDialog.showOpenDialog({ title, canSelectFiles: true, canSelectFolders: false, filters }, await this.workspaceRoot());
        return target?.path.fsPath();
    }

    protected async saveFile(title: string, filters: Record<string, string[]>, inputValue?: string): Promise<string | undefined> {
        return (await this.fileDialog.showSaveDialog({ title, filters, inputValue }, await this.workspaceRoot()))?.path.fsPath();
    }

    /**
     * Import RDF files (spec/manifest.hs §2.6): for each, a read-only Turtle copy in imported/, marked as imported, with IRIs for its
     * blank nodes. The dialog selects one or more files. A message names the copies and the prefixes that the workspace got.
     * `uris`: the files, without a dialog.
     */
    async importFiles(uris?: URI[]): Promise<void> {
        const picked = uris ?? await this.fileDialog.showOpenDialog(
            { title: 'Import RDF Files', canSelectFiles: true, canSelectFolders: false, canSelectMany: true, filters: IMPORT_FILTER }, await this.workspaceRoot());
        const sources = (Array.isArray(picked) ? picked : picked ? [picked] : []).map(u => u.path.fsPath());
        if (!sources.length) return;
        const r = await this.model.service.importFiles(sources);
        if (!r.ok) return void this.messages.error(r.error);
        const ws = this.model.snapshot.file;
        const copies = r.files.map(f => (ws && relativePath(dirName(ws), f)) ?? baseName(f)).join(', ');
        const prefixes = r.prefixes.length ? ` Prefixes added: ${r.prefixes.map(p => `${p}:`).join(' ')}.` : '';
        this.messages.info(`Imported as ${copies}, read only.${prefixes}`);
    }

    async openModel(uri?: URI): Promise<void> {
        if (!await this.canReplaceModel()) return;
        const file = await this.pickFile('Open workspace', WORKSPACE_FILTER, uri);
        if (file && await this.model.report(this.model.service.open(file))) await this.afterOpen();
    }

    /**
     * Make `file` the open workspace for a document that the caller then opens: no default canvas. False: the user kept the
     * current workspace, or the open failed.
     */
    async openWorkspace(file: string): Promise<boolean> {
        if (this.model.snapshot.file === file) return true;
        if (!await this.canReplaceModel() || !await this.model.report(this.model.service.open(file))) return false;
        this.reportWarnings();
        return true;
    }

    /**
     * Open the view `id`. When the open workspace does not have it, first open `workspaceFile`: the workspace that reads the file of
     * the view (FileContent). A view without a workspace: a message.
     */
    async openView(id: string, workspaceFile?: string, options?: WidgetOpenerOptions): Promise<GLSPDiagramWidget | undefined> {
        const has = async () => id in await this.model.service.viewLabels();
        if (!this.model.isOpen || !await has()) {
            if (!workspaceFile) {
                this.messages.warn('This view is in no workspace. Move its file into the folder of a workspace, then open the workspace.');
                return;
            }
            if (!await this.openWorkspace(workspaceFile)) return;
            if (!await has()) {
                this.messages.warn(`The workspace ${baseName(workspaceFile)} does not read this view. See the warnings of the workspace.`);
                return;
            }
        }
        return this.editors.open(id, options?.mode ?? 'activate', options);
    }

    /** Pick one of the recent workspace files and open it. */
    async openRecent(paths: readonly string[]): Promise<void> {
        const items = paths.map(path => ({ label: baseName(path), description: dirName(path), path }));
        const pick = await this.quick.showQuickPick(items, { placeholder: 'Open recent workspace' });
        if (pick) await this.openModel(URI.fromFilePath(pick.path));
    }

    /**
     * A new workspace file: the name, then the file of each kind of new subject (NewWorkspaceDialog), an empty file for each, and
     * views/main.view.trig with a view "Main". Opens the view.
     */
    async newModel(): Promise<void> {
        if (!await this.canReplaceModel()) return;
        const picked = await this.saveFile('New workspace', WORKSPACE_FILTER, 'workspace.catenary.trig');
        // The save dialog does not add the extension of the filter.
        const file = picked?.replace(/(\.trig)?$/, '.trig');
        if (!file) return;
        const placement = await this.askPlacement(baseName(file).replace(/\.trig$/, ''));
        if (placement && await this.model.report(this.model.service.create(file, placement))) await this.afterOpen();
    }

    /** The New Workspace dialog: the file of each kind of new subject. Undefined: canceled. */
    protected async askPlacement(name: string): Promise<Record<'shapes' | 'concepts' | 'instances', string> | undefined> {
        // Loaded here: the dialog module needs the DOM, and the tests of this file run without it.
        const { NewWorkspaceDialog } = await import('./prefixes/workspace-placement');
        return new NewWorkspaceDialog(name).open();
    }

    async save(): Promise<void> {
        if (!await this.model.report(this.model.service.save())) return;
        const count = this.model.snapshot.counts.violations;
        if (count) this.messages.warn(`Saved. The model is not valid: ${count} violations (see Problems).`);
    }

    /** Report an error; show new import warnings. */
    protected async report(p: Promise<CommandResult>): Promise<void> {
        const before = new Set(this.model.snapshot.warnings);
        if (!await this.model.report(p)) return;
        const added = this.model.snapshot.warnings.filter(w => !before.has(w));
        if (added.length) this.messages.warn(added.join(' '));
    }

    protected async afterOpen(): Promise<void> {
        const first = (await this.model.viewsSorted())[0];
        if (first) this.editors.open(first.id);
        this.reportWarnings();
    }

    protected reportWarnings(): void {
        if (this.model.snapshot.warnings.length) this.messages.warn(`${this.model.snapshot.warnings.length} warnings: ${this.model.snapshot.warnings.join(' ')}`);
    }

    protected async workspaceRoot() {
        const roots = await this.workspace.roots;
        return roots[0];
    }

    // ------------------------------------------------------------ dialogs

    async confirm(title: string, msg: string, ok: string): Promise<boolean> {
        return !!await new ConfirmDialog({ title, msg, ok, cancel: 'Cancel' }).open();
    }

    /** Ask for a label. */
    async askLabel(title: string, initial = ''): Promise<string | undefined> {
        const dialog = new SingleTextInputDialog({
            title, initialValue: initial,
            validate: value => labelProblem(value) ?? ''
        });
        return dialog.open();
    }

    // ------------------------------------------------------------ search

    /**
     * Find Element (F8, Ctrl+T): all things, one section per kind; the picker filters by label, type and IRI. Enter adds the pick to
     * the current view (an element on it: selects it there), Ctrl+Enter adds it and keeps the picker open. Alt+Enter, or no view: show
     * the element. Row buttons: Show, Open in….
     */
    async findElement(): Promise<void> {
        type Item = QuickPickItem & { hit: SearchHit };
        const view = this.editors.currentViewId();
        const hits = await this.service.search();
        const describe = (h: SearchHit) => [h.types.map(localName).join(', '), view && h.views.includes(view) ? 'on this view' : ''].filter(Boolean).join(' · ');
        const items = SEARCH_KINDS.flatMap(kind => {
            const of = hits.filter(h => h.kind === kind);
            return of.length ? [{ type: 'separator', label: SEARCH_KIND_NAMES[kind] } as const,
                ...of.map((h): Item => ({ hit: h, label: h.label, detail: h.iri, buttons: FIND_BUTTONS, description: describe(h) }))] : [];
        });
        const pick = this.quick.createQuickPick<Item>();
        pick.title = view ? 'Enter: add to the view · Ctrl+Enter: add more · Alt+Enter: show' : 'Enter: show';
        pick.placeholder = 'Find an element: label, type or IRI';
        pick.matchOnDescription = pick.matchOnDetail = true;
        pick.keepScrollPosition = true;
        pick.items = items;
        // The accept event has no modifiers: keep those of the last key or click.
        let mods = { ctrl: false, alt: false };
        const keys = (e: KeyboardEvent | MouseEvent) => { mods = { ctrl: e.ctrlKey || e.metaKey, alt: e.altKey }; };
        for (const type of ['keydown', 'keyup', 'mousedown'] as const) window.addEventListener(type, keys, true);
        pick.onDidHide(() => {
            for (const type of ['keydown', 'keyup', 'mousedown'] as const) window.removeEventListener(type, keys, true);
            pick.dispose();
        });
        pick.onDidAccept(async () => {
            const hit = pick.activeItems[0]?.hit;
            if (!hit) return;
            const { ctrl, alt } = mods;
            if (!ctrl || !view || alt) pick.hide();
            if (!view || alt) return void await this.editors.show(hit.id);
            if (!await this.place(view, hit)) return;
            // The hits with the same card (a node shape and its property shapes), or the view, are on the view now.
            const card = hitCard(hit);
            for (const item of items) {
                if (!('hit' in item) || item.hit.views.includes(view) || (card ? hitCard(item.hit) !== card : item.hit !== hit)) continue;
                item.hit.views.push(view);
                item.description = describe(item.hit);
            }
            // The same item objects: the picker keeps its active row.
            if (ctrl) pick.items = items;
        });
        pick.onDidTriggerItemButton(async ({ item, button }) => {
            const { hit } = item as Item;
            pick.hide();
            const target = { ids: [hit.id] };
            if (button === FIND_BUTTONS[0]) await this.editors.show(hit.id);
            else await this.commands.executeCommand('catenary.openIn', target);
        });
        pick.show();
    }

    /**
     * A hit of Find Element on a view: a view as a view reference, else its card. A card or reference that the view has already:
     * selected there, without the focus (the picker stays open). False: nothing was added or selected.
     */
    protected async place(view: string, hit: SearchHit): Promise<boolean> {
        const card = hitCard(hit);
        if (hit.views.includes(view)) {
            // A view: its reference box (the canvas maps elements to their cards, not views to their references).
            const shown = card ?? boxes(await this.service.view(view), 'reference').find(r => r.target === hit.id)?.id;
            if (shown) await this.editors.reveal(view, [shown], 'reveal');
            return !!shown;
        }
        if (hit.id === view) {
            this.messages.info('A view cannot show a reference to itself.');
            return false;
        }
        const w = await this.viewEditor(view);
        const at = this.editors.dropPoint(w);
        const r = card ? await this.executeAndSelect(view, { kind: 'addToView', view, ids: [card], at }, [card])
            : await this.executeAndSelect(view, { kind: 'addViewReference', view, target: hit.id, at });
        if (!r.ok) this.messages.warn(r.error);
        return r.ok;
    }

    // ------------------------------------------------------------ instances

    /**
     * New instance "unnamed <class> N", selected. No name dialog: rename it in place (F2) or in the properties.
     * Asks for the class if not given. With a view, it is placed at `at` (default: the canvas center).
     */
    async newInstance(classIri?: string, view?: string, at?: Point): Promise<void> {
        classIri ??= await this.pickClass();
        if (!classIri) return;
        if (classIri === VIEW_CLASS) return this.newView();
        this.useClass(classIri);
        const label = await this.service.newLabel('instance', { classIri });
        if (!view) {
            const r = await this.model.execute({ kind: 'createInstance', classIri, label });
            if (r.ok && r.id) await this.followUp(r.id);
            return;
        }
        const w = await this.viewEditor(view);
        const r = await this.executeAndSelect(view, { kind: 'createInstance', classIri, label, view, at: at ?? this.editors.center(w) });
        if (r.ok && r.id) await this.followUp(r.id, 'label', view);
    }

    /** Classes of the last created instances, the last first (this window, not stored). */
    protected readonly recentClasses: string[] = [];

    /** Record a class used to create an instance: the class picker lists it first. */
    useClass(classIri: string): void {
        const i = this.recentClasses.indexOf(classIri);
        if (i >= 0) this.recentClasses.splice(i, 1);
        this.recentClasses.unshift(classIri);
    }

    /** Class picker with filter (label and IRI): the classes used last first, then the others in palette order. */
    protected async pickClass(): Promise<string | undefined> {
        const rank = (iri: string) => { const i = this.recentClasses.indexOf(iri); return i < 0 ? Infinity : i; };
        const classes = this.meta.classes.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c.iri) - rank(b.c.iri) || a.i - b.i).map(x => x.c);
        const pick = await this.quick.showQuickPick(classes.map(c => ({ label: c.name, description: c.iri, iri: c.iri })),
            { placeholder: 'Class of the new instance', matchOnDescription: true });
        return pick?.iri;
    }

    /**
     * Follow-up of a creation (spec/ui-manifest.hs §4.6, follow-up.ts): the first field of the new element gets the focus; with no
     * field for its label, a label dialog. `view`: the gesture was on that canvas.
     */
    async followUp(id: string, field: FollowUpField = 'label', view?: string): Promise<void> {
        if (!await this.follow.created(id, field, view) && field === 'label') await this.rename(id);
    }

    /** Rename an instance, view, node shape or value set in a dialog. */
    async rename(id: string): Promise<void> {
        const [row] = await this.service.elementRows([id]);
        const label = row?.label;
        if (label === undefined) return;
        const next = await this.askLabel(row.kind === 'view' ? 'Rename view' : 'Rename', label);
        if (next && next !== label) await this.model.execute({ kind: 'rename', id, label: next });
    }

    /**
     * Delete elements of any kind, after one confirmation that lists them and where they are used. One undo step. Instances and relations
     * leave the model and all views; views take the references to them; shapes elements leave the shapes files (the data does not change).
     */
    async delete(ids: string[]): Promise<void> {
        const { lines, notes } = await this.service.deletePlan(ids);
        if (!lines.length) return;
        const msg = `This deletes:\n\n${lines.join('\n')}${notes.length ? '\n\n' + notes.join('\n') : ''}`;
        if (!await this.confirm('Delete', msg, `Delete ${lines.length}`)) return;
        await this.model.execute({ kind: 'delete', ids });
    }

    // ------------------------------------------------------------ relations

    /** Relation between two instances: only the types that the shapes permit. */
    async connect(source: string, target: string, view?: string, anchor?: Anchor): Promise<void> {
        const free = await this.service.relationChoices(source, target);
        if (!free) return;
        if ('error' in free) { this.messages.warn(free.error); return; }
        let predicate = free.types[0].path;
        if (free.types.length > 1) {
            const pick = await this.pick(free.title, free.types.map(r => ({ label: r.name, description: r.path, run: () => r.path })), [], anchor);
            if (typeof pick !== 'string') return;
            predicate = pick;
        }
        if (view) await this.executeAndSelect(view, { kind: 'createRelation', subject: source, predicate, object: target, view });
        else await this.model.execute({ kind: 'createRelation', subject: source, predicate, object: target });
    }

    /** Move an end of a relation to the instance `to` (same instance: only the side changes). Selects the relation after it. */
    async reconnect(relation: string, end: 'source' | 'target', to: string, view: string, side: Side): Promise<void> {
        await this.executeAndSelect(view, { kind: 'reconnectRelation', relation, end, to, view, side });
    }

    /**
     * Halo expand button of a card: the instances related to `from` (dir 'in': subjects of its relations; 'out': objects) that the view
     * does not show. A pick adds its card at `at` and shows its relations to `from`; "Show all N" does it for all. Creates nothing.
     */
    async expand(dir: 'out' | 'in', from: string, view: string, at: Point, anchor: Anchor): Promise<void> {
        const choices = await this.service.neighborChoices(view, from, dir);
        if (!choices) return;
        const { title, items } = choices;
        await this.pick(title, [
            ...(items.length > 1 ? [{ label: `Show all ${items.length} in the view`, run: () => this.showRelations(view, items.flatMap(i => i.ids), at) }] : []),
            ...items.map(i => ({ label: i.label, description: i.description, run: () => this.showRelations(view, i.ids, at) }))
        ], [], anchor);
    }

    /**
     * Halo incoming button of a node shape card: the node shapes with a property to `from` that the view does not show. A pick adds its
     * card at `at`; "Show all N" adds all. The lines to `from` are placed in the same step (arrival, ADR 0014). Creates nothing.
     */
    async expandShape(from: string, view: string, at: Point, anchor: Anchor): Promise<void> {
        const choices = await this.service.shapeSourceChoices(view, from);
        if (!choices) return;
        const { title, items } = choices;
        const add = (ids: string[]) => this.executeAndSelect(view, { kind: 'addToView', view, ids, at }, ids);
        await this.pick(title, [
            ...(items.length > 1 ? [{ label: `Show all ${items.length} in the view`, run: () => add(items.flatMap(i => i.ids)) }] : []),
            ...items.map(i => ({ label: i.label, description: i.description, run: () => add(i.ids) }))
        ], [], anchor);
    }

    /** Halo button of an instance card: applicable node shapes not shown in the view. */
    async expandTargetShapes(from: string, view: string, at: Point, anchor: Anchor): Promise<void> {
        const choices = await this.service.shapeTargetChoices(view, from);
        if (!choices) return;
        const { title, items } = choices;
        const add = (ids: string[]) => this.executeAndSelect(view, { kind: 'addToView', view, ids, at }, ids);
        await this.pick(title, [
            ...(items.length > 1 ? [{ label: `Show all ${items.length} in the view`, run: () => add(items.flatMap(i => i.ids)) }] : []),
            ...items.map(i => ({ label: i.label, description: i.description, run: () => add(i.ids) }))
        ], [], anchor);
    }

    /**
     * Link button (drag released on empty canvas, or click): pick the instance at the other end of a relation, an existing instance of
     * the class at that end or a new one (the typed text, else "unnamed <class> N").
     * `dir` 'out': `from` is the subject; 'in': `from` is the object. A new or absent other end is placed at `at`.
     */
    async connectPoint(dir: 'out' | 'in', from: string, view: string, at: Point, anchor?: Anchor): Promise<void> {
        const choices = await this.service.linkChoices(dir, from, view);
        if (!choices) return;
        if ('error' in choices) { this.messages.warn(choices.error); return; }
        const items: (PickItem | QuickPickSeparator)[] = [];
        const creators: Creator[] = [];
        for (const section of choices.sections) {
            const relate = (end: string | NewInstance) => this.executeAndSelect(view, {
                kind: 'createRelation', predicate: section.predicate, view, at, ...(dir === 'out' ? { subject: from, object: end } : { subject: end, object: from })
            });
            items.push({ type: 'separator', label: section.header });
            for (const c of section.candidates) items.push({ label: c.label, description: c.description, run: () => relate(c.id) });
            const create = section.create;
            if (!create) continue;
            const end = (label: string): NewInstance => ({ classIri: create.classIri, label, ...(create.scheme ? { inScheme: create.scheme } : {}) });
            creators.push({ label: create.creator, run: text => relate(end(text)) });
            items.push({ label: create.item, description: section.name, run: () => relate(end(create.label)) });
        }
        await this.pick(choices.title, items, creators, anchor);
    }

    /** Run a command; on success, select `ids` (default: the created element) in `view`, when the editor of `view` shows them. */
    protected async executeAndSelect(view: string, command: EditCommand, ids?: string[]): Promise<CommandResult> {
        const w = await this.viewEditor(view);
        const r = await this.model.execute(command);
        const select = ids ?? (r.ok && r.id ? [r.id] : []);
        if (r.ok && select.length) {
            await this.editors.whenShown(w, select);
            this.selection.set({ view, ids: select });
        }
        return r;
    }

    protected async viewEditor(view: string) {
        return this.editors.find(view) ?? this.editors.open(view);
    }

    // ------------------------------------------------------------ views

    /**
     * New view "unnamed view N", opened. A dialog asks for the name of its view file, in `folder` (default: views/). The file dialog is
     * the only one: no label follow-up. Rename the view (F2) in the view editor or Properties when you want; the file name does not
     * change, the read finds the view by the content of the file.
     */
    async newView(folder?: string): Promise<void> {
        const file = await this.askViewFile(folder);
        if (file === undefined) return;
        const r = await this.model.execute({ kind: 'createView', label: await this.service.newLabel('view'), file });
        if (!r.ok) return;
        await this.editors.open(r.id!);
    }

    /**
     * Ask for the file of a new view: a path relative to the workspace folder, proposed in `folder` (default: views/), or next to `copyOf`
     * (a duplicate: `<file>-copy`). A name without `.trig` gets it. Undefined: canceled. The backend checks that the file is new and in
     * the workspace folder.
     */
    protected async askViewFile(folder?: string, copyOf?: string): Promise<string | undefined> {
        const wsFile = this.model.snapshot.file;
        if (!wsFile) return undefined;
        const root = dirName(wsFile);
        const known = new Set([...this.model.snapshot.files.files, ...this.model.snapshot.files.views].map(f => relativePath(root, f.path)));
        const source = copyOf && relativePath(root, copyOf);
        const initial = source ? copyViewFile(source, known) : freeViewFile(folder === undefined ? 'views' : relativePath(root, folder) ?? '', known);
        const name = baseName(initial);
        const ext = /\.view\.trig$/i.test(initial) ? VIEW_EXT : '.trig';
        const value = await new SingleTextInputDialog({
            title: copyOf ? 'Duplicate View: file name' : 'New View: file name',
            initialValue: initial,
            initialSelectionRange: { start: initial.length - name.length, end: initial.length - ext.length },
            validate: v => !v.trim() ? 'Type a file name.' : known.has(viewFileInput(v)) ? `${viewFileInput(v)} exists.` : ''
        }).open();
        return value === undefined ? undefined : viewFileInput(value);
    }

    /**
     * Node shapes proposed from the data for `classes` (default: every class of the data without a node shape). Then a new view
     * "proposed shapes" shows the new shapes, with the Layered layout, fitted to the screen and selected.
     */
    async proposeShapes(classes?: string[]): Promise<void> {
        const r = await this.model.execute({ kind: 'proposeShapes', classes });
        if (!r.ok) return;
        const ids = r.ids ?? [];
        const n = ids.length;
        this.messages.info(`Proposed ${n} node shape${n === 1 ? '' : 's'} from the data, in the primary shapes file. They describe the current data, not its rules: check them.`);
        if (n) await this.showInNewView('proposed shapes', ids);
    }

    /** New view `label` (a free label) with the cards of `ids`, laid out (Layered), fitted to the screen, the cards selected. */
    protected async showInNewView(label: string, ids: string[]): Promise<void> {
        const v = await this.model.execute({ kind: 'createView', label: await this.service.newLabel('view', { base: label }) });
        if (!v.ok) return;
        const view = v.id!;
        const w = await this.editors.open(view);
        await w.actionDispatcher.onceModelInitialized();
        const r = await this.executeAndSelect(view, { kind: 'addToView', view, ids, at: this.editors.center(w) }, ids);
        if (!r.ok) return;
        const laidOut = this.editors.whenChanged(w);
        await this.layoutView(w, 'layered');
        await laidOut;
        await this.editors.fit(w);
    }

    /**
     * A copy of the view `id` ("<label> copy"), opened. A dialog asks for the name of its view file, proposed next to the file of the
     * view (`<name>-copy`). No label follow-up: rename the copy when you want.
     */
    async duplicateView(id: string): Promise<void> {
        const source = this.model.snapshot.files.views.find(v => v.view === id)?.path;
        const file = await this.askViewFile(undefined, source);
        if (file === undefined) return;
        const r = await this.model.execute({ kind: 'duplicateView', id, file });
        if (!r.ok) return;
        await this.editors.open(r.id!);
    }

    /** Arrow from one box of the view to another; one end is a note. */
    async createArrow(view: string, from: string, to: string): Promise<void> {
        await this.executeAndSelect(view, { kind: 'createArrow', view, from, to });
    }

    /** Link boxes to files (paths), one below the other: a view file is a view reference, another file a file reference (ADR 0004). */
    async addFileReferences(view: string, files: string[], at: Point): Promise<void> {
        const ids: string[] = [];
        for (const [i, file] of files.entries()) {
            const target = this.model.snapshot.files.views.find(v => v.path === file)?.view;
            const place = { x: at.x, y: at.y + i * 120 };
            const r = await this.model.execute(target ? { kind: 'addViewReference', view, target, at: place } : { kind: 'addFileReference', view, file, at: place });
            if (!r.ok) { this.messages.warn(r.error); return; }
            if (r.id) ids.push(r.id);
        }
        if (ids.length) this.selection.set({ view, ids });
    }

    async addViewReference(view: string, target: string, at: Point): Promise<void> {
        await this.executeAndSelect(view, { kind: 'addViewReference', view, target, at });
    }

    async addToView(view: string, ids: string[], at?: Point): Promise<void> {
        const w = await this.viewEditor(view);
        await this.executeAndSelect(view, { kind: 'addToView', view, ids, at: at ?? this.editors.dropPoint(w) }, ids);
    }

    /** Add the subject and object of the relations to the view (around `at`) and show the edges. */
    async showRelations(view: string, ids: string[], at: Point): Promise<void> {
        await this.executeAndSelect(view, { kind: 'showRelations', view, ids, at }, ids);
    }

    /** Collect cards (and collections) of a view into one collection, selected. */
    async collect(view: string, ids: string[]): Promise<void> {
        await this.executeAndSelect(view, { kind: 'collect', view, ids });
    }

    /** Take members out of collections (all members without `members`). The cards taken out are selected. */
    async uncollect(view: string, collections: string[], members?: string[]): Promise<void> {
        const ids: string[] = [];
        for (const id of collections) {
            const r = await this.model.execute({ kind: 'uncollect', view, id, ids: members });
            if (r.ok) ids.push(...(r.ids ?? []));
        }
        if (!ids.length) return;
        await this.editors.whenShown(await this.viewEditor(view), ids);
        this.selection.set({ view, ids });
    }

    /** Apply Layout: pick an algorithm, then the view editor lays out its view with the spacing preference (one undo step). */
    /** Apply Layout with `algorithm` (an id of LAYOUT_ALGORITHMS); without it, a pick. */
    async layoutView(w: GLSPDiagramWidget, algorithm?: string): Promise<void> {
        const id = LAYOUT_ALGORITHMS.find(a => a.id === algorithm)?.id ?? (await this.quick.showQuickPick(
            LAYOUT_ALGORITHMS.map(a => ({ label: a.label, description: a.description, id: a.id })), { placeholder: 'Layout algorithm' }))?.id;
        if (id) w.actionDispatcher.dispatch({ kind: 'catenaryLayoutView', algorithm: id, spacing: this.layoutPreferences.spacing } as never);
    }

    /** New group "unnamed group N" around the selected cards, else at the canvas center. */
    async newGroup(view: string, around: string[]): Promise<void> {
        const w = await this.viewEditor(view);
        const c = this.editors.center(w);
        const r = await this.executeAndSelect(view, {
            kind: 'createGroup', view, label: await this.service.newLabel('group', { view }), around,
            rect: { x: c.x - 400, y: c.y - 250, width: 800, height: 500 }
        });
        if (r.ok && r.id) await this.followUp(r.id, 'label', view);
    }

    info(text: string): void {
        this.messages.info(text);
    }

    // ------------------------------------------------------------ shapes

    /** New node shape in a view (default: the canvas center). */
    async newNodeShape(view: string, at?: Point): Promise<void> {
        const w = await this.viewEditor(view);
        const r = await this.executeAndSelect(view, { kind: 'createNodeShape', label: await this.service.newLabel('shape'), view, at: at ?? this.editors.center(w) });
        if (r.ok && r.id) await this.followUp(r.id, 'label', view);
    }

    /**
     * Ask for a property path: a known predicate, or typed text in SPARQL path syntax (prefix:local, <iri>, a/b, a|b, ^a). Opens at
     * `anchor` when given. Undefined: cancelled.
     */
    async askPath(title: string, initial?: PathJSON): Promise<PathJSON | undefined> {
        type Item = QuickPickItem & { path?: PathJSON };
        const known = (await this.service.knownPredicates()).map(k => ({ label: compactIri(k.iri), description: k.where, path: { kind: 'iri', iri: k.iri } as PathJSON }))
            .sort((a, b) => a.label.localeCompare(b.label));
        return new Promise(resolve => {
            const qp = this.quick.createQuickPick<Item>();
            qp.title = title;
            qp.placeholder = 'Property name, prefix:local or <iri>';
            qp.matchOnDescription = true;
            if (initial) qp.value = formatPath(initial);
            const refresh = () => {
                const text = qp.value.trim();
                const iri = termIri(text);
                const typed: Item[] = iri ? [{ label: `Use ${text}`, description: iri, alwaysShow: true, path: { kind: 'iri', iri } }] : [];
                qp.items = [...typed, ...(typed.length ? [{ type: 'separator', label: 'Known predicates' } as never] : []), ...known];
                // Enter takes the typed path: without an active item, Enter selects nothing.
                if (typed[0]?.path) qp.activeItems = [typed[0]];
            };
            refresh();
            qp.onDidChangeValue(refresh);
            let done = false;
            qp.onDidAccept(() => {
                const item = qp.selectedItems[0] ?? qp.activeItems[0];
                if (!item?.path) return;
                done = true;
                qp.hide();
                resolve(item.path);
            });
            qp.onDidHide(() => { if (!done) resolve(undefined); qp.dispose(); });
            qp.show();
        });
    }

    /** Completions for an inline path input: known predicates as prefix:local. */
    async pathOptions(): Promise<string[]> {
        return (await this.service.knownPredicates()).map(k => compactIri(k.iri)).sort();
    }

    /** Completions for an inline target input: datatypes, node kinds, value sets, classes. */
    async targetOptions(): Promise<string[]> {
        const { valueSets } = await this.service.shapes();
        return [...COMMON_DATATYPES.map(shortIri), ...NODE_KINDS, 'any', ...Object.values(valueSets).map(v => v.label), ...this.meta.classes.map(c => compactIri(c.iri))];
    }

    /** Parse a typed path; show the error. */
    protected typedPath(text: string): PathJSON | undefined {
        const iri = termIri(text);
        if (iri) return { kind: 'iri', iri };
        this.messages.warn('Type a property name or IRI.');
        return undefined;
    }

    /**
     * Parse a typed target: IRI, Literal, BlankNode (node kind), any, the label of a concept scheme or collection, else an IRI
     * (prefix:local, <iri>): a datatype when `current` is a datatype or the IRI is in xsd: or rdf:, else a class; else a name: a class
     * (canonical-md urn:name). `shapes`: the shapes to find value sets in (default: from the backend).
     */
    async parseTarget(text: string, current?: Range, shapes?: ShapesModel): Promise<Range | undefined> {
        const t = text.trim();
        if (!t) return undefined;
        shapes ??= await this.service.shapes();
        // "a | b": one of the alternatives (sh:or).
        if (t.includes('|')) {
            const parts: (Range | undefined)[] = [];
            for (const x of t.split('|').map(y => y.trim()).filter(Boolean)) parts.push(await this.parseTarget(x, current?.kind === 'or' ? undefined : current, shapes));
            if (parts.some(r => !r || r.kind === 'or' || r.kind === 'any')) { this.messages.warn('Each target of "a | b" is a class, a datatype, a node kind, a node shape, a concept scheme or a collection.'); return undefined; }
            return orRange(parts as SimpleRange[]);
        }
        if ((NODE_KINDS as readonly string[]).includes(t)) return { kind: 'nodeKind', nodeKind: t as typeof NODE_KINDS[number] };
        if (t === 'any') return { kind: 'any' };
        const set = Object.values(shapes.valueSets).find(v => v.label === t || compactIri(v.uri) === t);
        if (set) return rangeOfShape(shapes, set.id);
        const iri = expandIri(t);
        if (!iri) { const name = await this.typedClass(t); return name ? { kind: 'class', class: name } : undefined; }
        const literal = iri.startsWith('http://www.w3.org/2001/XMLSchema#') || iri.startsWith('http://www.w3.org/1999/02/22-rdf-syntax-ns#');
        return current?.kind === 'datatype' || (literal && current?.kind !== 'class') ? { kind: 'datatype', datatype: iri } : { kind: 'class', class: iri };
    }

    /**
     * A new property shape of `shape` with a typed path. `at` (model point): a value set target gets its node there; `out`: the property
     * is an edge, its pill at `at`. Returns the new id.
     */
    async createProperty(shape: string, view: string, range: Range, pathText: string, place?: { at: Point; out?: boolean }, counts?: { minCount?: number; maxCount?: number }): Promise<string | undefined> {
        const path = this.typedPath(pathText);
        if (!path) return undefined;
        const r = await this.executeAndSelect(view, { kind: 'createPropertyShape', shape, path, range, ...counts, view, at: place?.at, out: place?.out });
        return r.ok ? r.id : undefined;
    }

    /** A property of a card becomes an edge in this view: its target card or pill (added if needed) at `at` (model point; default right of the card). */
    async takeOut(view: string, id: string, at?: Point): Promise<void> {
        const [shapes, stored] = await Promise.all([this.service.shapes(), this.service.view(view)]);
        // A logical constraint (the head of its row group): its hub, with the boxes that its member lines need.
        const c = shapes.constraints[id];
        if (c) {
            const owner = cardOf(stored, c.owner);
            if (owner) await this.executeAndSelect(view, { kind: 'showAsEdge', view, id, at: at ?? { x: owner.x + owner.width + 400, y: owner.y + owner.height / 2 } }, [id]);
            return;
        }
        const p = shapes.properties[id];
        const end = p && endPoint(stored, shapes, p);
        if (!p || !end) return;
        await this.executeAndSelect(view, { kind: 'showAsEdge', view, id, at: at ?? end }, [id]);
    }

    /**
     * Members of a member-list box (a concept of a value set, the card of an alternative of a "one of" box) get their own cards, centered at
     * `at` (beside the box). Their rows go: the view draws the line from the box to each card (a concept is drawn once in a view).
     */
    async showMembers(view: string, ids: string[], at: Point): Promise<void> {
        await this.executeAndSelect(view, { kind: 'addToView', view, ids, at }, ids);
    }

    /**
     * Add one more target to a property: its range becomes "one of" the current targets and the new one. The picker has no "any";
     * typed text is a target (a class name, prefix:local, a concept scheme or collection label, or "a | b"), not a new element.
     */
    async addAlternative(property: string, view?: string, anchor?: Anchor): Promise<void> {
        const shapes = await this.service.shapes();
        const p = shapes.properties[property];
        if (!p) return;
        const items = this.rangeItems(shapes, true).filter(i => i.type === 'separator' || !['any', 'New concept scheme', 'New collection'].includes(i.label ?? ''));
        const creators: Creator[] = [{ label: 'Use as target', run: text => this.parseTarget(text, undefined, shapes) }];
        const picked = await this.pick(`${formatPath(p.path)}: add a target (each value is one of the targets)`, items, creators, anchor);
        const range = picked && typeof picked === 'object' ? picked as Range : undefined;
        if (range) await this.addTargets(property, range, view);
    }

    /** Add the alternatives of `range` to the targets of a property: an "or" range ("one of"). */
    async addTargets(property: string, range: Range, view?: string): Promise<void> {
        const shapes = await this.service.shapes();
        const p = shapes.properties[property];
        if (!p) return;
        const added = alternativesOf(range);
        if (!added.length) { this.messages.warn('"any" cannot be one of the targets.'); return; }
        const current = alternativesOf(p.range);
        const fresh = added.filter(a => !current.some(c => rangeKey(c) === rangeKey(a)));
        if (!fresh.length) { this.messages.info(`${rangeText(shapes, range)} is already a target.`); return; }
        await this.setTargets(property, orRange([...current, ...fresh]), view);
    }

    /**
     * A new range of a property from the canvas. A line of the view keeps its line: the new end box ("one of", a card) is placed beside
     * the owner card when the view does not show it, as Show as Edge does.
     */
    protected async setTargets(property: string, range: Range, view?: string): Promise<void> {
        if (!view) { await this.setProperty(property, { range }); return; }
        const [shapes, stored] = await Promise.all([this.service.shapes(), this.service.view(view)]);
        const p = shapes.properties[property];
        await this.setRange(property, range, view, p && endPoint(stored, shapes, { ...p, range }));
    }

    /** Remove an alternative (by its range key) of an "or" range. One left: the range is that alternative. */
    async removeAlternative(property: string, key: string, view?: string): Promise<void> {
        const p = (await this.service.shapes()).properties[property];
        if (p?.range.kind !== 'or') return;
        await this.setTargets(property, orRange(p.range.alternatives.filter(a => rangeKey(a) !== key)), view);
    }

    /** Text of a range for a target input: prefix:local for a class or datatype; "a | b" for an "or" range. `shapes`: the labels of value sets. */
    targetText(r: Range, shapes: ShapesModel): string {
        if (r.kind === 'datatype') return compactIri(r.datatype);
        if (r.kind === 'class') return compactIri(r.class);
        if (r.kind === 'or') return r.alternatives.map(a => this.targetText(a, shapes)).join(' | ');
        return rangeText(shapes, r);
    }

    /**
     * A property line goes back into all its owner cards of this view (rows); a box that only its lines keep leaves with it (ADR 0014).
     * A member of a logical constraint: the hub unit goes, the members are a row group.
     */
    async putBack(view: string, id: string): Promise<void> {
        const p = (await this.service.shapes()).properties[id];
        if (!p) return;
        await this.executeAndSelect(view, { kind: 'removeFromView', view, ids: [p.constraint ? id : propertyNodeId(p)] }, [id]);
    }

    /** Change the target of a property; the target card of an edge, or a value set, gets its node in the view at `at` (model point). */
    async setRange(id: string, range: Range, view?: string, at?: Point): Promise<void> {
        await this.executeWithMigrations({ kind: 'setPropertyShape', id, patch: { range }, view, at }, view);
    }

    /** New concept scheme or collection "unnamed scheme N"; with a view, its node at `at`. Returns its id. */
    async newValueSet(kind: 'scheme' | 'collection', view?: string, at?: Point, name?: string): Promise<string | undefined> {
        const label = name?.trim() || await this.service.newLabel(kind);
        const command: EditCommand = { kind: 'createValueSet', valueSet: kind, label, view, at };
        const r = view ? await this.executeAndSelect(view, command) : await this.model.execute(command);
        // A value set made on a canvas: its follow-up. Without a view it is the target of a new property (that gesture goes on).
        if (r.ok && r.id && view && !name?.trim()) await this.followUp(r.id, 'label', view);
        return r.ok ? r.id : undefined;
    }

    /** "+ concept" of a value set: a new concept `text`; in a collection, an existing concept with that label (or prefix:local) joins it. */
    async addConcept(set: string, text: string): Promise<boolean> {
        const t = text.trim();
        const { valueSets } = await this.service.shapes();
        const v = valueSets[set];
        if (!t || !v) return false;
        const existing = v.kind === 'collection'
            ? Object.values(valueSets).flatMap(x => x.members).find(m => m.label === t || compactIri(m.uri) === t)
            : undefined;
        return (await this.model.execute(existing ? { kind: 'addConcept', set, uri: existing.uri } : { kind: 'addConcept', set, label: t })).ok;
    }

    async renameConcept(uri: string, text: string): Promise<void> {
        if (text.trim()) await this.model.execute({ kind: 'rename', id: iriId(uri), label: text.trim() });
    }

    async setConceptBroader(uri: string, broader: string): Promise<void> {
        await this.model.execute({ kind: 'setConceptBroader', uri, broader });
    }

    async removeConcept(set: string, uri: string): Promise<void> {
        await this.model.execute({ kind: 'removeConcept', set, uri });
    }

    /** Completions for "+ concept" of a collection: the concepts of all value sets. */
    /** The card of an instance leaves the view (and its collection). The model does not change. */
    async removeFromView(view: string, id: string): Promise<void> {
        await this.model.execute({ kind: 'removeFromView', view, ids: [id] });
    }

    /** Labels of the instances that are not members of `collection` (for "+ member"). */
    memberOptions(view: string, collection: string): Promise<string[]> {
        return this.service.memberOptions(view, collection);
    }

    /** An instance joins a collection, by label or IRI. False when no instance or more than one has that label. */
    async addMember(view: string, collection: string, text: string): Promise<boolean> {
        const t = text.trim();
        if (!t) return false;
        const found = await this.service.instancesNamed(t);
        if (found.length !== 1) { this.messages.warn(found.length ? `More than one instance is "${t}": use its IRI.` : `No instance "${t}".`); return false; }
        const r = await this.model.execute({ kind: 'addToCollection', view, id: collection, ids: [found[0]] });
        return r.ok;
    }

    async conceptOptions(set: string): Promise<string[]> {
        const { valueSets } = await this.service.shapes();
        const v = valueSets[set];
        if (v?.kind !== 'collection') return [];
        const inSet = new Set(v.members.map(m => m.uri));
        return [...new Set(Object.values(valueSets).flatMap(x => x.members).filter(m => !inSet.has(m.uri)).map(m => m.label))].sort();
    }

    async setPathText(id: string, text: string, view?: string): Promise<void> {
        const p = (await this.service.shapes()).properties[id];
        const path = p && this.typedPath(text);
        if (path && formatPath(path) !== formatPath(p.path)) await this.setProperty(id, { path }, view);
    }

    async setTargetText(id: string, text: string, view?: string): Promise<void> {
        const shapes = await this.service.shapes();
        const p = shapes.properties[id];
        const range = p && await this.parseTarget(text, p.range, shapes);
        if (range) await this.setProperty(id, { range }, view);
    }

    async setTargetClassText(shape: string, text: string): Promise<void> {
        if (!text.trim()) return this.setNodeShape(shape, { targetClass: '' });
        const iri = await this.typedClass(text);
        if (iri) await this.setNodeShape(shape, { targetClass: iri });
    }

    async setTargetSubjectsOfText(shape: string, text: string): Promise<void> {
        return this.setPredicateTargetsText(shape, 'targetSubjectsOf', text);
    }

    async setTargetObjectsOfText(shape: string, text: string): Promise<void> {
        return this.setPredicateTargetsText(shape, 'targetObjectsOf', text);
    }

    async setNodeConstraintsText(shape: string, text: string): Promise<void> {
        return this.setPredicateTargetsText(shape, 'nodes', text);
    }

    protected async setPredicateTargetsText(shape: string, field: 'targetSubjectsOf' | 'targetObjectsOf' | 'nodes', text: string): Promise<void> {
        const targets: string[] = [];
        for (const line of text.split('\n').map(v => v.trim()).filter(Boolean)) {
            const target = parseIri(line);
            if ('error' in target) { this.messages.warn(target.error); return; }
            if (target.iri) targets.push(target.iri);
        }
        await this.setNodeShape(shape, { [field]: [...new Set(targets)] });
    }

    /** A typed class: an IRI, the known class with that name, else a urn:name IRI; a name of two classes: a warning, undefined. */
    async typedClass(text: string): Promise<string | undefined> {
        const r = classIri(text, await this.service.knownClasses());
        if (r && 'error' in r) { this.messages.warn(r.error); return undefined; }
        return r?.iri;
    }


    /** "unnamed property N": the path name of a new property, not yet used by a property shape. Rename it later (F2, Properties). */
    protected unnamedPath(): Promise<string> {
        return this.service.newLabel('property');
    }

    /** Link drag from shape `source` to a node shape or value set `target`: a new property "unnamed property N" to it, an edge. */
    async linkShape(source: string, target: string, view: string, at: Point): Promise<void> {
        const range = await this.rangeTo(target);
        const id = range ? await this.createProperty(source, view, range, await this.unnamedPath(), { at, out: true }) : undefined;
        if (id) await this.followUp(id, 'path', view);
    }

    /**
     * Link drag from shape `source` released on empty canvas: pick the target of a new property "unnamed property N" (as the link
     * picker of an instance): a node shape, a value set, "+ New node shape" / "+ New concept scheme" / "+ New collection" (typed text:
     * its name, else "unnamed shape N", …), a datatype, node kind or class. One undo step. `at`: model point of the new target or pill.
     */
    async linkShapeToCanvas(source: string, view: string, at: Point, anchor?: Anchor): Promise<void> {
        const shapes = await this.service.shapes();
        const shape = shapes.nodeShapes[source];
        if (!shape) return;
        const { nodeShapes, valueSets } = shapes;
        const create = async (kind: NewShapeTarget['kind'], text?: string): Promise<NewShapeTarget> => ({
            kind, label: text?.trim() || await this.service.newLabel(kind === 'nodeShape' ? 'shape' : kind)
        });
        const items: (PickItem | QuickPickSeparator)[] = [
            { type: 'separator', label: 'Node shape' },
            ...Object.values(nodeShapes).sort(byLabel).map(t => ({ label: t.label, description: t.targetClass ? shortIri(t.targetClass) : 'sh:node', run: () => rangeOfShape(shapes, t.id) })),
            { label: '+ New node shape', run: () => create('nodeShape') },
            { type: 'separator', label: 'Concept scheme or collection (SKOS)' },
            ...Object.values(valueSets).sort(byLabel).map(v => ({ label: v.label, description: v.kind === 'scheme' ? 'concept scheme' : 'collection', run: () => rangeOfShape(shapes, v.id) })),
            { label: '+ New concept scheme', run: () => create('scheme') },
            { label: '+ New collection', run: () => create('collection') },
            ...this.rangeItems(shapes, false)
        ];
        const creators: Creator[] = [
            { label: 'new node shape', run: text => create('nodeShape', text) },
            { label: 'new concept scheme', run: text => create('scheme', text) },
            { label: 'new collection', run: text => create('collection', text) }
        ];
        const r = await this.pick(`${shape.label}: pick the target of the new property, or type a name to create one`, items, creators, anchor);
        if (!r || typeof r !== 'object') return;
        const path = this.typedPath(await this.unnamedPath());
        if (!path) return;
        const target = r as Range | NewShapeTarget;
        const made = await this.executeAndSelect(view, 'label' in target
            ? { kind: 'createPropertyShape', shape: source, path, range: { kind: 'any' }, newTarget: target, view, at, out: true }
            : { kind: 'createPropertyShape', shape: source, path, range: target, view, at, out: true });
        if (made.ok && made.id) await this.followUp(made.id, 'path', view);
    }

    /**
     * Incoming link drag from shape `target` released on empty canvas, or a click: pick the node shape that gets a new property
     * "unnamed property N" to `target` (an existing node shape, or "+ New node shape": the typed text, else "unnamed shape N").
     * One undo step. `at`: model point of the owner card when the view does not show it, and of the pill.
     */
    async linkShapeInToCanvas(target: string, view: string, at: Point, anchor?: Anchor): Promise<void> {
        const shapes = await this.service.shapes();
        const shape = shapes.nodeShapes[target];
        const range = rangeOfShape(shapes, target);
        if (!shape || !range) return;
        const { nodeShapes } = shapes;
        const create = async (text?: string) => ({ newOwner: text?.trim() || await this.service.newLabel('shape') });
        const items: (PickItem | QuickPickSeparator)[] = [
            { type: 'separator', label: 'Node shape' },
            ...Object.values(nodeShapes).sort(byLabel).map(o => ({ label: o.label, description: o.targetClass ? shortIri(o.targetClass) : 'sh:node', run: () => ({ owner: o.id }) })),
            { label: '+ New node shape', run: () => create() }
        ];
        const creators: Creator[] = [{ label: 'new node shape', run: text => create(text) }];
        const r = await this.pick(`${shape.label}: pick the node shape of the new property, or type a name to create one`, items, creators, anchor);
        if (!r || typeof r !== 'object') return;
        const path = this.typedPath(await this.unnamedPath());
        if (!path) return;
        const owner = r as { owner: string } | { newOwner: string };
        const made = await this.executeAndSelect(view, 'owner' in owner
            ? { kind: 'createPropertyShape', shape: owner.owner, path, range, view, at, out: true }
            : { kind: 'createPropertyShape', shape: '', newOwner: owner.newOwner, path, range, view, at, out: true });
        if (made.ok && made.id) await this.followUp(made.id, 'path', view);
    }

    /** Pick a range (datatype, node kind, value set, scheme, class). `current`: preselected. */
    async askRange(title: string, anchor?: Anchor): Promise<Range | undefined> {
        // Typed text: a new concept scheme or collection with that name.
        const creators: Creator[] = [
            { label: 'New concept scheme', run: text => this.newValueSetRange('scheme', text) },
            { label: 'New collection', run: text => this.newValueSetRange('collection', text) }
        ];
        const r = await this.pick(title, this.rangeItems(await this.service.shapes(), true), creators, anchor);
        return r && typeof r === 'object' ? r as Range : undefined;
    }

    /** Picker items that return a range: datatypes, node kinds, value sets of `shapes` (with `valueSets`), classes. */
    protected rangeItems(shapes: ShapesModel, valueSets: boolean): (PickItem | QuickPickSeparator)[] {
        return [
            { type: 'separator', label: 'Datatype' },
            ...COMMON_DATATYPES.map(d => ({ label: shortIri(d), run: () => ({ kind: 'datatype', datatype: d }) })),
            { label: 'Other datatype…', run: async () => {
                const iri = await this.askIri('Datatype: name, prefix:local or IRI');
                return iri ? { kind: 'datatype', datatype: iri } : undefined;
            } },
            { type: 'separator', label: 'Node kind' },
            ...NODE_KINDS.slice(0, 3).map(k => ({ label: k, description: 'sh:nodeKind', run: () => ({ kind: 'nodeKind', nodeKind: k }) })),
            { label: 'any', description: 'no range constraint', run: () => ({ kind: 'any' }) },
            ...(valueSets ? [
                { type: 'separator', label: 'Concept scheme or collection (SKOS)' } as QuickPickSeparator,
                ...Object.values(shapes.valueSets).sort(byLabel).map(v => ({ label: v.label, description: v.kind === 'scheme' ? 'concept scheme' : 'collection', run: () => rangeOfShape(shapes, v.id) })),
                { label: 'New concept scheme', run: () => this.newValueSetRange('scheme') },
                { label: 'New collection', run: () => this.newValueSetRange('collection') }
            ] : []),
            { type: 'separator', label: 'Class' },
            ...this.meta.classes.map(c => ({ label: c.name, description: shortIri(c.iri), run: () => ({ kind: 'class', class: c.iri }) })),
            { label: 'Other class…', run: async () => {
                const text = await new SingleTextInputDialog({ title: 'Class: name, prefix:local or IRI', validate: v => termIri(v) ? '' : 'Type a name or an IRI.' }).open();
                const iri = text ? await this.typedClass(text) : undefined;
                return iri ? { kind: 'class', class: iri } : undefined;
            } }
        ];
    }

    /** A new value set as a range (its node is placed with the property). */
    protected async newValueSetRange(kind: 'scheme' | 'collection', name?: string): Promise<Range | undefined> {
        const id = await this.newValueSet(kind, undefined, undefined, name);
        return id ? this.rangeTo(id) : undefined;
    }

    protected async askIri(title: string, initial = ''): Promise<string | undefined> {
        const text = await new SingleTextInputDialog({ title, initialValue: initial, validate: v => termIri(v) ? '' : 'Type a name or an IRI.' }).open();
        return text ? termIri(text) : undefined;
    }

    /** Change a property shape; show a data change that it asks for. Returns the new id. */
    async setProperty(id: string, patch: PropertyShapePatch, view?: string): Promise<string | undefined> {
        const r = await this.executeWithMigrations({ kind: 'setPropertyShape', id, patch }, view);
        return r.ok ? r.id : undefined;
    }

    async setNodeShape(id: string, patch: NodeShapePatch): Promise<void> {
        await this.executeWithMigrations({ kind: 'setNodeShape', id, patch });
    }

    /** Capture the queue before the edit; offer only new migrations after a successful edit and selection. */
    protected async executeWithMigrations(command: EditCommand, view?: string): Promise<CommandResult> {
        const before = new Set(this.model.snapshot.migrations.map(m => m.id));
        const r = view ? await this.executeAndSelect(view, command) : await this.model.execute(command);
        if (r.ok) void this.offerMigrations(before);
        return r;
    }

    /** New entries of the patch queue: a notification with Apply. They stay in the queue (Properties of the shapes view). */
    protected async offerMigrations(before: Set<string>): Promise<void> {
        for (const m of this.model.snapshot.migrations.filter(x => !before.has(x.id))) {
            const pick = await this.messages.info(`${m.reason}. ${m.count} data statement(s) use the old term.`, 'Apply to data', 'Later');
            if (pick === 'Apply to data') await this.applyMigration(m);
        }
    }

    async applyMigration(m: Migration): Promise<void> {
        const { count: _c, reason: _r, ...change } = m;
        const r = await this.model.execute({ kind: 'migrateData', migration: change });
        if (r.ok) this.messages.info(`Data changed: ${m.count} statement(s). Undo reverts it.`);
    }

    async dismissMigration(id: string): Promise<void> {
        await this.model.service.dismissMigration(id);
    }

    async editPath(id: string, view?: string): Promise<void> {
        const shapes = await this.service.shapes();
        const p = shapes.properties[id];
        if (!p) return;
        const path = await this.askPath(`Path of ${formatPath(p.path)} (${shapes.nodeShapes[p.owner]?.label})`, p.path);
        if (path && formatPath(path) !== formatPath(p.path)) await this.setProperty(id, { path }, view);
    }

    async editRange(id: string, view?: string, anchor?: Anchor): Promise<void> {
        const p = (await this.service.shapes()).properties[id];
        if (!p) return;
        const range = await this.askRange(`Target of ${formatPath(p.path)}`, anchor);
        if (range) await this.setProperty(id, { range }, view);
    }

    /** Click on a cardinality: 0..* → 0..1 → 1 → 1..* → 0..*. */
    async cycleCardinality(id: string, view?: string): Promise<void> {
        const p = (await this.service.shapes()).properties[id];
        if (!p) return;
        const next = nextCardinality(p.minCount, p.maxCount);
        await this.setProperty(id, { minCount: next.minCount ?? null, maxCount: next.maxCount ?? null }, view);
    }

    /** Edge end dragged to another shape card or value set node: the property shape points to it. */
    async retarget(id: string, target: string, view: string): Promise<void> {
        const range = await this.rangeTo(target);
        if (range) await this.setProperty(id, { range }, view);
    }

    /** "+ target" dropped on a card: the card is one more target of the property. */
    async addTargetCard(property: string, card: string, view: string): Promise<void> {
        const range = await this.rangeTo(card);
        if (range) await this.addTargets(property, range, view);
    }

    /** The range that points to a card (node shape: its class, else the shape) or to a value set node. */
    async rangeTo(target: string): Promise<Range | undefined> {
        return rangeOfShape(await this.service.shapes(), target);
    }

    /** Group edges (property shapes) of one shape into a logical constraint, or add them to the constraint in `ids`. */
    async group(ids: string[], view?: string, operator: Exclude<LogicalOperator, 'not'> = 'or'): Promise<void> {
        const command: EditCommand = { kind: 'groupProperties', ids, operator };
        if (view) await this.executeAndSelect(view, command);
        else await this.model.execute(command);
    }

    // ------------------------------------------------------------ quick pick with "create from typed text"

    /** Quick pick (or a popup at `anchor`) over `items`. Typed text that matches no item can create an element: one entry per creator. */
    protected pick(title: string, items: (PickItem | QuickPickSeparator)[], creators: Creator[] = [], anchor?: Anchor): Promise<unknown> {
        if (anchor) {
            return showPopupPicker({ at: anchor, title, items: items.map(i => i.type === 'separator' ? { type: 'separator', label: i.label ?? '' } : i as PickItem), creators });
        }
        return new Promise(resolve => {
            const qp = this.quick.createQuickPick<PickItem>();
            qp.title = title;
            qp.placeholder = 'Type to filter; the text is also the name of a new element';
            qp.matchOnDescription = true;
            const refresh = () => {
                const text = qp.value.trim();
                const extra: PickItem[] = text ? creators.map(c => ({ label: `${c.label} "${text}"`, alwaysShow: true, run: () => c.run(text) })) : [];
                qp.items = [...items, ...(extra.length ? [{ type: 'separator', label: 'Create' } as QuickPickSeparator] : []), ...extra] as PickItem[];
            };
            refresh();
            qp.onDidChangeValue(refresh);
            let done = false;
            qp.onDidAccept(async () => {
                const item = qp.selectedItems[0];
                done = true;
                qp.hide();
                resolve(item?.run ? await item.run() : undefined);
            });
            qp.onDidHide(() => { if (!done) resolve(undefined); qp.dispose(); });
            qp.show();
        });
    }
}

/** Default center of the end box of a property line in `view`: right of the owner card; a target card needs more room than a pill. */
function endPoint(view: View | undefined, shapes: ShapesModel, p: PropertyShape): Point | undefined {
    const card = cardOf(view, p.owner);
    return card && { x: card.x + card.width + (targetCard(shapes, p.range) ? 400 : 220), y: card.y + card.height / 2 };
}
