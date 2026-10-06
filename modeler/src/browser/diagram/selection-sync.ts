// View editors show the SelectionModel: each open view editor selects the part of the selection that it shows.
// A user gesture in a view editor goes the other way, through FocusedSelectionForwarder (diagram-configuration.ts).

import { SelectAction } from '@eclipse-glsp/client';
import { GLSPDiagramWidget } from '@eclipse-glsp/theia-integration';
import { ApplicationShell, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ownerOfLabel, panelsUnchanged } from '@catenary/model';
import { VIEW_SCHEME } from '../../common/protocol';
import { ModelFrontend } from '../model-client';
import { SelectionModel, sameIds } from '../selection-model';
import { selectionInDiagram } from './diagram-ids';
import { ViewEditors, viewIdOf } from './view-editors';

@injectable()
export class DiagramSelectionSync implements FrontendApplicationContribution {
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(SelectionModel) protected readonly selection: SelectionModel;
    protected readonly installed = new WeakSet<GLSPDiagramWidget>();

    onStart(): void {
        this.selection.onDidChange(() => this.editors.all().forEach(w => this.apply(w)));
        // The snapshot and the diagram updates come on different connections: apply again when either arrives. A snapshot also
        // redraws the halo of one selected element: its expand counts come from the frontend doc, not from the diagram.
        this.model.onDidChange(s => panelsUnchanged(s.change) || this.editors.all().forEach(w => this.apply(w, true)));
        this.shell.onDidAddWidget(w => {
            if (w instanceof GLSPDiagramWidget && w.uri.scheme === VIEW_SCHEME) this.install(w);
        });
        this.editors.all().forEach(w => this.install(w));
    }

    onDidInitializeLayout(): void {
        this.editors.all().forEach(w => this.install(w));
    }

    /** Apply the selection again after each model update: a view opened now, or an element that has just arrived. */
    protected install(w: GLSPDiagramWidget): void {
        if (this.installed.has(w)) return;
        this.installed.add(w);
        const listener = w.editorContext.onModelRootChanged(() => this.apply(w));
        w.disposed.connect(() => listener.dispose());
        this.apply(w);
    }

    protected apply(w: GLSPDiagramWidget, redrawHalo = false): void {
        // A new view editor has no model yet (the getter throws); onModelRootChanged applies the selection when it arrives.
        const ids = this.editors.diagram(w);
        if (!ids) return;
        const want = selectionInDiagram(ids, this.selection.selection, viewIdOf(w), (view, id) => this.editors.elementIn(view, id));
        const have = [...new Set(w.editorContext.selectedElements.map(e => ownerOfLabel(e.id)))];
        if (sameIds(want, have) && !(redrawHalo && want.length === 1)) return;
        w.actionDispatcher.dispatch(SelectAction.create({ selectedElementsIDs: want, deselectedElementsIDs: true }));
    }
}
