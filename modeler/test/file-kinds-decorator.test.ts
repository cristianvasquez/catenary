import { expect, it, vi } from 'vitest';
import { FileKindsDecorator } from '../src/browser/file-kinds-decorator';
import { ModelFrontend } from '../src/browser/model-client';

// Browser-only modules supply DI tokens and the tree walk, not behavior under test.
vi.mock('@theia/core/lib/browser', () => ({
    DepthFirstTreeIterator: class {
        constructor(readonly root: any) {}
        *[Symbol.iterator]() { const walk = function* (n: any): any { yield n; for (const c of n.children ?? []) yield* walk(c); }; yield* walk(this.root); }
    }
}));
vi.mock('@theia/filesystem/lib/browser', () => ({ FileStatNode: { is: (n: any) => !!n.fileStat } }));
vi.mock('../src/browser/model-client', () => ({ ModelFrontend: class {} }));

const node = (id: string, path: string) => ({ id, fileStat: { resource: { path: { fsPath: () => path } } } });

function decorate() {
    const snapshot = { files: {
        workspace: undefined, defaultFile: undefined,
        views: [{ path: '/ws/v.trig', imported: true }],
        files: [{ path: '/ws/shapes.ttl', kinds: ['shapes'] }, { path: '/ws/lib.ttl', kinds: [], imported: true }]
    } };
    const decorator = Object.assign(new FileKindsDecorator(), { model: { snapshot } as unknown as ModelFrontend });
    const root = { id: 'root', children: [node('v', '/ws/v.trig'), node('s', '/ws/shapes.ttl'), node('l', '/ws/lib.ttl')] };
    return decorator.decorations({ root } as any);
}

// Theia renders tail decorations in reverse order, so the lock is first in the data and shows after the letters.
it('an imported view file gets the letter V and a lock', () => {
    expect(decorate().get('v')!.tailDecorations).toEqual([
        { icon: 'lock', tooltip: 'Catenary: locked (read-only)' },
        expect.objectContaining({ data: 'V', tooltip: 'Catenary: view, imported' })
    ]);
});

it('an own shapes file gets the letter S and no lock', () => {
    expect(decorate().get('s')!.tailDecorations).toEqual([expect.objectContaining({ data: 'S' })]);
});

it('a file that is only imported gets the lock and no letters', () => {
    expect(decorate().get('l')!.tailDecorations).toEqual([{ icon: 'lock', tooltip: 'Catenary: locked (read-only)' }]);
});
