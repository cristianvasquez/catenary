// Markdown documents with view embeds (spec/ui-manifest.hs §9). An embed is a standard Markdown image whose destination is the IRI of
// a view: ![Label](urn:name:Main). Export replaces each embed with an image link to an SVG file under _resources/. This module is pure:
// it finds links, images and link definitions, decides which are embeds and plans the export. Rendering and file access are elsewhere
// (modeler/src/browser/diagram/markdown-export.ts, modeler/src/node/markdown-export.ts).

import { sha256Hex } from './sha256';

/** The folder of the export destination for SVG files and for copies of files outside the source folder. */
export const EXPORT_RESOURCES = '_resources';

/** File extensions of Markdown documents. */
export const isMarkdownPath = (path: string): boolean => /\.(md|markdown)$/i.test(path);

export type MarkdownRefKind = 'image' | 'link' | 'definition';

/** A link, an image or a link reference definition of a Markdown text. Offsets are UTF-16 indexes of the text. */
export interface MarkdownRef {
    kind: MarkdownRefKind;
    /** The whole construct: `![alt](dest "title")`, `[text](dest)`, or the destination of a definition. */
    start: number;
    end: number;
    /** The destination as written (with its angle brackets, if any). */
    destStart: number;
    destEnd: number;
    /** The destination, without angle brackets and backslash escapes. */
    destination: string;
    /** The text of a link or the alternative text of an image, as written. */
    text: string;
    /** 1-based line of `start`. */
    line: number;
}

/** Fenced code blocks and HTML comments: Markdown there is text, not links. */
function skippedRanges(text: string): [number, number][] {
    const ranges: [number, number][] = [];
    let fence: { char: string; length: number; start: number } | undefined;
    for (let at = 0; at < text.length;) {
        const nl = text.indexOf('\n', at);
        const end = nl < 0 ? text.length : nl + 1;
        const line = text.slice(at, end).replace(/\r?\n$/, '');
        if (fence) {
            const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
            if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
                ranges.push([fence.start, end]);
                fence = undefined;
            }
        } else {
            const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
            if (open && !(open[1][0] === '`' && open[2].includes('`'))) fence = { char: open[1][0], length: open[1].length, start: at };
        }
        at = end;
    }
    if (fence) ranges.push([fence.start, text.length]);
    for (let i = text.indexOf('<!--'); i >= 0; i = text.indexOf('<!--', i + 4)) {
        if (ranges.some(([s, e]) => i >= s && i < e)) continue;
        const close = text.indexOf('-->', i + 4);
        ranges.push([i, close < 0 ? text.length : close + 3]);
        if (close < 0) break;
    }
    return ranges.sort((a, b) => a[0] - b[0]);
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const unescape = (s: string) => s.replace(/\\(.)/g, (m, c: string) => (PUNCTUATION.test(c) ? c : m));

/** The index after the `]` that closes the `[` at `open`; -1 when none closes it before a blank line. */
function closeBracket(text: string, open: number): number {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (c === '\\') { i++; continue; }
        if (c === '\n' && /^\n[ \t]*(\n|$)/.test(text.slice(i, i + 80))) return -1;
        if (c === '[') depth++;
        else if (c === ']' && --depth === 0) return i + 1;
    }
    return -1;
}

