// SHACL violations in the Problems view: the results of the report graph of the store (a backend query, ADR 0007). Each instance
// has a URI catenary:/<instance id>. A click (Theia open mode 'reveal') selects the instance and reveals Properties, which shows
// its violations. A double-click or Enter also shows it in a view. The rows of an instance have the context menu of the actions
// (action-commands.ts) and drag to a view, as the rows of the Model Explorer. Status bar: model file, dirty, violations.

import { MenuPath, URI } from '@theia/core';
import {
    ContextMenuRenderer, FrontendApplicationContribution, LabelProviderContribution, OpenHandler, OpenerOptions, StatusBar, StatusBarAlignment,
    TreeNode, TreeProps, codicon
} from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';
import { ProblemTreeModel } from '@theia/markers/lib/browser/problem/problem-tree-model';
import { ProblemWidget } from '@theia/markers/lib/browser/problem/problem-widget';
import { Diagnostic, DiagnosticSeverity } from '@theia/core/shared/vscode-languageserver-protocol';
import { PropertyViewContribution } from '@theia/property-view/lib/browser/property-view-contribution';
import { ActionTarget, Problem, baseName, panelsUnchanged } from '@catenary/model';
import { ELEMENT_SCHEME } from '../common/protocol';
import { ModelFrontend } from './model-client';
import { ViewEditors } from './diagram/view-editors';
import { OpenModelCommands } from './commands';
import { SelectionModel } from './selection-model';
import { ActionService, whenActionsKnown } from './action-service';
import { DND_INSTANCES } from './diagram/canvas';

const OWNER = 'shacl';

export function elementUri(id: string): URI {
    return new URI(`${ELEMENT_SCHEME}:/${id}`);
}

/** Context menu of the Problems rows of an instance: the actions (action-commands.ts). */
export const PROBLEMS_CONTEXT_MENU: MenuPath = ['catenary-problems-context'];

/** The instance of a Problems row (a group row or a problem row), if the row has one. */
export function problemInstance(node: TreeNode | undefined): string | undefined {
    const uri = (node as { uri?: unknown } | undefined)?.uri;
    if (!(uri instanceof URI) || uri.scheme !== ELEMENT_SCHEME) return undefined;
    const id = uri.path.base;
    return id && id !== 'model' ? id : undefined;
}

/** The Problems widget of @theia/markers with the context menu of the actions and drag to a view on the rows of an instance. */
@injectable()
export class ModelProblemWidget extends ProblemWidget {
    @inject(ActionService) protected readonly actionService: ActionService;
    @inject(SelectionModel) protected readonly selection: SelectionModel;

    constructor(
        @inject(TreeProps) props: TreeProps,
        @inject(ProblemTreeModel) model: ProblemTreeModel,
        @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer
    ) {
        super(props, model, contextMenuRenderer);
    }

    /** The instances of the selected rows, or of `node` if it is not selected. */
    protected instances(node: TreeNode): string[] {
        const rows = this.model.selectedNodes.includes(node as never) ? this.model.selectedNodes : [node];
        return [...new Set(rows.map(problemInstance).filter((id): id is string => !!id))];
    }

    /** As the Model Explorer: select the row (if not selected) and its instance, then open the menu after the actions are known. */
    protected override handleContextMenuEvent(node: TreeNode | undefined, event: React.MouseEvent<HTMLElement>): void {
        if (!problemInstance(node)) return super.handleContextMenuEvent(node, event);
        event.stopPropagation();
        event.preventDefault();
        const row = node!;
        if (!this.model.selectedNodes.includes(row as never)) this.model.selectNode(row as never);
        this.focusService.setFocus(row as never);
        const ids = this.instances(row);
        this.selection.set({ ids });
        const target: ActionTarget = { ids };
        const { x, y } = event.nativeEvent;
        const context = event.currentTarget;
        void whenActionsKnown(this.actionService, this.actionService.targetOf(target))
            .then(() => this.contextMenuRenderer.render({ menuPath: PROBLEMS_CONTEXT_MENU, context, anchor: { x, y }, args: [target] }));
    }

    protected override createNodeAttributes(node: TreeNode, props: Parameters<ProblemWidget['createNodeAttributes']>[1]): React.Attributes & React.HTMLAttributes<HTMLElement> {
        const attrs = super.createNodeAttributes(node, props);
        if (!problemInstance(node)) return attrs;
        return {
            ...attrs,
            draggable: true,
            onDragStart: (e: React.DragEvent) => {
                e.dataTransfer.setData(DND_INSTANCES, this.instances(node).join('\n'));
                e.dataTransfer.effectAllowed = 'copy';
            }
        };
    }
}

