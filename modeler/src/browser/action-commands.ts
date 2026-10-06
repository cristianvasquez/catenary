// The actions as commands (spec/ui-manifest.hs §4, packages/model/src/actions.ts): one command per action, the same in every menu
// (view editor, halo "…", Model explorer, Links, Search, Outline) and on every key. The backend says which actions apply to a target
// (ActionService); this file only runs them. A command argument `{ ids, view? }` is an explicit target (a Links row, a class
// folder); without it the command acts on the window selection.

import { CommandContribution, CommandRegistry, DisposableCollection, MenuContribution, MenuModelRegistry, MenuPath, MessageService, QuickInputService, URI } from '@theia/core';
import { KeybindingContribution, KeybindingRegistry } from '@theia/core/lib/browser';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { TheiaGLSPContextMenu } from '@eclipse-glsp/theia-integration';
import { EditorManager } from '@theia/editor/lib/browser';
import { FileNavigatorContribution } from '@theia/navigator/lib/browser/navigator-contribution';
import { ACTIONS, ActionTarget, DELETABLE, ItemFacts, LogicalOperator, MARKS, VIEW_ITEMS, baseName, boxes, colorApplies, itemsOfKind } from '@catenary/model';
import { ActionService, viewAsItem } from './action-service';
import { ModelActions } from './actions';
import { ModelCommands, ModelExplorerContribution } from './commands';
import { editCanvasName } from './diagram/name-edit';
import { ViewEditors } from './diagram/view-editors';
import { EXPLORER_CONTEXT_MENU } from './explorer/model-explorer';
import { addMenuItems } from './menus';
import { ModelFrontend } from './model-client';
import { NoteEditor } from './notes/note-editor';
import { LINKS_CONTEXT_MENU } from './properties/links-widget';
import { OUTLINE_CONTEXT_MENU } from './outline';
import { SEARCH_CONTEXT_MENU } from './search/search-widget';
import { PROBLEMS_CONTEXT_MENU } from './problems';
import { sameIds } from './selection-model';

/** Menu groups of the actions, the same in every context menu. Order inside a group: the order of ACTIONS. */
export const ACTION_GROUPS: [string, string[]][] = [
    ['1_open', ['catenary.openView', 'catenary.selectInExplorer', 'catenary.goToSource', 'catenary.addToView']],
    ['2_edit', ['catenary.rename', 'catenary.editPath', 'catenary.editTarget', 'catenary.addAlternative', 'catenary.groupOr', 'catenary.groupXone', 'catenary.groupAnd',
        'catenary.ungroup', 'catenary.duplicateView', 'catenary.proposeShapes', 'catenary.showAsEdge', 'catenary.showAsRow', 'catenary.collect', 'catenary.uncollect']],
    ['3_delete', ['catenary.removeFromView', 'catenary.deleteFromModel']]
];

/**
 * "Go to" submenu, the same in every context menu (on the canvas: the GLSP submenu `navigate`, with Next/Previous Marker): first one
 * entry per view that shows the selected element (group a_views, from the occurrence of the selection), then Next/Previous View (b_cycle).
 */
const GO_TO: [string, string][] = [['catenary.nextOccurrence', 'Next View'], ['catenary.previousOccurrence', 'Previous View']];

/** Actions with a global keybinding: the menu shows the key in its key column, the label does not repeat it. */
const KEY_COLUMN = ['catenary.nextOccurrence', 'catenary.previousOccurrence', 'catenary.goToSource'];

/** Context menus that show the actions, the prefix of their groups, and their "Go to" submenu. The canvas keeps the GLSP group names. */
const MENUS: [MenuPath, string, MenuPath][] = [
    [TheiaGLSPContextMenu.CONTEXT_MENU, 'catenary_', [...TheiaGLSPContextMenu.CONTEXT_MENU, 'navigate']],
    ...[EXPLORER_CONTEXT_MENU, LINKS_CONTEXT_MENU, SEARCH_CONTEXT_MENU, OUTLINE_CONTEXT_MENU, PROBLEMS_CONTEXT_MENU]
        .map((root): [MenuPath, string, MenuPath] => [root, '', [...root, '1_open', 'go_to']])
];