/** The destination and optional title of an inline link at `open` (the `(`): the destination range and the index after the `)`. */
function inlineTail(text: string, open: number): { destStart: number; destEnd: number; raw: string; end: number } | undefined {
    let i = open + 1;
    const space = () => { while (i < text.length && /[ \t]/.test(text[i])) i++; if (text[i] === '\n') { i++; while (/[ \t]/.test(text[i] ?? '')) i++; } };
    space();
    const destStart = i;
    let raw: string;
    if (text[i] === '<') {
        i++;
        while (i < text.length && text[i] !== '>') {
            if (text[i] === '\n' || text[i] === '<') return undefined;
            i += text[i] === '\\' ? 2 : 1;
        }
        if (text[i] !== '>') return undefined;
        i++;
        raw = text.slice(destStart + 1, i - 1);
    } else {
        let depth = 0;
        while (i < text.length && !/[\s]/.test(text[i])) {
            if (text[i] === '\\') { i += 2; continue; }
            if (text[i] === '(') depth++;
            if (text[i] === ')' && depth-- === 0) break;
            i++;
        }
        if (depth > 0) return undefined;
        raw = text.slice(destStart, i);
    }
    const destEnd = i;
    space();
    if (i > destEnd && /["'(]/.test(text[i] ?? '')) {
        const close = text[i] === '(' ? ')' : text[i];
        for (i++; i < text.length && text[i] !== close; i += text[i] === '\\' ? 2 : 1) if (text[i] === '\n' && /^\n[ \t]*\n/.test(text.slice(i, i + 80))) return undefined;
        if (text[i] !== close) return undefined;
        i++;
        space();
    }
    return text[i] === ')' ? { destStart, destEnd, raw, end: i + 1 } : undefined;
}

const DEFINITION = /^ {0,3}\[((?:[^\]\\\n]|\\.)+)\]:[ \t]*(<(?:[^<>\n\\]|\\.)*>|\S+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*\r?$/;

/** The links, images and link reference definitions of a Markdown text, in text order. Code spans, fenced code and comments do not count. */
export function markdownRefs(text: string): MarkdownRef[] {
    const skipped = skippedRanges(text);
    const lineStarts = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
    const lineOf = (offset: number) => {
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
        return lo + 1;
    };
    const refs: MarkdownRef[] = [];
    let r = 0;
    for (let i = 0; i < text.length;) {
        while (r < skipped.length && skipped[r][1] <= i) r++;
        if (r < skipped.length && skipped[r][0] <= i) { i = skipped[r][1]; continue; }
        const c = text[i];
        if (i === 0 || text[i - 1] === '\n') {
            const lineEnd = text.indexOf('\n', i);
            const line = text.slice(i, lineEnd < 0 ? text.length : lineEnd);
            const m = DEFINITION.exec(line);
            if (m) {
                const destStart = i + line.indexOf(m[2], line.indexOf(']:') + 2);
                const angle = m[2].startsWith('<');
                refs.push({
                    kind: 'definition', start: destStart, end: destStart + m[2].length, destStart, destEnd: destStart + m[2].length,
                    destination: unescape(angle ? m[2].slice(1, -1) : m[2]), text: m[1], line: lineOf(i)
                });
                i += line.length;
                continue;
            }
        }
        if (c === '\\') { i += 2; continue; }
        if (c === '`') {
            let n = 0;
            while (text[i + n] === '`') n++;
            const run = '`'.repeat(n);
            let close = text.indexOf(run, i + n);
            while (close >= 0 && text[close + n] === '`') {
                let k = close; while (text[k] === '`') k++;
                close = text.indexOf(run, k);
            }
            i = close >= 0 ? close + n : i + n;
            continue;
        }
        const image = c === '!' && text[i + 1] === '[';
        if (image || c === '[') {
            const open = image ? i + 1 : i;
            const close = closeBracket(text, open);
            const tail = close > 0 && text[close] === '(' ? inlineTail(text, close) : undefined;
            if (tail) {
                refs.push({
                    kind: image ? 'image' : 'link', start: i, end: tail.end, destStart: tail.destStart, destEnd: tail.destEnd,
                    destination: unescape(tail.raw), text: text.slice(open + 1, close - 1), line: lineOf(i)
                });
                // The text of a link can hold images: read it. An image ends at its `)`.
                i = image ? tail.end : open + 1;
                continue;
            }
            i = open + 1;
            continue;
        }
        i++;
    }
    return refs;
}

/** The scheme of an absolute URI (two letters or more: `C:` is a drive of a path), lower case. */
export function uriScheme(destination: string): string | undefined {
    return /^([A-Za-z][A-Za-z0-9+.-]+):/.exec(destination)?.[1].toLowerCase();
}

/** Schemes of ordinary images and links. An image with another scheme is a view embed. */
const DOCUMENT_SCHEMES = new Set(['http', 'https', 'data', 'file', 'mailto', 'ftp', 'ftps', 'tel', 'blob']);

/**
 * An image or a link definition is a view embed when its destination is the IRI of a view, or an absolute URI with a scheme that is not
 * a scheme of documents (http, https, data, file, …). A link is never an embed. An embed of the second kind without a view is an
 * unresolved reference. Limit: an http IRI that names no view is an ordinary image.
 */
export function isViewEmbed(ref: Pick<MarkdownRef, 'kind' | 'destination'>, viewIris: { has(iri: string): boolean }): boolean {
    if (ref.kind === 'link') return false;
    if (viewIris.has(ref.destination)) return true;
    const scheme = uriScheme(ref.destination);
    return !!scheme && !DOCUMENT_SCHEMES.has(scheme);
}

/** A destination that is a relative path: the path (percent-decoded, `/` as separator) and its query or fragment. */
export type LocalDestination = { path: string; suffix: string } | 'absolute';

/** The local file of a destination; 'absolute': an absolute path; undefined: a URI, a fragment of the same document, or empty. */
export function localDestination(destination: string): LocalDestination | undefined {
    if (!destination || destination.startsWith('#') || destination.startsWith('//') || uriScheme(destination)) return undefined;
    if (/^([/\\]|[A-Za-z]:)/.test(destination)) return 'absolute';
    const cut = destination.search(/[?#]/);
    const raw = cut < 0 ? destination : destination.slice(0, cut);
    let path = raw;
    try { path = decodeURIComponent(raw); } catch { /* not percent-encoded: as written */ }
    return { path: path.replace(/\\/g, '/'), suffix: cut < 0 ? '' : destination.slice(cut) };
}

/** A destination in Markdown: angle brackets when it is empty or has spaces, parentheses or angle brackets. */
export function markdownDestination(destination: string): string {
    return destination === '' || /[\s()<>\\]/.test(destination) ? `<${destination.replace(/[<>\\]/g, '\\$&')}>` : destination;
}

/** The alternative text of an image: brackets and backslashes escaped, line breaks as spaces. */
const altText = (label: string) => label.replace(/\s*\n\s*/g, ' ').replace(/[\\[\]]/g, '\\$&');

/** The embed of a view that Insert View writes: a Markdown image with the view IRI as destination and the label as text. */
export function viewEmbed(label: string, viewIri: string): string {
    return `![${altText(label)}](${markdownDestination(viewIri)})`;
}

/** A part of a file name: letters and digits, `-` between words, at most 40 characters. */
function slug(text: string): string {
    return text.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40).replace(/-+$/, '');
}

/**
 * The file name of the SVG of a view in _resources/: the last name of the IRI and a hash of the whole IRI. The name does not change with
 * the label. Two IRIs give two names.
 */
export function viewSvgName(viewIri: string): string {
    const tail = viewIri.replace(/[/#:?]+$/, '').split(/[/#:?]/).pop() ?? '';
    let name = tail;
    try { name = decodeURIComponent(tail); } catch { /* as written */ }
    return `${slug(name) || 'view'}-${sha256Hex(viewIri).slice(0, 12)}.svg`;
}

/** The file name in _resources/ of the copy of a file outside the source folder: its name and a hash of its path. */
export function resourceName(sourcePath: string): string {
    const base = sourcePath.split(/[\\/]/).pop() ?? '';
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, '') : '';
    return `${slug(dot > 0 ? base.slice(0, dot) : base) || 'file'}-${sha256Hex(sourcePath).slice(0, 12)}${ext}`;
}

const encodeSegment = (s: string) => encodeURIComponent(s).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%40/g, '@').replace(/%2B/g, '+').replace(/%2C/g, ',').replace(/%3D/g, '=');

/** A relative link (percent-encoded) from the document at `from` to the file at `to`. Both paths are relative to one folder, with `/`. */
export function relativeLink(from: string, to: string): string {
    const dir = from.split('/').slice(0, -1), target = to.split('/');
    let i = 0;
    while (i < dir.length && i < target.length - 1 && dir[i] === target[i]) i++;
    return [...dir.slice(i).map(() => '..'), ...target.slice(i).map(encodeSegment)].join('/');
}

/** The text with each range replaced. Ranges do not overlap. The text outside the ranges does not change. */
export function replaceRanges(text: string, edits: { start: number; end: number; text: string }[]): string {
    let out = '', at = 0;
    for (const e of [...edits].sort((a, b) => a.start - b.start)) {
        out += text.slice(at, e.start) + e.text;
        at = e.end;
    }
    return out + text.slice(at);
}

/** What a local destination of a source document names. The file access (modeler/src/node/markdown-export.ts) decides it. */
export type LinkTarget =
    /** A Markdown document in the source folder: the export writes it at the same relative path. */
    | { kind: 'document' }
    /** A file. `path`: its path relative to the source folder; undefined when it is outside the source folder. `from`: its absolute path. */
    | { kind: 'file'; from: string; path?: string }
    | { kind: 'missing' }
    | { kind: 'unsupported'; reason: string };

export interface MarkdownDocument {
    /** Path relative to the source folder, with `/`. */
    path: string;
    text: string;
}

/** A view of the model, by IRI: its element id (to open its editor) and its label. */
export interface ExportView {
    id: string;
    label: string;
}

export interface ExportProblem {
    file: string;
    line: number;
    target: string;
    message: string;
}

export interface UnresolvedEmbed {
    file: string;
    line: number;
    iri: string;
}

/** The output of an export, relative to the destination folder. Unresolved embeds stop the export: nothing is written. */
export interface MarkdownExportPlan {
    documents: MarkdownDocument[];
    /** Each view once, in the order of its first embed. `path`: its SVG file. */
    views: (ExportView & { iri: string; path: string })[];
    /** Files to copy: absolute source path and destination path. */
    copies: { from: string; path: string }[];
    unresolved: UnresolvedEmbed[];
    /** Links that the export leaves as they are and reports: missing targets, absolute paths, folders, documents outside the source folder. */
    problems: ExportProblem[];
}

/**
 * The export of the documents of a source folder. Each embed becomes an image link to the SVG of its view; each view has one SVG for all
 * its embeds. A file in the source folder keeps its relative path; a file outside it gets a copy in _resources/ and the link changes to
 * the copy. Links to documents of the source folder do not change. `target` names the target of a local destination of a document.
 */
export function planMarkdownExport(
    documents: MarkdownDocument[], views: ReadonlyMap<string, ExportView>, target: (document: string, destination: string) => LinkTarget
): MarkdownExportPlan {
    const plan: MarkdownExportPlan = { documents: [], views: [], copies: [], unresolved: [], problems: [] };
    const viewPaths = new Map<string, string>();
    const copies = new Map<string, string>();
    const copy = (from: string, path: string) => {
        if (!copies.has(path)) { copies.set(path, from); plan.copies.push({ from, path }); }
    };
    for (const doc of documents) {
        const edits: { start: number; end: number; text: string }[] = [];
        for (const ref of markdownRefs(doc.text)) {
            const problem = (message: string) => plan.problems.push({ file: doc.path, line: ref.line, target: ref.destination, message });
            if (isViewEmbed(ref, views)) {
                const view = views.get(ref.destination);
                if (!view) { plan.unresolved.push({ file: doc.path, line: ref.line, iri: ref.destination }); continue; }
                let path = viewPaths.get(ref.destination);
                if (!path) {
                    path = `${EXPORT_RESOURCES}/${viewSvgName(ref.destination)}`;
                    viewPaths.set(ref.destination, path);
                    plan.views.push({ ...view, iri: ref.destination, path });
                }
                const link = markdownDestination(relativeLink(doc.path, path));
                edits.push(ref.kind === 'image'
                    ? { start: ref.start, end: ref.end, text: `![${ref.text.trim() ? ref.text : altText(view.label)}](${link})` }
                    : { start: ref.destStart, end: ref.destEnd, text: link });
                continue;
            }
            const local = localDestination(ref.destination);
            if (!local) continue;
            if (local === 'absolute') { problem('An absolute path is not exported. The link does not change.'); continue; }
            const t = target(doc.path, ref.destination);
            if (t.kind === 'missing') problem('The target does not exist. The link does not change.');
            else if (t.kind === 'unsupported') problem(`${t.reason} The link does not change.`);
            else if (t.kind === 'file' && t.path !== undefined) copy(t.from, t.path);
            else if (t.kind === 'file') {
                const path = `${EXPORT_RESOURCES}/${resourceName(t.from)}`;
                copy(t.from, path);
                edits.push({ start: ref.destStart, end: ref.destEnd, text: markdownDestination(relativeLink(doc.path, path) + local.suffix) });
            }
        }
        plan.documents.push({ path: doc.path, text: replaceRanges(doc.text, edits) });
    }
    return plan;
}
