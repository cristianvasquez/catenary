// View editor widget. The tool palette is a bar above the canvas (see modeler.css), so the canvas
// is not the full widget: GLSP must get the bounds of the SVG, not of the widget node.
// The server learns when the canvas is shown or hidden (a tab behind another one): a hidden canvas gets one update when shown.

import { Bounds, InitializeCanvasBoundsAction, RequestAction, ResponseAction } from '@eclipse-glsp/client';
import { GLSPDiagramWidget } from '@eclipse-glsp/theia-integration';
import { Message, Widget } from '@theia/core/lib/browser';
import { injectable } from '@theia/core/shared/inversify';
import { afterRevision } from './after-revision';

/** Client action to the GLSP server: the canvas is shown or hidden (handlers.ts SetVisibleAction). */
export const SET_VISIBLE = 'catenarySetVisible';

@injectable()
export class ViewDiagramWidget extends GLSPDiagramWidget {
    protected canvasObserver?: ResizeObserver;

    /** Resolves when the client model has the update of the last show (or at once): see `whenShowUpdated`. */
    protected showUpdate: Promise<void> = Promise.resolve();

    /**
     * The client learns the server actions when the diagram loads: a dispatch before the model is initialized has no handler. A show
     * is a request: the answer gives the revision of the model after the update of the show (handlers.ts VisibleSetAction).
     */
    protected sendVisible(visible: boolean): void {
        const dispatcher = this.actionDispatcher;
        const initialized = dispatcher.onceModelInitialized();
        if (!visible) {
            initialized.then(() => dispatcher.dispatch({ kind: SET_VISIBLE, visible } as never)).catch(() => { /* the session is closed */ });
            return;
        }
        const answer = initialized.then(() => dispatcher.request({ kind: SET_VISIBLE, visible, requestId: RequestAction.generateRequestId() } as never));
        this.showUpdate = afterRevision(answer.then(r => (r as ResponseAction & { revision: number }).revision),
            () => this.editorContext.modelRoot.revision ?? 0, l => this.editorContext.onModelRootChanged(l));
    }

    /**
     * Resolves when the client model has the update that the last show of the canvas sent, at most after 2 s. A reveal centers after
     * it: a card that moved while the canvas was hidden has its new position (ui-manifest §3.2 law_revealAfterShowUpdate).
     */
    whenShowUpdated(): Promise<void> {
        return this.showUpdate;
    }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        this.sendVisible(true);
        this.updateCanvasBounds();
    }

    protected override onAfterHide(msg: Message): void {
        super.onAfterHide(msg);
        this.sendVisible(false);
    }

    protected canvasBounds(): Bounds | undefined {
        const svg = this.node.querySelector('svg.sprotty-graph');
        return svg ? this.getBoundsInPage(svg) : undefined;
    }

    protected updateCanvasBounds(): void {
        const bounds = this.canvasBounds();
        if (bounds && bounds.width > 0 && bounds.height > 0) this.actionDispatcher.dispatch(InitializeCanvasBoundsAction.create(bounds));
    }

    protected override onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        this.updateCanvasBounds();
    }

    protected override onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        // The palette bar appears or wraps after the first render: its height changes the SVG size and position.
        this.canvasObserver = new ResizeObserver(() => this.updateCanvasBounds());
        const observe = () => {
            const svg = this.node.querySelector('svg.sprotty-graph');
            if (svg) this.canvasObserver!.observe(svg);
            else requestAnimationFrame(observe);
        };
        observe();
        // Restored editors attach behind the active tab: hidden until their tab is shown.
        this.sendVisible(this.isVisible);
    }

    protected override onBeforeDetach(msg: Message): void {
        this.canvasObserver?.disconnect();
        super.onBeforeDetach(msg);
    }
}
