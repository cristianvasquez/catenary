// Markdown export, file side (spec/ui-manifest.hs §9): lists the documents of the source folder, decides what each local link names,
// checks the destination folder and writes the output. The plan (what to write) comes from @catenary/model planMarkdownExport; the
// SVG files come from the view editors of the frontend (modeler/src/browser/diagram/markdown-export.ts).
//
// Ownership: _resources/.catenary-export.json records each file that an export wrote, with a SHA-256 of its content. An export writes
// a file only when it does not exist, has the same content, or is a recorded file without later changes. Otherwise it stops before it
// writes anything. It removes a recorded file that it no longer writes only when the file did not change after the last export.

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
    EXPORT_RESOURCES, ExportView, LinkTarget, MarkdownDocument, MarkdownExportPlan, isMarkdownPath, localDestination, markdownRefs,
    planMarkdownExport
} from '@catenary/model';
import type { MarkdownExportCheck, MarkdownExportResult } from '../common/protocol';

/** The record of the files that the exports to a destination wrote (path relative to the destination → SHA-256 of the content). */
export const OWNERSHIP_FILE = `${EXPORT_RESOURCES}/.catenary-export.json`;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** The path of `p` relative to `folder`, with `/`; undefined when `p` is not in the folder (or is the folder). */
function inside(folder: string, p: string): string | undefined {
    const rel = path.relative(folder, p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : undefined;
}

/** A relative output path with `/`: no empty, `.` or `..` names, not the ownership record. */
const safePath = (rel: string) => rel !== OWNERSHIP_FILE && !/^[\\/]|^[A-Za-z]:/.test(rel) && !rel.split('/').some(s => s === '' || s === '.' || s === '..' || s.includes('\\'));

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

/** The real path of `p` when it exists; else the real path of its nearest existing folder, with the rest of `p`. */
async function realPathOf(p: string): Promise<string> {
    const rest: string[] = [];
    for (let at = path.resolve(p); ; at = path.dirname(at)) {
        try {
            return path.join(await fs.realpath(at), ...rest.reverse());
        } catch (e) {
            if (code(e) !== 'ENOENT' && code(e) !== 'ENOTDIR') throw e;
            if (path.dirname(at) === at) return path.resolve(p);
            rest.push(path.basename(at));
        }
    }
}

/** The Markdown documents of a folder and its subfolders, with paths relative to it. No hidden folders, no linked folders. */
async function listDocuments(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
        const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full);
            else if (isMarkdownPath(e.name) && (e.isFile() || (e.isSymbolicLink() && inside(root, await fs.realpath(full).catch(() => root)) !== undefined))) {
                out.push(inside(root, full)!);
            }
        }
    };
    await walk(root);
    return out;
}

/** A source folder and a destination folder, checked; the plan of the export. */
export interface PreparedExport {
    source: string;
    destination: string;
    plan: MarkdownExportPlan;
}

/**
 * Read the documents of `source` and plan their export to `destination`. Fails when the source is not a folder, or the destination is
 * the source folder, is inside it, or is not a folder. Paths are absolute.
 */
export async function prepareMarkdownExport(source: string, destination: string, views: ReadonlyMap<string, ExportView>): Promise<PreparedExport | { error: string }> {
    let root: string;
    try {
        root = await fs.realpath(source);
        if (!(await fs.stat(root)).isDirectory()) return { error: `The source is not a folder: ${source}` };
    } catch {
        return { error: `The source folder does not exist: ${source}` };
    }
    const dest = await realPathOf(destination);
    if (dest === root || inside(root, dest) !== undefined) return { error: 'The destination folder is in the source folder. Choose a folder outside it.' };
    const stat = await fs.stat(dest).catch(() => undefined);
    if (stat && !stat.isDirectory()) return { error: `The destination is not a folder: ${destination}` };

    const paths = await listDocuments(root);
    const listed = new Set(paths);
    const documents: MarkdownDocument[] = await Promise.all(paths.map(async p => ({ path: p, text: await fs.readFile(path.join(root, ...p.split('/')), 'utf8') })));
    // What each local destination names: read before the plan, which is synchronous.
    const targets = new Map<string, LinkTarget>();
    const key = (doc: string, dest: string) => `${doc}\n${dest}`;
    for (const doc of documents) {
        for (const ref of markdownRefs(doc.text)) {
            const local = localDestination(ref.destination);
            if (!local || local === 'absolute' || targets.has(key(doc.path, ref.destination))) continue;
            targets.set(key(doc.path, ref.destination), await linkTarget(root, path.join(root, ...doc.path.split('/').slice(0, -1), ...local.path.split('/')), listed));
        }
    }
    const plan = planMarkdownExport(documents, views, (doc, dest) => targets.get(key(doc, dest)) ?? { kind: 'missing' });
    return { source: root, destination: dest, plan };
}

