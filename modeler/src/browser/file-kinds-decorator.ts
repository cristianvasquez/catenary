// ADR 0004: the file navigator is the main view. Each file of the open workspace gets a tail text of what it is, from the triples
// (snapshot.files): workspace (the manifest), view, default (the file for new subjects), shapes, concepts, instances.
// The tail shows one letter per kind (LETTERS); the tooltip shows the words.

import { Emitter, Event } from '@theia/core';
import { DepthFirstTreeIterator, Tree, TreeDecoration, TreeDecorator } from '@theia/core/lib/browser';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { FileStatNode } from '@theia/filesystem/lib/browser';
import { ModelFrontend } from './model-client';

export const LETTERS: Record<string, string> = {
    workspace: 'W', view: 'V', default: 'D', shapes: 'S', concepts: 'C', instances: 'I', 'not read': '!'
};

@injectable()
export class FileKindsDecorator implements TreeDecorator {
    readonly id = 'catenary-file-kinds';
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    protected readonly emitter = new Emitter<(tree: Tree) => Map<string, TreeDecoration.Data>>();
    get onDidChangeDecorations(): Event<(tree: Tree) => Map<string, TreeDecoration.Data>> { return this.emitter.event; }

    @postConstruct()
    protected init(): void {
        let last = '';
        this.model.onDidChange(() => {
            const key = JSON.stringify(this.kinds());
            if (key === last) return;
            last = key;
            this.emitter.fire(tree => this.collect(tree));
        });
    }

    decorations(tree: Tree): Map<string, TreeDecoration.Data> {
        return this.collect(tree);
    }

    /** File path → what it is, in display order. */
    kinds(): Record<string, string[]> {
        const { files } = this.model.snapshot;
        const out: Record<string, string[]> = {};
        const add = (path: string, kind: string) => (out[path] ??= []).push(kind);
        if (files.workspace) add(files.workspace.path, 'workspace');
        for (const v of files.views) add(v.path, 'view');
        for (const f of files.files) {
            if (f.path === files.defaultFile?.path) add(f.path, 'default');
            f.kinds.forEach(k => add(f.path, k));
            if (f.error) add(f.path, 'not read');
        }
        return out;
    }

    protected collect(tree: Tree): Map<string, TreeDecoration.Data> {
        const result = new Map<string, TreeDecoration.Data>();
        if (!tree.root) return result;
        const kinds = this.kinds();
        for (const node of new DepthFirstTreeIterator(tree.root)) {
            if (!FileStatNode.is(node)) continue;
            const k = kinds[node.fileStat.resource.path.fsPath()];
            if (!k?.length) continue;
            result.set(node.id, {
                tailDecorations: [{ data: k.map(x => LETTERS[x] ?? x).join(''), fontData: { color: 'var(--theia-descriptionForeground)' }, tooltip: `Catenary: ${k.join(', ')}` }]
            });
        }
        return result;
    }
}
