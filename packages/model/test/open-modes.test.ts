import { expect, it } from 'vitest';
import { mixedFileProblem, previewInWorkspace } from '../src';

// law_mixedFileOpensAsText
it('a file with workspace settings and a view opens as text, with a message', () => {
    const mixed = { workspace: true, views: [{ id: 'v', label: 'V' }] };
    expect(mixedFileProblem(mixed)).toBe('This file mixes workspace settings and a view. Move the view into its own file.');
    expect(previewInWorkspace(mixed, '/ws/workspace.trig', '/ws/workspace.trig')).toBe(false);
    expect(mixedFileProblem({ workspace: true, views: [] })).toBeUndefined();
});

// law_previewStaysInWorkspace
it('a selected file previews only within the current workspace; switching needs an explicit open', () => {
    const view = { workspace: false, views: [{ id: 'v', label: 'V' }], workspaceFile: '/ws/workspace.trig' };
    expect(previewInWorkspace(view, '/ws/views/v.trig', '/ws/workspace.trig')).toBe(true);
    expect(previewInWorkspace(view, '/ws/views/v.trig', '/other/workspace.trig')).toBe(false);
    expect(previewInWorkspace({ ...view, workspaceFile: undefined }, '/lone/v.trig', '/ws/workspace.trig')).toBe(false);
    const ws = { workspace: true, views: [] };
    expect(previewInWorkspace(ws, '/ws/workspace.trig', '/ws/workspace.trig')).toBe(true);
    expect(previewInWorkspace(ws, '/other/workspace.trig', '/ws/workspace.trig')).toBe(false);
    expect(previewInWorkspace(ws, '/ws/workspace.trig', undefined)).toBe(false);
});

it('plain and unreadable files do not preview as a canvas or Settings', () => {
    expect(previewInWorkspace({ workspace: false, views: [] }, '/ws/data.ttl', '/ws/workspace.trig')).toBe(false);
    expect(previewInWorkspace({ workspace: true, views: [], error: 'unreadable' }, '/ws/workspace.trig', '/ws/workspace.trig')).toBe(false);
});