async function linkTarget(root: string, target: string, documents: ReadonlySet<string>): Promise<LinkTarget> {
    let real: string;
    try {
        real = await fs.realpath(target);
    } catch {
        return { kind: 'missing' };
    }
    const stat = await fs.stat(real);
    if (stat.isDirectory()) return { kind: 'unsupported', reason: 'The target is a folder.' };
    if (!stat.isFile()) return { kind: 'unsupported', reason: 'The target is not a file.' };
    // A path in the folder that a link takes out of it counts as outside.
    const rel = inside(root, target) !== undefined && inside(root, real) !== undefined ? inside(root, target) : undefined;
    if (isMarkdownPath(real)) {
        if (rel !== undefined && documents.has(rel)) return { kind: 'document' };
        return { kind: 'unsupported', reason: rel === undefined ? 'The document is outside the source folder.' : 'The document is in a hidden folder.' };
    }
    return rel === undefined ? { kind: 'file', from: real } : { kind: 'file', from: real, path: rel };
}

/** The result of a check, for the frontend: the views to render, the unresolved embeds, the reported links. */
export function checkOf(prepared: PreparedExport | { error: string }): MarkdownExportCheck {
    if ('error' in prepared) return { ok: false, error: prepared.error, documents: 0, views: [], unresolved: [], problems: [] };
    const { plan } = prepared;
    return {
        ok: !plan.unresolved.length, ...(plan.unresolved.length ? { error: unresolvedMessage(plan) } : {}), destination: prepared.destination,
        documents: plan.documents.length, views: plan.views.map(v => ({ iri: v.iri, id: v.id, label: v.label })), unresolved: plan.unresolved,
        problems: plan.problems
    };
}

function unresolvedMessage(plan: MarkdownExportPlan): string {
    const n = plan.unresolved.length;
    return `${n} view reference${n === 1 ? '' : 's'} name${n === 1 ? 's' : ''} no view. Nothing was exported.`;
}

async function readOwnership(dest: string): Promise<Record<string, string>> {
    try {
        const files = JSON.parse(await fs.readFile(path.join(dest, ...OWNERSHIP_FILE.split('/')), 'utf8'))?.files;
        return files && typeof files === 'object' ? Object.fromEntries(Object.entries(files).filter(([, h]) => typeof h === 'string')) as Record<string, string> : {};
    } catch {
        return {};
    }
}

/** Write a file through a temporary file in its folder and a rename. */
async function writeAtomic(file: string, data: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
    try {
        await fs.writeFile(tmp, data);
        await fs.rename(tmp, file);
    } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
    }
}

/**
 * Write the planned export with the SVG of each view (`svgs`: view IRI → SVG text). Stops before the first write when an embed names
 * no view, an SVG or a copied file is missing, or a destination file belongs to someone else. A write failure stops the export: the
 * result names the files written before it.
 */
