// Import orchestration (§2.6): read first, merge prefixes, mark files, write copies, reopen once. Ports keep sync modules independent.

import { CommandResult, ImportResult, PREFIXES, prefixesProblem, setPrefixes } from '@catenary/model';
import type { Quad } from '@rdfjs/types';
import { portableRelative } from 'rdf-files';
import { declaredPrefixes } from './files';
import { Saved, Settings } from './settings';

interface ImportRead { name: string; text: string; quads?: Quad[]; source: string; inPlace?: string }

export interface ImportPort {
    settings(): Settings | undefined;
    readSources(sources: string[], knownFile: (file: string) => string | undefined): Promise<{ reads: ImportRead[] } | { error: string }>;
    copies(folder: string, reads: ImportRead[]): { targets: Map<ImportRead, string>; write(): Promise<void>; undo(): Promise<void> };
    dirty(): boolean;
    savedState(): Saved;
    commitNote(note: string): void;
    write(): Promise<CommandResult>;
    written(files: string[]): void;
    reopen(file: string): Promise<CommandResult>;
    prefixesChanged(): void;
    note(text: string): void;
    changed(): void;
}

/** Runs inside the coordinator's file queue. Warning and event order stays with the import. */
export async function importFiles(sources: string[], port: ImportPort): Promise<ImportResult> {
    const ws = port.settings();
    if (!ws) return { ok: false, error: 'No workspace is open.' };
    if (!sources.length) return { ok: false, error: 'No file to import.' };
    // Read all files first: a file that cannot be read imports nothing.
    const sourcesRead = await port.readSources(sources, file => ws.knownFile(file));
    if ('error' in sourcesRead) return { ok: false, error: sourcesRead.error };
    const { reads } = sourcesRead;
    const table = { ...PREFIXES }, added: string[] = [], skipped = new Set<string>();
    for (const r of reads) {
        for (const [prefix, ns] of Object.entries(declaredPrefixes(r.text, r.source))) {
            if (table[prefix] === ns) continue;
            if (!prefix || table[prefix] !== undefined || Object.values(table).includes(ns)) { skipped.add(prefix); continue; }
            table[prefix] = ns;
            added.push(prefix);
        }
    }
    const names = reads.map(r => r.name).join(', ');
    if (added.length && prefixesProblem(table)) return { ok: false, error: `${names}: not imported: ${prefixesProblem(table)}` };
    const before = { prefixes: ws.prefixes, table: { ...PREFIXES }, imported: ws.importedGlobs };
    // Files of the workspace: marked where they are. The write gives their blank nodes IRIs first (as Mark as Imported).
    const own = reads.filter(r => r.inPlace && !ws.isImported(r.inPlace)).map(r => portableRelative(ws.folder, r.inPlace!));
    if (own.length) {
        if (port.dirty()) {
            port.commitNote('before import mark');
            await port.write();
        }
        const marked = ws.applySettings({ imported: [...before.imported, ...own] }, port.savedState());
        if ('error' in marked) return { ok: false, error: `${names}: not imported: ${marked.error}` };
    }
    const note = () => {
        if (skipped.size) port.note(`${names}: prefixes not added (the workspace has the name or the namespace with another value): ${[...skipped].map(p => `${p}:`).join(' ')}`);
    };
    if (added.length) { ws.prefixes = table; setPrefixes(table); }
    const copies = reads.filter(r => !r.inPlace);
    if (!copies.length) {
        // No new file: the store keeps its statements; the prefixes change the read models (as setPrefixes).
        if (added.length) { port.prefixesChanged(); }
        ws.syncShapesTarget();
        port.commitNote(`import ${names}`);
        port.changed();
        note();
        return { ok: true, files: reads.map(r => r.inPlace!), prefixes: added };
    }
    const imported = port.copies(ws.folder, copies);
    const { targets } = imported;
    const undo = async (error: string): Promise<ImportResult> => {
        await imported.undo();
        ws.prefixes = before.prefixes;
        setPrefixes(before.table);
        ws.applySettings({ imported: before.imported }, port.savedState());
        return { ok: false, error: `${names}: not imported: ${error}` };
    };
    try {
        await imported.write();
    } catch (e) {
        return undo((e as Error).message);
    }
    ws.applySettings({ imported: [...ws.importedGlobs, ...[...targets.values()].map(t => portableRelative(ws.folder, t))] }, port.savedState());
    port.written([...targets.values()]);
    port.commitNote(`import ${names}`);
    const w = await port.write();
    if (!w.ok) return undo(w.error);
    const opened = await port.reopen(ws.path);
    if (!opened.ok) return opened;
    note();
    return { ok: true, files: reads.map(r => r.inPlace ?? targets.get(r)!), prefixes: added };
}
