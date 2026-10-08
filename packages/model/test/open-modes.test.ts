import { expect, it } from 'vitest';
import { openModes } from '../src';

// law_plainFileOpensAsText
it('openModes: a file opens as its workspace and as each of its views; a plain file has none', () => {
    expect(openModes({ workspace: false, views: [] })).toEqual([]);
    expect(openModes({ workspace: true, views: [] })).toEqual([{ kind: 'workspace' }]);
    expect(openModes({ workspace: true, views: [{ id: 'v', label: 'V' }] })).toEqual([{ kind: 'workspace' }, { kind: 'view', id: 'v', label: 'V' }]);
});
