// Markdown export (spec/ui-manifest.hs §9): the documents of a folder, with each view embed as an SVG file in _resources/. The backend
// reads the folder, checks the view references and the destination, and writes (modeler/src/node/markdown-export.ts). This class asks
// for the destination and renders each embedded view once with its view editor (GLSP SVG export: zoom 1, no selection), so the file
// shows what the canvas shows. Views that are not open open for the export and close after it.

import { RequestExportAction } from '@eclipse-glsp/client';
import type { GLSPDiagramWidget } from '@eclipse-glsp/theia-integration';
import { MessageService, URI } from '@theia/core';
import { ApplicationShell, StorageService } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FileDialogService } from '@theia/filesystem/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import type { ExportProblem, UnresolvedEmbed } from '@catenary/model';
import { MarkdownExportCheck, MarkdownExportResult } from '../../common/protocol';
import { ModelFrontend } from '../model-client';
import { ViewEditors } from './view-editors';

/** Storage key of the last destination of each source folder (source path → destination path). */
const DESTINATIONS_KEY = 'catenary.markdownExport.destinations';
/** At most this number of items in a message; the rest is a count. */
const LISTED = 5;

@injectable()
export class MarkdownExport {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(FileDialogService) protected readonly fileDialog: FileDialogService;
    @inject(FileService) protected readonly files: FileService;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(StorageService) protected readonly storage: StorageService;

    /**
     * Export the Markdown documents of the folder `source` and its subfolders. Without `destination`: a folder dialog that starts at the
     * last destination of this source. Unresolved view references stop the export before it writes. Returns the result, undefined when
     * the dialog was canceled.
     */
    async exportFolder(source: string, destination?: string): Promise<MarkdownExportResult | MarkdownExportCheck | undefined> {
        const dest = destination ?? await this.askDestination(source);
        if (!dest) return undefined;
        const check = await this.model.service.checkMarkdownExport(source, dest);
        if (!check.ok) {
            this.messages.error(checkMessage(check));
            return check;
        }
        await this.remember(source, dest);
        const result = await this.model.service.exportMarkdown(source, dest, await this.render(check.views));
        if (!result.ok) this.messages.error(resultMessage(result));
        else {
            const changed = result.written.length + result.removed.length;
            this.messages.info(`Exported ${check.documents} document(s) and ${check.views.length} view(s) to ${check.destination ?? dest}: `
                + (changed ? `${result.written.length} file(s) written, ${result.removed.length} removed.` : 'no file changed.'));
        }
        const notes = [...problemLines(result.problems), ...result.kept.map(k => `${k}: changed after the last export; kept.`)];
        if (result.ok && notes.length) this.messages.warn(`Export notes: ${listed(notes)}`);
        return result;
    }

    protected async askDestination(source: string): Promise<string | undefined> {
        const last = (await this.destinations())[source];
        const picked = await this.fileDialog.showOpenDialog({
            title: 'Export Markdown to Folder', openLabel: 'Export', canSelectFiles: false, canSelectFolders: true, canSelectMany: false
        }, await this.existing(last ? URI.fromFilePath(last) : URI.fromFilePath(source).parent));
        return picked?.path.fsPath();
    }

    /** The folder `uri`, else its nearest parent that exists: the dialog starts in a folder that exists. */
    protected async existing(uri: URI): Promise<FileStat | undefined> {
        for (let at = uri; ; at = at.parent) {
            const stat = await this.files.resolve(at).catch(() => undefined);
            if (stat?.isDirectory) return stat;
            if (at.path.isRoot) return undefined;
        }
    }

    protected async destinations(): Promise<Record<string, string>> {
        return this.storage.getData<Record<string, string>>(DESTINATIONS_KEY, {});
    }

    protected async remember(source: string, destination: string): Promise<void> {
        const all = await this.destinations();
        if (all[source] !== destination) await this.storage.setData(DESTINATIONS_KEY, { ...all, [source]: destination });
    }

    /** The SVG of each view (view IRI → SVG). Opens missing view editors and closes them after. */
    protected async render(views: { iri: string; id: string }[]): Promise<Record<string, string>> {
        const current = this.shell.currentWidget;
        const opened: GLSPDiagramWidget[] = [];
        try {
            const svgs: Record<string, string> = {};
            for (const { iri, id } of views) {
                let widget = this.editors.find(id);
                if (!widget) {
                    widget = await this.editors.open(id, 'reveal');
                    opened.push(widget);
                }
                await widget.actionDispatcher.onceModelInitialized();
                const result = await widget.actionDispatcher.request(RequestExportAction.create('svg'));
                svgs[iri] = forDocument(result.data);
            }
            return svgs;
        } finally {
            for (const w of opened) w.close();
            if (current && !current.isDisposed) this.shell.revealWidget(current.id);
        }
    }
}

const listed = (lines: string[]) => lines.slice(0, LISTED).join(' · ') + (lines.length > LISTED ? ` · and ${lines.length - LISTED} more` : '');
const unresolvedLines = (u: UnresolvedEmbed[]) => u.map(e => `${e.file}:${e.line}: ${e.iri}`);
const problemLines = (p: ExportProblem[]) => p.map(e => `${e.file}:${e.line}: ${e.target}: ${e.message}`);

