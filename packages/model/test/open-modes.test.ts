import { expect, it } from 'vitest';
import { mixedFileProblem, openModes } from '../src';

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
