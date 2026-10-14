// Text measurement for the SVG export (spec/ui-manifest.hs §9.2): card and note contents are HTML in foreignObject, which only browsers draw.
// The export canvas (the hidden canvas of GLSP, with all elements, also those outside the visible area) is measured before it is copied,
// so that markdown-export.ts can write each line as SVG text at the same place.

import { ExportSvgAction, GLSPSvgExporter, GModelRoot, RequestAction } from '@eclipse-glsp/client';
import { injectable } from '@theia/core/shared/inversify';

/** Edit controls: buttons, handles, "+ attribute". A document does not show them. */
export const EDIT_CONTROLS = '.shape-add-row, .member-add, .member-take-out, .member-remove, .row-out, .row-in, '
    + '.catenary-halo, .catenary-resize-handle, .sprotty-resize-handle, .logic-handle, .edge-end';

/** The SVG exporter of a view editor; it keeps the text lines of its last export. */
@injectable()
export class MeasuringSvgExporter extends GLSPSvgExporter {
    lines = new Map<string, TextLine[]>();

    protected override prepareSvgElement(svg: SVGSVGElement, root: GModelRoot, request?: RequestAction<ExportSvgAction>): SVGSVGElement {
        this.lines = measureText(svg);
        return super.prepareSvgElement(svg, root, request);
    }
}

/** One line of one text style, in the coordinates of its foreignObject: x of the start, y of the baseline, width on the canvas. */
export interface TextLine {
    text: string; x: number; y: number; width: number;
    fill: string; fontFamily: string; fontSize: number; fontWeight: string; fontStyle: string;
}

/** The same foreignObject in the canvas and in its export: the nearest ancestor with an id, and the index under it. */
export function foreignObjectKey(fo: Element): string {
    const owner = fo.parentElement?.closest('[id]');
    return `${owner?.id ?? ''}#${owner ? [...owner.querySelectorAll<Element>('foreignObject')].indexOf(fo) : 0}`;
}

/**
 * The text lines of each foreignObject of an SVG that is laid out. Edit controls are not measured. Each character is measured (Range); characters of one text node with the same top are
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
            if (!parent || !node.data.trim() || parent.closest(EDIT_CONTROLS)) continue;
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

/**
 * Fonts that a viewer finds by their name. The window draws a font list ("Helvetica Neue", Helvetica, Arial, sans-serif) with a font that
 * it finds through its own aliases (fontconfig: Arial → Liberation Sans); a viewer without these aliases (resvg, Zed) finds no font of
 * the list and draws another one. Real family names first: a name that is only an alias draws the same pixels as its font.
 */
const CANDIDATES = ['Liberation Sans', 'Arimo', 'Nimbus Sans', 'Noto Sans', 'DejaVu Sans', 'Cantarell', 'Ubuntu', 'Roboto', 'Inter', 'Open Sans',
    'Fira Sans', 'Source Sans 3', 'Segoe UI', 'Helvetica Neue', 'Helvetica', 'Arial', 'Verdana', 'Tahoma'];
const PROBE = 'Hamburgefonstiv 0123 dcat:inSeries EP_PLEN_DOC';
const drawnFonts = new Map<string, string | undefined>();

/** The installed font that the window draws for a font list: the candidate that draws the same pixels. Undefined: none of them. */
export function drawnFont(list: string): string | undefined {
    if (drawnFonts.has(list)) return drawnFonts.get(list);
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    let found: string | undefined;
    if (context) {
        context.canvas.width = 1200;
        context.canvas.height = 60;
        const pixels = (font: string) => {
            context.clearRect(0, 0, 1200, 60);
            context.font = `40px ${font}`;
            context.fillText(PROBE, 0, 45);
            return context.getImageData(0, 0, 1200, 60).data;
        };
        const target = pixels(list);
        // A candidate that is not installed draws monospace, which differs from the list.
        found = CANDIDATES.find(c => pixels(`"${c}", monospace`).every((v, i) => v === target[i]));
    }
    drawnFonts.set(list, found);
    return found;
}

/** The font list with the font that the window draws in front (drawnFont), so that every viewer finds that font by its name. */
export function withDrawnFont(list: string): string {
    const font = drawnFont(list);
    const first = list.split(',')[0].trim().replace(/^["']|["']$/g, '');
    return font && font !== first ? `"${font}", ${list}` : list;
}
