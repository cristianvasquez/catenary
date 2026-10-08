// Main menu bar of the modeler. Removes the Theia entries that do nothing here (workspace, text-editor and
// language features) and puts the model commands in File, Edit and Go.

import { MAIN_MENU_BAR, MenuContribution, MenuModelRegistry, MenuPath } from '@theia/core';
import { CommonMenus } from '@theia/core/lib/browser';
import { RESET_LAYOUT } from '@theia/core/lib/browser/shell/shell-layout-restorer';
import { injectable } from '@theia/core/shared/inversify';
import { ModelCommands, OpenModelCommands } from './commands';

/** Theia menu entries (command ids, or ids of groups and submenus) that do not apply to a model. */
const REMOVED: [string[], string[]][] = [
    [CommonMenus.FILE, [
        'workbench.action.files.newUntitledFile', 'workbench.action.files.pickNewFile', 'file.newFolder', 'workbench.action.newWindow',
        'workspace:open', 'workspace:openWorkspace', 'workspace:openRecent', 'workspace:addFolder', 'workspace:saveAs',
        'core.save', 'core.saveAll', 'file.saveAs', 'textEditor.commands.autosave', 'file.upload', 'file.download', 'workspace:close'
    ]],
    [CommonMenus.EDIT, ['core.undo', 'core.redo', 'core.copy.path', 'file.copyDownloadLink', 'core.find', 'core.replace']],
    [MAIN_MENU_BAR, ['3_selection']],
    [CommonMenus.VIEW, [
        'editor.action.toggleWordWrap', 'editor.action.toggleMinimap', 'breadcrumbs.toggle', 'editor.action.toggleRenderWhitespace',
        'editor.action.toggleStickyScroll'
    ]],
    [[...MAIN_MENU_BAR, '5_go'], [
        'textEditor.commands.go.back', 'textEditor.commands.go.forward', 'textEditor.commands.go.lastEdit', 'languages.workspace.symbol',
        'editor.action.quickOutline', 'editor.action.revealDefinition', 'editor.action.revealDeclaration', 'editor.action.goToTypeDefinition',
        'editor.action.goToImplementation', 'editor.action.goToReferences', 'editor.action.gotoLine', 'editor.action.jumpToBracket',
        'editor.action.marker.nextInFiles', 'editor.action.marker.prevInFiles'
    ]]
];

/** Add commands to a menu group, in this order. An item is a command id, or [command id, label]. */
export function addMenuItems(menus: MenuModelRegistry, path: MenuPath, ...items: (string | [string, string])[]): void {
    items.forEach((item, i) => {
        const [commandId, label] = typeof item === 'string' ? [item, undefined] : item;
        menus.registerMenuAction(path, { commandId, label, order: String.fromCharCode(97 + i) });
    });
}

const FILE_MODEL = [...CommonMenus.FILE, '1_new_text'];
const FILE_SAVE = [...CommonMenus.FILE, '3_save'];
const GO_FIND = [...MAIN_MENU_BAR, '5_go', '0_find'];
const GO_HISTORY = [...MAIN_MENU_BAR, '5_go', '1_history'];
const FILE_PREFERENCES_RESET = [...CommonMenus.FILE_SETTINGS_SUBMENU, '3_reset'];

@injectable()
export class ModelerMenus implements MenuContribution {
    registerMenus(menus: MenuModelRegistry): void {
        for (const [path, ids] of REMOVED) ids.forEach(id => menus.unregisterMenuAction(id, path));

        const c = OpenModelCommands;
        addMenuItems(menus, FILE_MODEL, c.NEW.id, c.OPEN.id, c.OPEN_RECENT.id, c.WORKSPACE_SETTINGS.id, c.IMPORT_FILE.id, c.SHOW_TRIG.id);
        addMenuItems(menus, FILE_SAVE, c.SAVE.id);
        addMenuItems(menus, CommonMenus.EDIT_UNDO, [c.UNDO.id, 'Undo'], [c.REDO.id, 'Redo']);
        addMenuItems(menus, CommonMenus.EDIT_FIND, ModelCommands.FIND_ELEMENT.id);
        addMenuItems(menus, CommonMenus.EDIT_CLIPBOARD, ModelCommands.COPY_AS_RDF.id);
        addMenuItems(menus, GO_FIND, [ModelCommands.FIND_ELEMENT.id, 'Go to Element…'], [ModelCommands.NEXT_OCCURRENCE.id, 'Next View of Found Element'],
            [ModelCommands.PREVIOUS_OCCURRENCE.id, 'Previous View of Found Element']);
        addMenuItems(menus, GO_HISTORY, [ModelCommands.BACK.id, 'Back'], [ModelCommands.FORWARD.id, 'Forward']);
        // Theia command: clears the stored layout and reloads; initializeLayout then opens each view in its default area.
        addMenuItems(menus, FILE_PREFERENCES_RESET, [RESET_LAYOUT.id, 'Reset Layout to Defaults']);
    }
}
