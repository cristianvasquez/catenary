// Confirmation dialog of the Markdown export (spec/ui-manifest.hs §9.2): the destination, the documents of the check as a tree with a
// checkbox per row, the counts and the problems. The answer: the destination and the documents to leave out (paths relative to the root).

import { DialogError } from '@theia/core/lib/browser';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import React from '@theia/core/shared/react';
import type { MarkdownExportCheck } from '../../common/protocol';

/** At most this number of problem lines; the rest is a count. */
const LISTED = 5;

/** A folder of the tree: its path relative to the root ('' for the root), its subfolders and its documents. */
export interface ExportFolder { path: string; name: string; folders: ExportFolder[]; documents: string[] }

/** The documents (paths relative to the root, with `/`) grouped by their folders. Folders and documents in the order of the list. */
export function exportTree(documents: string[]): ExportFolder {
    const root: ExportFolder = { path: '', name: '', folders: [], documents: [] };
    for (const doc of documents) {
        const parts = doc.split('/');
        let at = root;
        for (const name of parts.slice(0, -1)) {
            const path = at.path ? `${at.path}/${name}` : name;
            let next = at.folders.find(f => f.path === path);
            if (!next) at.folders.push(next = { path, name, folders: [], documents: [] });
            at = next;
        }
        at.documents.push(doc);
    }
    return root;
}

/** All documents of a folder and its subfolders. */
const documentsOf = (folder: ExportFolder): string[] => [...folder.documents, ...folder.folders.flatMap(documentsOf)];
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const baseOf = (doc: string) => doc.slice(doc.lastIndexOf('/') + 1);

export class MarkdownExportDialog extends ReactDialog<{ destination: string; exclude: string[] }> {
    protected destination: string | undefined;
    protected readonly excluded = new Set<string>();
    protected readonly tree: ExportFolder;

    /** `destination`: the remembered destination of the root. `choose`: the folder dialog; it returns the picked path. */
    constructor(protected readonly check: MarkdownExportCheck, destination: string | undefined,
        protected readonly choose: (current: string | undefined) => Promise<string | undefined>) {
        super({ title: 'Export Markdown' });
        this.destination = destination;
        this.tree = exportTree(check.documents);
        this.contentNode.classList.add('catenary-export-dialog');
        this.appendCloseButton('Cancel');
        this.appendAcceptButton('Export');
    }

    get value(): { destination: string; exclude: string[] } {
        return { destination: this.destination ?? '', exclude: this.check.documents.filter(d => this.excluded.has(d)) };
    }

    protected override isValid(value: { destination: string; exclude: string[] }): DialogError {
        if (!value.destination) return 'Choose a destination folder.';
        if (value.exclude.length === this.check.documents.length) return 'Select one or more documents.';
        return '';
    }

    protected toggle(documents: string[], on: boolean): void {
        for (const d of documents) {
            if (on) this.excluded.delete(d);
            else this.excluded.add(d);
        }
        this.update();
    }

    protected async pick(): Promise<void> {
        const picked = await this.choose(this.destination);
        if (!picked) return;
        this.destination = picked;
        this.update();
    }

    protected render(): React.ReactNode {
        const checked = this.check.documents.length - this.excluded.size;
        const notes = [...this.check.unresolved.map(u => `${u.file}:${u.line}: ${u.iri}`),
            ...this.check.problems.map(p => `${p.file}:${p.line}: ${p.target}: ${p.message}`)];
        return <div className='catenary-export-body'>
            <div className='catenary-export-destination'>
                <span className='catenary-export-heading'>Destination</span>
                <span className={`catenary-export-path${this.destination ? '' : ' none'}`}>{this.destination ?? 'No folder selected'}</span>
                <button className='theia-button secondary' onClick={e => { e.preventDefault(); void this.pick(); }}>Choose…</button>
            </div>
            <ul className='catenary-export-tree'>{this.renderFolder(this.tree)}</ul>
            <div className='catenary-export-summary'>{count(checked, 'document')}, {count(this.check.views.length, 'view')}</div>
            {notes.length ? <ul className='catenary-export-notes'>
                {notes.slice(0, LISTED).map((n, i) => <li key={i}><span className='codicon codicon-warning' /> {n}</li>)}
                {notes.length > LISTED ? <li>and {notes.length - LISTED} more</li> : undefined}
            </ul> : undefined}
        </div>;
    }

    /** The rows of a folder: its subfolders, then its documents. */
    protected renderFolder(folder: ExportFolder): React.ReactNode[] {
        return [
            ...folder.folders.map(f => {
                const docs = documentsOf(f);
                const off = docs.filter(d => this.excluded.has(d)).length;
                return <li key={`folder:${f.path}`}>
                    {this.row('folder', f.name, off === 0, off > 0 && off < docs.length, on => this.toggle(docs, on))}
                    <ul>{this.renderFolder(f)}</ul>
                </li>;
            }),
            ...folder.documents.map(d => <li key={`doc:${d}`}>
                {this.row('file', baseOf(d), !this.excluded.has(d), false, on => this.toggle([d], on))}
            </li>)
        ];
    }

    protected row(icon: 'folder' | 'file', label: string, checked: boolean, indeterminate: boolean, onChange: (on: boolean) => void): React.ReactNode {
        return <label className='catenary-export-row'>
            <input type='checkbox' checked={checked} ref={el => { if (el) el.indeterminate = indeterminate; }} onChange={e => onChange(e.target.checked)} />
            <span className={`codicon codicon-${icon}`} />
            <span className='catenary-export-label'>{label}</span>
        </label>;
    }
}
