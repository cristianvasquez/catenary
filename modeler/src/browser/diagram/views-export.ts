// Export views as one HTML document. Each view is rendered by its view editor (GLSP SVG export: zoom 1, no selection),
// so the document shows what the canvas shows. Views that are not open open for the export and close after it.

import { RequestExportAction } from '@eclipse-glsp/client';
import type { GLSPDiagramWidget } from '@eclipse-glsp/theia-integration';
import { MessageService, URI } from '@theia/core';
import { ApplicationShell } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FileDialogService } from '@theia/filesystem/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { baseName, dirName, relativePath } from '@catenary/model';
import { DocumentColors, ViewFigure, viewsHtml } from '../../common/views-html';
import { ModelFrontend } from '../model-client';
import { SelectionModel } from '../selection-model';
import { ViewEditors } from './view-editors';
import { initialRows } from '../../common/view-order';
import { ViewOrderDialog } from './view-order-dialog';

@injectable()
export class ViewsExport {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(SelectionModel) protected readonly selection: SelectionModel;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(FileDialogService) protected readonly fileDialog: FileDialogService;
    @inject(FileService) protected readonly files: FileService;
    @inject(WorkspaceService) protected readonly workspace: WorkspaceService;
    @inject(MessageService) protected readonly messages: MessageService;

    /**
     * Without `viewIds`: a dialog to check and order the views (the views of the last export, stored in the workspace file, else the
     * selected views, else the current view, are checked). Without `file`: a save dialog. Returns the path of the written file.
     */
    async exportHtml(viewIds?: string[], file?: string): Promise<string | undefined> {
        const ids = viewIds ?? await this.pickViews();
        if (!ids?.length) return undefined;
        const labels = await this.model.service.viewLabels();
        const unknown = ids.filter(id => labels[id] === undefined);
        if (unknown.length) {
            this.messages.error(`No view with the id ${unknown.join(', ')}.`);
            return undefined;
        }
        const picked = file ?? (await this.fileDialog.showSaveDialog({ title: 'Export views as HTML', filters: { 'HTML': ['html'] } },
            (await this.workspace.roots)[0]))?.path.fsPath();
        if (!picked) return undefined;
        // The save dialog does not add the extension of the filter.
        const path = /\.html?$/i.test(picked) ? picked : `${picked}.html`;
        const figures = await this.render(ids, labels);
        const title = (this.model.snapshot.file ? baseName(this.model.snapshot.file).replace(/\.trig$/, '') : undefined) ?? 'Views';
        await this.files.write(URI.fromFilePath(path), viewsHtml(title, figures, documentColors()));
        this.messages.info(`Exported ${figures.length} view(s) to ${path}.`);
        return path;
    }

    /** All views in view order, each with the folder of its file. */
    async views(): Promise<{ id: string; label: string; folder: string }[]> {
        return (await this.model.viewsSorted()).map(v => ({ id: v.id, label: v.label, folder: this.folderOf(v.id) }));
    }

    /** The folder of the file of a view, relative to the workspace folder ('' : the workspace folder). */
    protected folderOf(view: string): string {
        const { file, files } = this.model.snapshot;
        const path = files.views.find(f => f.view === view)?.path;
        const rel = path && file ? relativePath(dirName(file), path) : undefined;
        return rel ? rel.replace(/\/?[^/]*$/, '') : '';
    }

    protected async pickViews(): Promise<string[] | undefined> {
        const stored = this.model.snapshot.exportViews ?? [];
        const s = await this.selection.resolve();
        const current = this.editors.currentViewId();
        const checked = stored.length ? stored : s.views.length ? s.views : current ? [current] : [];
        const views = await this.views();
        const ids = await new ViewOrderDialog(initialRows(views, checked), views.map(v => v.id)).open();
        // The choice goes to the manifest of the workspace file (dirty until saved). Same choice: no change.
        if (ids?.length && ids.join('\n') !== stored.join('\n')) {
            const r = await this.model.service.setExportViews(ids);
            if (!r.ok) this.messages.warn(`The view order is not stored: ${r.error}`);
        }
        return ids;
    }

    /** One figure for each view, in the order of `ids`. Opens missing view editors and closes them after. */
    protected async render(ids: string[], labels: Record<string, string>): Promise<ViewFigure[]> {
        const current = this.shell.currentWidget;
        const opened: GLSPDiagramWidget[] = [];
        try {
            const figures: ViewFigure[] = [];
            for (const id of ids) {
                let widget = this.editors.find(id);
                if (!widget) {
                    widget = await this.editors.open(id, 'reveal');
                    opened.push(widget);
                }
                await widget.actionDispatcher.onceModelInitialized();
                const result = await widget.actionDispatcher.request(RequestExportAction.create('svg'));
                figures.push({ label: labels[id], svg: forDocument(result.data) });
            }
            return figures;
        } finally {
            for (const w of opened) w.close();
            if (current && !current.isDisposed) this.shell.revealWidget(current.id);
        }
    }
}

/** Edit controls: buttons, handles, "+ attribute". A document does not show them. */
const EDIT_CONTROLS = '.shape-add-row, .member-add, .member-take-out, .member-remove, .row-out, .row-in, '
    + '.catenary-halo, .catenary-resize-handle, .sprotty-resize-handle, .logic-handle, .edge-end';

/** Properties of the canvas element (its size in the window, its box), not of the diagram. */
const CANVAS_PROPERTY = /^(width|height|(min-|max-)?(block|inline)-size|(min|max)-(width|height)|flex|perspective-origin|transform-origin|cursor|border|user-select|position|inset|top|left|right|bottom)/;

/**
 * The export copies computed styles: the root also gets the size of the canvas (block-size, width, height) and every CSS
 * custom property of the window (about 100 KB). Computed values do not use custom properties, so they are removed on all
 * elements. The size goes to the width and height attributes, so that the page CSS can scale the figure down. Edit controls
 * are removed.
 */
export function forDocument(svg: string): string {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement;
    const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (!(root instanceof SVGSVGElement) || box?.length !== 4) return svg;
    root.querySelectorAll(EDIT_CONTROLS).forEach(e => e.remove());
    for (const e of [root, ...root.querySelectorAll<SVGElement | HTMLElement>('[style]')]) {
        const style = e.style;
        for (const p of [...style]) if (p.startsWith('--') || (e === root && CANVAS_PROPERTY.test(p))) style.removeProperty(p);
        if (!style.length) e.removeAttribute('style');
    }
    root.setAttribute('width', String(Math.ceil(box[2])));
    root.setAttribute('height', String(Math.ceil(box[3])));
    return new XMLSerializer().serializeToString(root);
}

/** Page colors of the current theme. */
function documentColors(): DocumentColors {
    const style = getComputedStyle(document.body);
    const get = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    return {
        background: get('--theia-editor-background', '#ffffff'),
        foreground: get('--theia-foreground', '#1f1f1f'),
        muted: get('--theia-descriptionForeground', '#6f6f6f')
    };
}