/** The message of a check that stops the export: the error, and each unresolved reference with its file, line and IRI. */
export function checkMessage(check: MarkdownExportCheck): string {
    return check.unresolved.length ? `${check.error} ${listed(unresolvedLines(check.unresolved))}` : check.error ?? 'The export failed.';
}

/** The message of a failed export: the error, the conflicts or unresolved references, and the files written before a failure. */
export function resultMessage(result: MarkdownExportResult): string {
    const items = [...unresolvedLines(result.unresolved ?? []), ...result.conflicts, ...(result.failed ? result.written.map(w => `written: ${w}`) : [])];
    return items.length ? `${result.error} ${listed(items)}` : result.error ?? 'The export failed.';
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
    addBackground(root, box);
    replaceForeignObjects(root);
    for (const e of [root, ...root.querySelectorAll<SVGElement | HTMLElement>('[style]')]) {
        normalizeStyle(e);
        const style = e.style;
        for (const p of [...style]) if (p.startsWith('--') || (e === root && CANVAS_PROPERTY.test(p))) style.removeProperty(p);
        if (!style.length) e.removeAttribute('style');
    }
    root.querySelectorAll<SVGElement>('*').forEach(e => {
        for (const attr of ['fill', 'stroke', 'color']) {
            const value = e.getAttribute(attr);
            if (value) e.setAttribute(attr, normalizeColor(value));
        }
    });
    root.setAttribute('width', String(Math.ceil(box[2])));
    root.setAttribute('height', String(Math.ceil(box[3])));
    return new XMLSerializer().serializeToString(root);
}

function addBackground(root: SVGSVGElement, box: number[]): void {
    const background = root.style.backgroundColor;
    if (!background || background === 'transparent' || background === 'rgba(0, 0, 0, 0)') return;
    const rect = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(box[0]));
    rect.setAttribute('y', String(box[1]));
    rect.setAttribute('width', String(box[2]));
    rect.setAttribute('height', String(box[3]));
    rect.setAttribute('fill', normalizeColor(background));
    root.insertBefore(rect, root.firstChild);
}

function replaceForeignObjects(root: SVGSVGElement): void {
    for (const fo of [...root.querySelectorAll<SVGForeignObjectElement>('foreignObject')]) {
        const text = foreignObjectText(fo);
        if (text) fo.replaceWith(text);
    }
}

function foreignObjectText(fo: SVGForeignObjectElement): SVGGElement | undefined {
    const doc = fo.ownerDocument;
    const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
    const x = numberAttr(fo, 'x') + 14;
    let y = numberAttr(fo, 'y') + 24;
    const body = fo.firstElementChild as HTMLElement | undefined;
    const parts = body ? [...body.children] as HTMLElement[] : [];
    const items = parts.length ? parts : [body].filter((e): e is HTMLElement => !!e);
    for (const item of items) {
        const value = (item.textContent ?? '').trim();
        if (!value) continue;
        const size = parseFloat(item.style.fontSize || '') || (item.classList.contains('card-name') ? 22 : 14);
        const lineHeight = parseFloat(item.style.lineHeight || '') || size * 1.2;
        const t = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', String(x));
        t.setAttribute('y', String(y));
        t.setAttribute('fill', normalizeColor(item.style.color || body?.style.color || 'rgb(204, 204, 204)'));
        t.setAttribute('font-size', String(size));
        t.setAttribute('font-family', 'Helvetica Neue, Helvetica, Arial, sans-serif');
        if (item.style.fontWeight) t.setAttribute('font-weight', item.style.fontWeight);
        if (item.style.textTransform === 'uppercase') t.textContent = value.toUpperCase();
        else t.textContent = value;
        g.appendChild(t);
        y += lineHeight + (item.classList.contains('card-name') ? 10 : 4);
    }
    return g.childNodes.length ? g : undefined;
}

function numberAttr(e: Element, name: string): number {
    const n = Number(e.getAttribute(name) ?? 0);
    return Number.isFinite(n) ? n : 0;
}

function normalizeStyle(e: SVGElement | HTMLElement): void {
    const style = e.getAttribute('style');
    if (style) e.setAttribute('style', normalizeColor(style));
}

function normalizeColor(value: string): string {
    return value.replace(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/g,
        (_m, r, g, b, a) => a === undefined
            ? `rgb(${toByte(r)}, ${toByte(g)}, ${toByte(b)})`
            : `rgba(${toByte(r)}, ${toByte(g)}, ${toByte(b)}, ${roundAlpha(a)})`);
}

function toByte(n: string): number {
    return Math.max(0, Math.min(255, Math.round(Number(n) * 255)));
}

function roundAlpha(n: string): string {
    return String(Math.max(0, Math.min(1, Number(n))).toFixed(3)).replace(/0+$/, '').replace(/[.]$/, '');
}
