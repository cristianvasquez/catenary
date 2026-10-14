// The canvas zoom in the SVG export (spec/ui-manifest.hs §9.2 law_exportSizesUseCanvasZoom). GLSP renders the export at zoom 1 (the
// geometry in model units). Sizes that are constant on screen (edge-chrome.ts k = 1 / zoom: labels, badges, arrows, lanes) use the zoom
// of the canvas that the user sees, so that the export has the proportions of the canvas.

import { CommandExecutionContext, CommandResult, RequestExportAction, RequestExportCommand, TYPES, isViewport } from '@eclipse-glsp/client';
import { inject, injectable } from '@theia/core/shared/inversify';

/** A root of the export canvas: `canvasZoom` is the zoom of the live canvas when the export started. */
export interface ZoomedRoot { zoom?: number; canvasZoom?: number }

/** The zoom for sizes that are constant on screen: the canvas zoom of an export root, else the zoom of the root, else 1. */
export function sizeZoom(root: ZoomedRoot): number {
    const zoom = root.canvasZoom ?? root.zoom;
    return zoom && zoom > 0 ? zoom : 1;
}

/** The GLSP export command (zoom 1, no selection) that also gives the export root the zoom of the live canvas. */
@injectable()
export class CanvasZoomExportCommand extends RequestExportCommand {
    constructor(@inject(TYPES.Action) action: RequestExportAction) {
        super(action);
    }

    override execute(context: CommandExecutionContext): CommandResult {
        const result = super.execute(context);
        if (result.model !== context.root && isViewport(context.root)) (result.model as ZoomedRoot).canvasZoom = context.root.zoom;
        return result;
    }
}