export async function writeMarkdownExport(prepared: PreparedExport, svgs: Record<string, string>): Promise<MarkdownExportResult> {
    const { plan, destination: dest } = prepared;
    const result: MarkdownExportResult = { ok: false, written: [], unchanged: [], removed: [], kept: [], conflicts: [], problems: plan.problems };
    if (plan.unresolved.length) return { ...result, error: unresolvedMessage(plan), unresolved: plan.unresolved };

    // All output in memory before the first write.
    const output = new Map<string, Buffer>();
    for (const d of plan.documents) output.set(d.path, Buffer.from(d.text, 'utf8'));
    for (const v of plan.views) {
        const svg = svgs[v.iri];
        if (typeof svg !== 'string' || !svg.includes('<svg')) return { ...result, error: `No SVG of the view "${v.label}" (${v.iri}). Nothing was exported.` };
        output.set(v.path, Buffer.from(svg, 'utf8'));
    }
    for (const c of plan.copies) {
        try {
            output.set(c.path, await fs.readFile(c.from));
        } catch (e) {
            return { ...result, error: `Cannot read ${c.from}: ${(e as Error).message}. Nothing was exported.` };
        }
    }

    const owned = await readOwnership(dest);
    const pending: [string, Buffer][] = [];
    const conflict = (rel: string, why: string) => result.conflicts.push(`${rel}: ${why}`);
    for (const [rel, data] of output) {
        const file = path.join(dest, ...rel.split('/'));
        if (!safePath(rel)) { conflict(rel, 'the path is not allowed.'); continue; }
        // A linked folder on the path must not lead out of the destination.
        const folder = await realPathOf(path.dirname(file));
        if (folder !== dest && inside(dest, folder) === undefined) {
            conflict(rel, 'a folder on the path leads out of the destination folder.');
            continue;
        }
        const stat = await fs.lstat(file).catch(() => undefined);
        if (!stat) { pending.push([rel, data]); continue; }
        if (!stat.isFile()) { conflict(rel, stat.isSymbolicLink() ? 'a link exists at this path.' : 'a folder exists at this path.'); continue; }
        const now = sha256(await fs.readFile(file));
        if (now === sha256(data)) result.unchanged.push(rel);
        else if (owned[rel] === now) pending.push([rel, data]);
        else conflict(rel, owned[rel] ? 'the file changed after the last export.' : 'the file exists and an export did not write it.');
    }
    if (result.conflicts.length) {
        return { ...result, error: `${result.conflicts.length} destination file${result.conflicts.length === 1 ? '' : 's'} would be overwritten. Nothing was exported.` };
    }

    // Recorded files that this export does not write: removed when unchanged, else kept and no longer recorded.
    const stale: string[] = [];
    for (const [rel, hash] of Object.entries(owned)) {
        if (output.has(rel) || !safePath(rel)) continue;
        const file = path.join(dest, ...rel.split('/'));
        const stat = await fs.lstat(file).catch(() => undefined);
        const folder = await realPathOf(path.dirname(file));
        if (!stat || (folder !== dest && inside(dest, folder) === undefined)) continue;
        if (stat.isFile() && sha256(await fs.readFile(file)) === hash) stale.push(rel);
        else result.kept.push(rel);
    }

    const record: Record<string, string> = Object.fromEntries(Object.entries(owned).filter(([rel]) => output.has(rel) || stale.includes(rel)));
    for (const rel of result.unchanged) record[rel] = sha256(output.get(rel)!);
    const save = () => writeAtomic(path.join(dest, ...OWNERSHIP_FILE.split('/')), Buffer.from(JSON.stringify({ generator: 'Catenary', files: sortKeys(record) }, null, 2) + '\n'));
    try {
        for (const [rel, data] of pending) {
            try {
                await writeAtomic(path.join(dest, ...rel.split('/')), data);
            } catch (e) {
                result.failed = { path: rel, error: (e as Error).message };
                throw e;
            }
            result.written.push(rel);
            record[rel] = sha256(data);
        }
        for (const rel of stale) {
            await fs.rm(path.join(dest, ...rel.split('/')), { force: true });
            result.removed.push(rel);
            delete record[rel];
        }
        await save();
    } catch (e) {
        await save().catch(() => undefined);
        const done = result.written.length;
        return { ...result, error: `The export stopped at ${result.failed?.path ?? OWNERSHIP_FILE}: ${(e as Error).message}. ${done} file${done === 1 ? ' was' : 's were'} written before it.` };
    }
    return { ...result, ok: true };
}

function sortKeys(r: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
