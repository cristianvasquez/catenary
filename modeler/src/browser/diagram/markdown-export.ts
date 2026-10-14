// Markdown export (spec/ui-manifest.hs §9): the documents of a selection of files and folders, with each view embed as an SVG file in _resources/. The backend
// reads the sources, checks the view references and the destination, and writes (modeler/src/node/markdown-export.ts). This class shows
// the confirmation dialog (markdown-export-dialog.tsx) and renders each embedded view once with its view editor (GLSP SVG export: zoom 1, no selection), so the file
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
import { MarkdownExportDialog } from './markdown-export-dialog';
import { ViewEditors } from './view-editors';

/** Storage key of the last destination of each source root (root path → destination path). */
const DESTINATIONS_KEY = 'catenary.markdownExport.destinations';
/** Storage key of the last successful export of each workspace (workspace file → request). */
const LAST_KEY = 'catenary.markdownExport.last';
/** The request of an export: sources, destination and unchecked documents. Run Last Markdown Export repeats it. */
export interface LastExport { sources: string[]; destination: string; exclude: string[] }
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
     * Export the Markdown documents of the sources (files, and folders with their subfolders) under their common folder (the root).
     * Without `destination`: the confirmation dialog (destination, documents with checkboxes); the export writes the checked documents.
     * With `destination` (CLI): no dialog, all documents. Unresolved view references in the exported documents stop the export
     * before it writes. A check without a root or without documents stops before the dialog. Returns the
     * result, undefined when the dialog was canceled.
     */
    async exportSelection(sources: string[], destination?: string): Promise<MarkdownExportResult | MarkdownExportCheck | undefined> {
        // The workspace at the start: another workspace can open during the check, the dialog, the render or the writes.
        const workspace = this.model.snapshot.file;
        // Unresolved embeds do not stop here: the dialog lists them, and the user can uncheck their documents. The final check decides.
        const check = await this.model.service.checkMarkdownExport({ sources });
        if (!check.root || !check.documents.length) {
            this.messages.error(check.root && !check.error ? 'The selection has no Markdown documents.' : checkMessage(check));
            return check;
        }
        let dest = destination;
        let exclude: string[] = [];
        if (dest === undefined) {
            const answer = await new MarkdownExportDialog(check, (await this.destinations())[check.root], current => this.askDestination(check.root, current)).open();
            if (!answer) return undefined;
            dest = answer.destination;
            exclude = answer.exclude;
        }
        return this.run(workspace, { sources, destination: dest, exclude });
    }

    /** Repeat the last successful export of this workspace: no dialog. Undefined when there is none. */
    async runLast(): Promise<MarkdownExportResult | MarkdownExportCheck | undefined> {
        const workspace = this.model.snapshot.file;
        const last = workspace ? (await this.lastExports())[workspace] : undefined;
        if (!last) {
            this.messages.info('No earlier Markdown export in this workspace. Use Export Markdown… first.');
            return undefined;
        }
        return this.run(workspace, last);
    }

    /** Check, render and write. A successful export becomes the last export of `workspace`, the workspace where the command started. */
    protected async run(workspace: string | undefined, { sources, destination: dest, exclude }: LastExport): Promise<MarkdownExportResult | MarkdownExportCheck> {
        const final = await this.model.service.checkMarkdownExport({ sources, destination: dest, exclude });
        if (!final.ok) {
            this.messages.error(checkMessage(final));
            return final;
        }
        await this.remember(final.root, dest);
        const result = await this.model.service.exportMarkdown({ sources, destination: dest, exclude }, await this.render(final.views));
        if (!result.ok) this.messages.error(resultMessage(result));
        else {
            const changed = result.written.length + result.removed.length;
            this.messages.info(`Exported ${final.documents.length} document(s) and ${final.views.length} view(s) to ${final.destination ?? dest}: `
                + (changed ? `${result.written.length} file(s) written, ${result.removed.length} removed.` : 'no file changed.'));
            if (workspace) await this.rememberLast(workspace, { sources, destination: dest, exclude });
        }
        const notes = [...problemLines(result.problems), ...result.kept.map(k => `${k}: changed after the last export; kept.`)];
        if (result.ok && notes.length) this.messages.warn(`Export notes: ${listed(notes)}`);
        return result;
    }

    /** The folder dialog. It starts at `current`, else at the last destination of the root, else at the parent of the root. */
    protected async askDestination(root: string, current?: string): Promise<string | undefined> {
        const last = current ?? (await this.destinations())[root];
        const picked = await this.fileDialog.showOpenDialog({
            title: 'Export Markdown to Folder', openLabel: 'Select', canSelectFiles: false, canSelectFolders: true, canSelectMany: false
        }, await this.existing(last ? URI.fromFilePath(last) : URI.fromFilePath(root).parent));
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

    protected async lastExports(): Promise<Record<string, LastExport>> {
        return this.storage.getData<Record<string, LastExport>>(LAST_KEY, {});
    }

    protected async rememberLast(workspace: string, request: LastExport): Promise<void> {
        await this.storage.setData(LAST_KEY, { ...await this.lastExports(), [workspace]: request });
    }

    protected async destinations(): Promise<Record<string, string>> {
        return this.storage.getData<Record<string, string>>(DESTINATIONS_KEY, {});
    }

    protected async remember(root: string, destination: string): Promise<void> {
        const all = await this.destinations();
        if (all[root] !== destination) await this.storage.setData(DESTINATIONS_KEY, { ...all, [root]: destination });
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
                await this.shell.revealWidget(widget.id);
                await settled(widget.node);
                const result = await widget.actionDispatcher.request(RequestExportAction.create('svg'));
                const live = widget.node.querySelector<SVGSVGElement>('svg.sprotty-graph');
                svgs[iri] = forDocument(result.data, live ? measureText(live) : new Map());
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

/** The view box from getBBox does not contain the stroke width: a margin keeps the frame borders and titles. */
const MARGIN = 8;

/**
 * The export copies computed styles: the root also gets the size of the canvas (block-size, width, height) and every CSS
 * custom property of the window (about 100 KB). Computed values do not use custom properties, so they are removed on all
 * elements. The size goes to the width and height attributes, so that the page CSS can scale the figure down. Edit controls
 * are removed. Each foreignObject (card and note contents, HTML) becomes SVG text at the positions measured on the canvas (measureText), so
 * that viewers without HTML in SVG (librsvg, imv) draw the same lines.
 */
export function forDocument(svg: string, lines: Map<string, TextLine[]> = new Map()): string {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement;
    const bounds = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (!(root instanceof SVGSVGElement) || bounds?.length !== 4) return svg;
    const [x, y, w, h] = bounds;
    const box = [x - MARGIN, y - MARGIN, w + 2 * MARGIN, h + 2 * MARGIN];
    root.setAttribute('viewBox', box.join(' '));
    root.querySelectorAll(EDIT_CONTROLS).forEach(e => e.remove());
    addBackground(root, box);
    for (const fo of [...root.querySelectorAll('foreignObject')]) {
        const g = doc.createElementNS(SVG_NS, 'g');
        for (const line of lines.get(foreignObjectKey(fo)) ?? []) g.appendChild(textElement(doc, line));
        fo.replaceWith(g);
    }
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

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A view editor that opens draws its cards and sets its zoom after the model is initialized. Wait until the canvas does not change for
 * 300 ms (at most 5 s), so that the export and the text measurement read the same final canvas.
 */
async function settled(node: HTMLElement): Promise<void> {
    const state = () => {
        const svg = node.querySelector('svg.sprotty-graph');
        return `${svg?.querySelectorAll('foreignObject').length}|${svg?.querySelector('g')?.getAttribute('transform')}|${svg?.getBoundingClientRect().width}`;
    };
    const end = Date.now() + 5000;
    let last = state(), since = Date.now();
    while (Date.now() < end && Date.now() - since < 300) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const now = state();
        if (now !== last) [last, since] = [now, Date.now()];
    }
    await document.fonts.ready;
}

/** One line of one text style, in the coordinates of its foreignObject: x of the start, y of the baseline, width on the canvas. */
export interface TextLine {
    text: string; x: number; y: number; width: number;
    fill: string; fontFamily: string; fontSize: number; fontWeight: string; fontStyle: string;
}

/** The same foreignObject in the canvas and in its export: the nearest ancestor with an id, and the index under it. */
function foreignObjectKey(fo: Element): string {
    const owner = fo.parentElement?.closest('[id]');
    return `${owner?.id ?? ''}#${owner ? [...owner.querySelectorAll<Element>('foreignObject')].indexOf(fo) : 0}`;
}

/**
 * The text lines of each foreignObject of the canvas. Each character is measured (Range); characters of one text node with the same top are
 * one line. Characters outside a clipping ancestor (overflow, line clamp) are not drawn. The baseline comes from the font ascent.
 */
export function measureText(svg: SVGSVGElement): Map<string, TextLine[]> {
    const result = new Map<string, TextLine[]>();
    const doc = svg.ownerDocument;
    const context = doc.createElement('canvas').getContext('2d');
    for (const fo of svg.querySelectorAll<SVGForeignObjectElement>('foreignObject')) {
        const toLocal = fo.getScreenCTM()?.inverse();
        if (!toLocal) continue;
        const lines: TextLine[] = [];
        const walker = doc.createTreeWalker(fo, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
            const parent = node.parentElement;
            if (!parent || !node.data.trim()) continue;
            const style = getComputedStyle(parent);
            if (style.visibility === 'hidden') continue;
            const clip = clipRect(parent, fo);
            const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            let ascent = parseFloat(style.fontSize) * 0.8, descent = parseFloat(style.fontSize) * 0.2;
            if (context) {
                context.font = font;
                const m = context.measureText('Hg');
                if (m.fontBoundingBoxAscent) [ascent, descent] = [m.fontBoundingBoxAscent, m.fontBoundingBoxDescent];
            }
            const upper = style.textTransform === 'uppercase';
            const range = doc.createRange();
            let line: { text: string; left: number; right: number; top: number; bottom: number } | undefined;
            const flush = () => {
                if (!line?.text.trim()) return;
                const scale = (line.bottom - line.top) / (ascent + descent) || 1;
                const start = new DOMPoint(line.left, line.top + ascent * scale).matrixTransform(toLocal);
                const end = new DOMPoint(line.right, line.top + ascent * scale).matrixTransform(toLocal);
                lines.push({
                    text: line.text.replace(/\s+$/, ''), x: start.x, y: start.y, width: end.x - start.x, fill: style.color,
                    fontFamily: style.fontFamily, fontSize: parseFloat(style.fontSize),
                    fontWeight: style.fontWeight, fontStyle: style.fontStyle
                });
            };
            for (let i = 0; i < node.data.length; i++) {
                range.setStart(node, i);
                range.setEnd(node, i + 1);
                const r = range.getBoundingClientRect();
                if (!r.width && !r.height) continue;
                const visible = r.left + r.width / 2 >= clip.left && r.left + r.width / 2 <= clip.right && r.top + r.height / 2 >= clip.top && r.top + r.height / 2 <= clip.bottom;
                if (!visible) continue;
                const ch = upper ? node.data[i].toUpperCase() : node.data[i];
                if (line && Math.abs(r.top - line.top) < r.height / 2) {
                    line.text += /\s/.test(ch) ? ' ' : ch;
                    if (!/\s/.test(ch)) line.right = r.right;
                } else {
                    flush();
                    line = /\s/.test(ch) ? undefined : { text: ch, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
                }
            }
            flush();
        }
        result.set(foreignObjectKey(fo), lines);
    }
    return result;
}

/** The visible box of an element: the box of the foreignObject cut by each ancestor that clips its overflow. */
function clipRect(element: Element, fo: Element): { left: number; right: number; top: number; bottom: number } {
    const f = fo.getBoundingClientRect();
    const box = { left: f.left, right: f.right, top: f.top, bottom: f.bottom };
    for (let e: Element | null = element; e && e !== fo; e = e.parentElement) {
        const style = getComputedStyle(e);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const r = e.getBoundingClientRect();
        box.left = Math.max(box.left, r.left); box.right = Math.min(box.right, r.right);
        box.top = Math.max(box.top, r.top); box.bottom = Math.min(box.bottom, r.bottom);
    }
    return box;
}

/** A text line as SVG. textLength keeps the measured width when a viewer uses another font. */
function textElement(doc: Document, line: TextLine): SVGTextElement {
    const t = doc.createElementNS(SVG_NS, 'text') as SVGTextElement;
    const round = (n: number) => String(Math.round(n * 100) / 100);
    t.setAttribute('x', round(line.x));
    t.setAttribute('y', round(line.y));
    t.setAttribute('fill', normalizeColor(line.fill));
    t.setAttribute('font-family', line.fontFamily);
    t.setAttribute('font-size', round(line.fontSize));
    if (line.fontWeight !== '400') t.setAttribute('font-weight', line.fontWeight);
    if (line.fontStyle !== 'normal') t.setAttribute('font-style', line.fontStyle);
    if (line.width > 0) {
        t.setAttribute('textLength', round(line.width));
        t.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
    t.setAttribute('xml:space', 'preserve');
    t.textContent = line.text;
    return t;
}

function addBackground(root: SVGSVGElement, box: number[]): void {
    const background = root.style.backgroundColor;
    if (!background || background === 'transparent' || background === 'rgba(0, 0, 0, 0)') return;
    const rect = root.ownerDocument.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(box[0]));
    rect.setAttribute('y', String(box[1]));
    rect.setAttribute('width', String(box[2]));
    rect.setAttribute('height', String(box[3]));
    rect.setAttribute('fill', normalizeColor(background));
    root.insertBefore(rect, root.firstChild);
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