@injectable()
export class ActionContribution implements CommandContribution, MenuContribution, KeybindingContribution {
    @inject(ActionService) protected readonly service: ActionService;
    @inject(ModelActions) protected readonly actions: ModelActions;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(NoteEditor) protected readonly notes: NoteEditor;
    @inject(EditorManager) protected readonly editorManager: EditorManager;
    @inject(QuickInputService) protected readonly quick: QuickInputService;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(FileNavigatorContribution) protected readonly navigator: FileNavigatorContribution;
    @inject(ModelExplorerContribution) protected readonly explorer: ModelExplorerContribution;
    @inject(CommandRegistry) protected readonly commandRegistry: CommandRegistry;
    @inject(MenuModelRegistry) protected readonly menuRegistry: MenuModelRegistry;
    /** Commands and menu entries of the views in the canvas "Go to" submenu. */
    protected readonly goToViews = new DisposableCollection();

    @postConstruct()
    protected init(): void {
        this.editors.onDidChangeOccurrence(() => this.updateGoToViews());
    }

    /** One "Go to" entry per view that shows the selected element, in label order. Click: the element in that view. */
    protected updateGoToViews(): void {
        this.goToViews.dispose();
        const selection = this.service.selectionTarget().ids;
        (this.editors.occurrence?.views ?? []).forEach((v, i) => {
            const id = `catenary.goToView.${i}`;
            this.goToViews.push(this.commandRegistry.registerCommand({ id, label: v.label }, {
                execute: () => this.editors.reveal(v.id, [v.box]),
                // An explicit target (a Links row) that is not the selection: the views are of the selection, not of it.
                isVisible: (arg?: unknown) => sameIds(this.service.targetOf(arg).ids, selection)
            }));
            for (const [, , goTo] of MENUS) {
                this.goToViews.push(this.menuRegistry.registerMenuAction([...goTo, 'a_views'], { commandId: id, label: v.label, order: String(i).padStart(4, '0') }));
            }
        });
    }

    registerCommands(registry: CommandRegistry): void {
        for (const a of ACTIONS) {
            const target = (arg?: unknown) => viewAsItem(a.id, this.service.targetOf(arg));
            registry.registerCommand({ id: a.id, label: a.label, category: 'Model' }, {
                execute: (arg?: unknown) => this.run(a.id, target(arg)),
                isVisible: (arg?: unknown) => !!this.service.state(a.id, target(arg)),
                isEnabled: (arg?: unknown) => !!this.service.state(a.id, target(arg))?.enabled
            });
        }
        this.registerDetails(registry);
        for (const [color, command] of ModelCommands.COLORS) {
            registry.registerCommand(command, {
                execute: async (arg?: unknown) => {
                    const t = this.service.targetOf(arg);
                    const items = (await this.service.fetch(t)).items;
                    if (t.view) await this.model.execute({ kind: 'setViewElements', view: t.view, ids: viewItems(items), patch: { color } });
                },
                isVisible: (arg?: unknown) => {
                    const t = this.service.targetOf(arg);
                    return colorApplies({ view: t.view, items: this.service.items(t) });
                }
            });
        }
    }

    /** Show Details: on when all target cards are detailed. Run: all simple when on, else all detailed. */
    protected registerDetails(registry: CommandRegistry): void {
        const cards = (arg?: unknown) => {
            const t = this.service.targetOf(arg);
            return { view: t.view, cards: this.service.get(t).cards };
        };
        const detailed = (arg?: unknown) => cards(arg).cards.every(c => c.display !== 'simple');
        registry.registerCommand(ModelCommands.DETAILS, {
            execute: async (arg?: unknown) => {
                const t = this.service.targetOf(arg);
                const ids = (await this.service.fetch(t)).cards;
                if (t.view && ids.length) await this.model.execute({
                    kind: 'setViewElements', view: t.view, ids: ids.map(c => c.element), patch: { display: ids.every(c => c.display !== 'simple') ? 'simple' : 'detailed' }
                });
            },
            isVisible: (arg?: unknown) => cards(arg).cards.length > 0,
            isToggled: (arg?: unknown) => detailed(arg)
        });
    }

