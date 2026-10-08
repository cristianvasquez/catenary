import { expect, it } from 'vitest';
import { mixedFileProblem, openModes, previewModes } from '../src';

// law_plainFileOpensAsText
it('openModes: a file opens as its workspace and as each of its views; a plain file has none', () => {
    expect(openModes({ workspace: false, views: [] })).toEqual([]);
    expect(openModes({ workspace: true, views: [] })).toEqual([{ kind: 'workspace' }]);
    expect(openModes({ workspace: false, views: [{ id: 'v', label: 'V' }] })).toEqual([{ kind: 'view', id: 'v', label: 'V' }]);
});

// law_mixedFileOpensAsText
it('a file with workspace settings and a view opens as text, with a message', () => {
    const mixed = { workspace: true, views: [{ id: 'v', label: 'V' }] };
    expect(openModes(mixed)).toEqual([]);
    expect(mixedFileProblem(mixed)).toBe('This file mixes workspace settings and a view. Move the view into its own file.');
    expect(mixedFileProblem({ workspace: true, views: [] })).toBeUndefined();
});

// law_previewStaysInWorkspace
it('previewModes: a selected file shows only what stays in the open workspace; switching needs an explicit open', () => {
    const view = { workspace: false, views: [{ id: 'v', label: 'V' }], workspaceFile: '/ws/workspace.trig' };
    expect(previewModes(view, '/ws/views/v.trig', '/ws/workspace.trig')).toEqual([{ kind: 'view', id: 'v', label: 'V' }]);
    expect(previewModes(view, '/ws/views/v.trig', '/other/workspace.trig')).toEqual([]);
    expect(previewModes({ ...view, workspaceFile: undefined }, '/lone/v.trig', '/ws/workspace.trig')).toEqual([]);
    const ws = { workspace: true, views: [] };
    expect(previewModes(ws, '/ws/workspace.trig', '/ws/workspace.trig')).toEqual([{ kind: 'workspace' }]);
    expect(previewModes(ws, '/other/workspace.trig', '/ws/workspace.trig')).toEqual([]);
    expect(previewModes(ws, '/ws/workspace.trig', undefined)).toEqual([]);
});
