// The actions as commands (spec/ui-manifest.hs §4, packages/model/src/actions.ts): one command per action, the same in every menu
// (view editor, halo "…", Model explorer, Links, Search, Outline) and on every key. The backend says which actions apply to a target
// (ActionService); this file only runs them. A command argument `{ ids, view? }` is an explicit target (a Links row, a class
// folder); without it the command acts on the window selection.

import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry, MenuPath, MessageService, QuickInputService, URI } from '@theia/core';
import { ApplicationShell, KeybindingContribution, KeybindingRegistry } from '@theia/core/lib/browser';
import { EditorWidget } from '@theia/editor/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { GLSPDiagramWidget, TheiaGLSPContextMenu } from '@eclipse-glsp/theia-integration';
import { ACTIONS, ActionTarget, DELETABLE, ItemFacts, OpenTarget, LogicalOperator, MARKS, VIEW_ITEMS, baseName, boxes, colorApplies, itemsOfKind } from '@catenary/model';
import { ActionService, viewAsItem } from './action-service';
import { ModelActions } from './actions';
import { ModelCommands, CatenaryFileOpenHandler } from './commands';
import { editCanvasName } from './diagram/name-edit';
import { ViewEditors, viewIdOf } from './diagram/view-editors';
import { EXPLORER_CONTEXT_MENU, ModelExplorerWidget } from './explorer/model-explorer';
import { addMenuItems } from './menus';
import { ModelFrontend } from './model-client';
import { NoteEditor } from './notes/note-editor';
import { LINKS_CONTEXT_MENU } from './properties/links-widget';
import { OUTLINE_CONTEXT_MENU } from './outline';
import { SEARCH_CONTEXT_MENU } from './search/search-widget';
import { PROBLEMS_CONTEXT_MENU } from './problems';

/** Menu groups of the actions, the same in every context menu. Order inside a group: the order of ACTIONS. */
export const ACTION_GROUPS: [string, string[]][] = [
    ['1_open', ['catenary.openIn', 'catenary.addToView']],
    ['2_edit', ['catenary.rename', 'catenary.editPath', 'catenary.editTarget', 'catenary.addAlternative', 'catenary.groupOr', 'catenary.groupXone', 'catenary.groupAnd',
        'catenary.ungroup', 'catenary.duplicateView', 'catenary.proposeShapes', 'catenary.showAsEdge', 'catenary.showAsRow', 'catenary.collect', 'catenary.uncollect']],
    ['3_delete', ['catenary.removeFromView', 'catenary.deleteFromModel']]
];

/**
 * "Go to" submenu, the same in every context menu (on the canvas: the GLSP submenu `navigate`, with Next/Previous Marker): Next and
 * Previous View. Open in… lists the views that show the element.
 */
const GO_TO: [string, string][] = [['catenary.nextOccurrence', 'Next View'], ['catenary.previousOccurrence', 'Previous View']];

/** Actions with a global keybinding: the menu shows the key in its key column, the label does not repeat it. */
const KEY_COLUMN = ['catenary.nextOccurrence', 'catenary.previousOccurrence', 'catenary.openIn'];

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
    @inject(QuickInputService) protected readonly quick: QuickInputService;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(CatenaryFileOpenHandler) protected readonly files: CatenaryFileOpenHandler;
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
            case 'catenary.openIn': return this.openIn(one, view);
            case 'catenary.nextOccurrence': return this.editors.nextOccurrence(1);
            case 'catenary.previousOccurrence': return this.editors.nextOccurrence(-1);
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

    /**
     * Open in…: the presentations that show the element (Source at its position, Model, Canvas), without the current pane. One opens
     * at once; several give a pick. A view reference stands for the view that it shows.
     */
    protected async openIn(item: ItemFacts, view?: string): Promise<void> {
        const reference = item.kinds.includes('reference') && view
            ? boxes(await this.model.service.view(view), 'reference').find(r => r.id === item.element)?.target : undefined;
        const id = reference ?? item.element;
        // The current pane: the focused main-area pane, else the current tab of the main area (Open in… from a side panel).
        const focused = this.shell.currentWidget;
        const current = focused && this.shell.getAreaFor(focused) === 'main' ? focused : this.shell.getCurrentWidget('main');
        const here = (t: OpenTarget) => t.presentation === 'Model' ? current instanceof ModelExplorerWidget && current.file === t.path
            : t.presentation === 'Canvas' ? current instanceof GLSPDiagramWidget && viewIdOf(current) === t.view
            : current instanceof EditorWidget && current.editor.uri.toString() === URI.fromFilePath(t.path).toString();
        const targets = (await this.model.service.openTargets(id)).filter(t => !here(t));
        if (!targets.length) return void this.messages.info('No other pane shows the element.');
        const where = (t: OpenTarget) => t.presentation === 'Canvas' ? t.label
            : t.presentation === 'Source' && t.line ? `${baseName(t.path)}:${t.line}` : baseName(t.path);
        const pick = targets.length === 1 ? targets[0] : (await this.quick.showQuickPick(
            targets.map(t => ({ label: t.presentation, description: where(t), detail: t.presentation === 'Canvas' ? undefined : t.path, target: t })),
            { placeholder: 'Open in' }))?.target;
        if (!pick) return;
        if (pick.presentation === 'Model') return (await this.files.openModel(pick.path)).reveal(id);
        if (pick.presentation === 'Canvas') return pick.box ? this.editors.reveal(pick.view, [pick.box]) : void await this.editors.open(pick.view);
        const at = pick.line ? { line: pick.line - 1, character: (pick.column ?? 1) - 1 } : undefined;
        await this.files.openSource(URI.fromFilePath(pick.path), { mode: 'activate', selection: at ? { start: at, end: at } : undefined });
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
        keybindings.registerKeybinding({ command: 'catenary.openIn', keybinding: 'f12', when: '!editorTextFocus' });
    }
}

/** The ids that Remove from View and Color act on: placed boxes and edges (a card or an edge by its element, a mark by its placement). */
function viewItems(items: ItemFacts[]): string[] {
    return [...new Set(items.filter(i => i.placed && i.kinds.some(k => VIEW_ITEMS.includes(k))).map(i => i.element))];
}