    /** Run an action on a target. The facts of the target come with the answer of the backend. */
    protected async run(id: string, t: ActionTarget): Promise<void> {
        const { actions: states, items } = await this.service.fetch(t);
        const state = states.find(s => s.id === id);
        if (!state) return;
        if (!state.enabled) return this.messages.info(state.reason ?? 'The action cannot run now.') as unknown as void;
        const one = items[0];
        const view = t.view;
        const a = this.actions;
        switch (id) {
            case 'catenary.openView': return void await Promise.all(itemsOfKind(items, 'view').map(v => this.editors.open(v)));
            case 'catenary.showInView': return void await this.editors.show(one.element);
            case 'catenary.nextOccurrence': return this.editors.nextOccurrence(1);
            case 'catenary.previousOccurrence': return this.editors.nextOccurrence(-1);
            case 'catenary.selectInExplorer': return this.reveal(one, view);
            case 'catenary.goToSource': return this.goToSource(one.element);
            case 'catenary.rename': return this.rename(one, view);
            case 'catenary.editPath': return a.editPath(one.element, view);
            case 'catenary.editTarget': return a.editRange(one.element, view);
            case 'catenary.addAlternative': return a.addAlternative(one.element, view);
            case 'catenary.groupOr': return this.group(items, view, 'or');
            case 'catenary.groupXone': return this.group(items, view, 'xone');
            case 'catenary.groupAnd': return this.group(items, view, 'and');
            case 'catenary.ungroup':
                for (const c of itemsOfKind(items, 'constraint')) await this.model.execute({ kind: 'ungroup', id: c });
                return;
            case 'catenary.duplicateView': return a.duplicateView(one.element);
            case 'catenary.proposeShapes': return a.proposeShapes([...new Set(items.flatMap(i => i.unshaped))]);
            case 'catenary.addToView': return this.addToView(items, t.activeView);
            case 'catenary.showAsEdge': return void (view && await a.takeOut(view, one.element));
            case 'catenary.showAsRow':
                for (const i of items) if (view && i.property?.takenOut && !i.property.fixed) await a.putBack(view, i.element);
                return;
            case 'catenary.collect':
                return void (view && await a.collect(view, items.filter(i => i.placed && i.kinds.some(k => k === 'instance' || k === 'collection')).map(i => i.element)));
            case 'catenary.uncollect': return void (view && await a.uncollect(view, items.filter(i => i.placed && i.kinds.includes('collection')).map(i => i.element)));
            case 'catenary.removeFromView': return void (view && await this.model.execute({ kind: 'removeFromView', view, ids: viewItems(items) }));
            case 'catenary.deleteFromModel': return this.deleteFromModel(items, view);
        }
    }

    /** A view or a view reference: the file in the file navigator. Another element: its row in the Model explorer. */
    protected async reveal(item: ItemFacts, view?: string): Promise<void> {
        const reference = item.kinds.includes('reference') && view
            ? boxes(await this.model.service.view(view), 'reference').find(r => r.id === item.element)?.target : undefined;
        const id = reference ?? item.element;
        const file = this.model.snapshot.files.views.find(v => v.view === id)?.path;
        if (file) {
            await this.navigator.openView({ activate: true, reveal: true });
            await this.navigator.selectFileNode(URI.fromFilePath(file));
            return;
        }
        const w = await this.explorer.openView({ activate: true, reveal: true });
        await w.reveal(id);
    }

    /** Go to Source (spec 0.4): the file with the statements of the element, at its line. Several files: a pick. */
    protected async goToSource(id: string): Promise<void> {
        const sources = await this.model.service.sources(id);
        if (!sources.length) return void this.messages.info('No file has statements of the element.');
        const pick = sources.length === 1 ? sources[0] : (await this.quick.showQuickPick(
            sources.map(s => ({ label: baseName(s.path), description: s.line ? `line ${s.line}` : 'not in the file on disk', detail: s.path, source: s })),
            { placeholder: 'Files with statements of the element' }))?.source;
        if (!pick) return;
        const at = pick.line ? { line: pick.line - 1, character: 0 } : undefined;
        await this.editorManager.open(URI.fromFilePath(pick.path), { mode: 'activate', selection: at ? { start: at, end: at } : undefined });
        if (!pick.line) this.messages.info(`${baseName(pick.path)}: the element is not in the file on disk (not saved yet, or written in a form that the search does not find).`);
    }

