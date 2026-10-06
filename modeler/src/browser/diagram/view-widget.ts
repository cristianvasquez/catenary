// View editor widget. The tool palette is a bar above the canvas (see modeler.css), so the canvas
// is not the full widget: GLSP must get the bounds of the SVG, not of the widget node.

import { Bounds, InitializeCanvasBoundsAction } from '@eclipse-glsp/client';
import { GLSPDiagramWidget } from '@eclipse-glsp/theia-integration';
import { Message, Widget } from '@theia/core/lib/browser';
import { injectable } from '@theia/core/shared/inversify';

@injectable()
export class ViewDiagramWidget extends GLSPDiagramWidget {
    protected canvasObserver?: ResizeObserver;

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
    }

    protected override onBeforeDetach(msg: Message): void {
        this.canvasObserver?.disconnect();
        super.onBeforeDetach(msg);
    }
}