@injectable()
export class ModelProblems implements FrontendApplicationContribution {
    @inject(ProblemManager) protected readonly problems: ProblemManager;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(StatusBar) protected readonly statusBar: StatusBar;
    protected published = new Set<string>();
    /** The rows of the last query: the label and class name of each instance with a problem. */
    protected rows: Problem[] = [];
    protected run = 0;

    onStart(): void {
        this.model.onDidChange(s => panelsUnchanged(s.change, true) || this.publish());
        this.model.start().then(() => this.publish());
    }

    /** The label and class name of an instance with a problem (the last query). */
    instance(id: string): Problem | undefined {
        return this.rows.find(p => p.instance === id);
    }

    protected async publish(): Promise<void> {
        const run = ++this.run;
        const violations = await this.model.service.problems();
        if (run !== this.run) return;
        this.rows = violations;
        const byUri = new Map<string, Diagnostic[]>();
        for (const v of violations) {
            const uri = v.instance ? elementUri(v.instance).toString() : `${ELEMENT_SCHEME}:/model`;
            const list = byUri.get(uri) ?? [];
            list.push({
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                severity: v.severity === 'Violation' ? DiagnosticSeverity.Error : v.severity === 'Warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
                source: 'SHACL',
                code: v.component + (v.pathName ? ` · ${v.pathName}` : ''),
                message: v.message
            });
            byUri.set(uri, list);
        }
        for (const uri of this.published) if (!byUri.has(uri)) this.problems.setMarkers(new URI(uri), OWNER, []);
        for (const [uri, list] of byUri) this.problems.setMarkers(new URI(uri), OWNER, list);
        this.published = new Set(byUri.keys());

        const s = this.model.snapshot;
        const errors = violations.filter(v => v.severity === 'Violation').length;
        if (!s.file) {
            this.statusBar.setElement('catenary-model', {
                text: '$(type-hierarchy) No workspace', alignment: StatusBarAlignment.LEFT, priority: 100,
                command: OpenModelCommands.OPEN.id, tooltip: 'Open a workspace'
            });
            return;
        }
        const name = baseName(s.file);
        this.statusBar.setElement('catenary-model', {
            text: `$(type-hierarchy) ${name}${s.dirty ? ' ●' : ''} · ${s.files.files.length} files · ${s.counts.instances} instances · `
                + (errors ? `$(error) ${errors} violations` : '$(check) valid'),
            alignment: StatusBarAlignment.LEFT, priority: 100,
            tooltip: [`Workspace: ${s.files.workspace?.path ?? '(none)'}${s.files.workspace && !s.files.workspace.onDisk ? ' (not on disk: a change of a setting writes it)' : ''}`, `Default file: ${s.files.defaultFile?.path ?? '(none)'}`,
                ...s.files.files.map(f => `${f.path}${f.kinds.length ? ` (${f.kinds.join(', ')})` : ''}`), s.dirty ? 'Not written yet' : 'Written'].join('\n'),
            command: 'problemsView:toggle'
        });
    }
}

@injectable()
export class ElementLabelProvider implements LabelProviderContribution {
    @inject(ModelProblems) protected readonly problems: ModelProblems;

    canHandle(element: object): number {
        return element instanceof URI && element.scheme === ELEMENT_SCHEME ? 500 : 0;
    }

    getName(uri: URI): string {
        const id = uri.path.base;
        return this.problems.instance(id)?.label ?? (id === 'model' ? 'Model' : id);
    }

    getLongName(uri: URI): string {
        return this.problems.instance(uri.path.base)?.className ?? '';
    }

    getIcon(): string {
        return codicon('symbol-object');
    }
}

@injectable()
export class ElementOpenHandler implements OpenHandler {
    readonly id = 'catenary-element-opener';
    readonly label = 'Show model element';
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(SelectionModel) protected readonly selection: SelectionModel;
    @inject(PropertyViewContribution) protected readonly properties: PropertyViewContribution;

    canHandle(uri: URI): number {
        return uri.scheme === ELEMENT_SCHEME ? 500 : 0;
    }

    /**
     * Mode 'reveal' (a click or an arrow key on a problem): select the instance and reveal Properties (the focus stays in
     * Problems), no view opens. Else (double-click, Enter): show it in a view.
     */
    async open(uri: URI, options?: OpenerOptions): Promise<object | undefined> {
        const id = uri.path.base;
        if ((options as { mode?: string } | undefined)?.mode === 'reveal') {
            if (id === 'model') return undefined;
            this.selection.set({ ids: [id] });
            await this.properties.openView({ activate: false, reveal: true });
        } else {
            await this.editors.show(id);
        }
        return undefined;
    }
}