    /** A note: the note editor. On a canvas: the name slot of the card. Else a label dialog. */
    protected async rename(item: ItemFacts, view?: string): Promise<void> {
        const w = view ? this.editors.find(view) : undefined;
        if (w && view) {
            if (item.kinds.includes('note')) return this.notes.open(view, item.id);
            if (editCanvasName(w, item.id, view, this.editors, this.model)) return;
        }
        await this.actions.rename(item.element);
    }

    /** Logical constraint of the selected property shapes; the selected constraint (if any) gets the others. */
    protected group(items: ItemFacts[], view: string | undefined, operator: Exclude<LogicalOperator, 'not'>): Promise<void> {
        return this.actions.group([...itemsOfKind(items, 'constraint'), ...itemsOfKind(items, 'property')], view, operator);
    }

    /** The cards and the edges that the active view does not place yet. */
    protected async addToView(items: ItemFacts[], view?: string): Promise<void> {
        if (!view) return;
        const missing = items.filter(i => !i.placedInActive);
        const cards = itemsOfKind(missing, 'instance', 'shape', 'valueSet');
        const relations = itemsOfKind(missing, 'relation').filter(id => !cards.includes(id));
        if (cards.length) await this.actions.addToView(view, cards);
        if (relations.length) await this.actions.showRelations(view, relations, this.editors.center(await this.editors.open(view)));
    }

    /** Elements: deleted with their own statements (one confirmation). Marks selected on a canvas: deleted with their placement. */
    protected async deleteFromModel(items: ItemFacts[], view?: string): Promise<void> {
        const elements = itemsOfKind(items.filter(i => i.kinds.some(k => DELETABLE.includes(k))), ...DELETABLE);
        const marks = view ? items.filter(i => i.placed && i.kinds.some(k => MARKS.includes(k)) && !i.kinds.some(k => DELETABLE.includes(k))).map(i => i.element) : [];
        if (elements.length) await this.actions.delete(elements);
        if (marks.length && view) await this.model.execute({ kind: 'removeFromView', view, ids: marks });
    }

    registerMenus(menus: MenuModelRegistry): void {
        const label = (id: string) => {
            const a = ACTIONS.find(x => x.id === id)!;
            return a.key && !KEY_COLUMN.includes(id) ? `${a.label} (${a.key})` : a.label;
        };
        for (const [root, prefix, goTo] of MENUS) {
            for (const [group, ids] of ACTION_GROUPS) addMenuItems(menus, [...root, prefix + group], ...ids.map((id): [string, string] => [id, label(id)]));
            // The canvas has the GLSP submenu already.
            if (root !== TheiaGLSPContextMenu.CONTEXT_MENU) menus.registerSubmenu(goTo, 'Go to', { sortString: '0' });
            addMenuItems(menus, [...goTo, 'b_cycle'], ...GO_TO);
        }
        // Appearance: the menus of the views (canvas, Outline). Show Details, then the Color submenu.
        for (const appearance of [[...TheiaGLSPContextMenu.CONTEXT_MENU, 'catenary_2_edit', 'catenary_appearance'], [...OUTLINE_CONTEXT_MENU, '2_edit', 'appearance']]) {
            menus.registerSubmenu(appearance, 'Appearance', { sortString: 'z' });
            addMenuItems(menus, [...appearance, '1_display'], [ModelCommands.DETAILS.id, ModelCommands.DETAILS.label!]);
            const color = [...appearance, '2_color', 'color'];
            menus.registerSubmenu(color, 'Color');
            addMenuItems(menus, color, ...ModelCommands.COLORS.map(([, command]): [string, string] => [command.id, command.label!.replace('Color: ', '')]));
        }
    }

    registerKeybindings(keybindings: KeybindingRegistry): void {
        keybindings.registerKeybinding({ command: 'catenary.goToSource', keybinding: 'f12', when: '!editorTextFocus' });
    }
}

/** The ids that Remove from View and Color act on: placed boxes and edges (a card or an edge by its element, a mark by its placement). */
function viewItems(items: ItemFacts[]): string[] {
    return [...new Set(items.filter(i => i.placed && i.kinds.some(k => VIEW_ITEMS.includes(k))).map(i => i.element))];
}
