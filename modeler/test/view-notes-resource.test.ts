import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '@theia/core';
import { EditCommand, ModelSnapshot } from '@catenary/model';
import { ModelFrontend } from '../src/browser/model-client';
import { notesTarget, notesUri, ViewNotesResource } from '../src/browser/notes/view-notes-resource';

function fixture() {
    let text = 'Original';
    const changed = new Emitter<ModelSnapshot>();
    const service = {
        properties: vi.fn(async () => ({ kind: 'view', description: text })),
        execute: vi.fn(async (command: EditCommand) => {
            if (command.kind !== 'setViewDescription') throw new Error('Unexpected command');
            if (command.expectedText !== text) return { ok: false, error: 'These notes changed elsewhere.' };
            text = command.text;
            return { ok: true };
        })
    };
    const model = Object.assign(new ModelFrontend(), { service, messages: { warn: vi.fn() }, onDidChange: changed.event });
    model.snapshot.file = '/workspace.trig';
    const resource = new ViewNotesResource(notesUri(model.snapshot.file, 'view'), model);
    return { model, service, resource, remote: (value: string) => { text = value; changed.fire(model.snapshot); }, text: () => text };
}

describe('view notes resources', () => {
    it('uses a workspace-scoped Markdown URI, including spaces and non-ASCII text', () => {
        const target = { file: '/models/a #1/é.trig', view: 'n-urn_3anotes % /' };
        const uri = notesUri(target.file, target.view);
        expect(notesTarget(uri)).toEqual(target);
        expect(uri.path.ext).toBe('.md');
    });

    it('law_notesGuarded: saves exact Markdown through one command and advances its version', async () => {
        const f = fixture();
        expect(await f.resource.readContents()).toBe('Original');
        const text = '# Notes\n\n- **Bold**\n\n```text\nUnicode: é\n```\n';
        await f.resource.saveContents(text, { version: f.resource.version });
        expect(f.service.execute).toHaveBeenCalledExactlyOnceWith({ kind: 'setViewDescription', view: 'view', text, expectedText: 'Original' });
        expect(f.resource.version).toEqual({ text });
        expect(f.text()).toBe(text);
        f.resource.dispose();
    });

    it('rejects a stale native document version even if a background read has seen the new notes', async () => {
        const f = fixture();
        await f.resource.readContents();
        const version = f.resource.version;
        f.remote('Other window');
        await f.resource.readContents();
        await expect(f.resource.saveContents('My text', { version })).rejects.toThrow('These notes changed elsewhere.');
        expect(f.text()).toBe('Other window');
        expect(f.resource.version).toEqual({ text: 'Other window' });
        f.resource.dispose();
    });

    it('cannot write into a different workspace with the same view ID', async () => {
        const f = fixture();
        await f.resource.readContents();
        f.model.snapshot.file = '/other/workspace.trig';
        await expect(f.resource.saveContents('My text')).rejects.toThrow('The workspace changed.');
        expect(f.service.execute).not.toHaveBeenCalled();
        f.resource.dispose();
    });

    it('notifies native editors of external edits, not unrelated changes, and stops after disposal', async () => {
        const f = fixture();
        await f.resource.readContents();
        const notified = vi.fn();
        f.resource.onDidChangeContents(notified);
        f.remote('Original');
        await Promise.resolve();
        await Promise.resolve();
        expect(notified).not.toHaveBeenCalled();
        f.remote('External edit');
        await vi.waitFor(() => expect(notified).toHaveBeenCalledTimes(1));
        expect(await f.resource.readContents()).toBe('External edit');
        f.resource.dispose();
        f.service.properties.mockClear();
        f.remote('After disposal');
        expect(f.service.properties).not.toHaveBeenCalled();
    });
});
