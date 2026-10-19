// viewLines: a view of the demo workspace as text lines (spec/manifest.hs §11.1 law_compactLinesCoverBoxes).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { iriId } from '@catenary/model';
import { DATA, SHAPES, openStore, tempWorkspace, writeWorkspace } from './helpers';

const QUERY = 'urn:name:Query%20service', DATASET = 'urn:name:Product%20events%20dataset';

describe('viewLines on the demo workspace', () => {
    it('gives a card line per placed instance, the edge between them and a note; undefined for no view', async () => {
        const { dir } = tempWorkspace({}, 'catenary-compact-');
        writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
        writeFileSync(join(dir, 'data.ttl'), DATA);
        writeWorkspace(dir);
        const store = await openStore(join(dir, 'workspace.trig'));
        const created = store.execute({ kind: 'createView', label: 'Compact check' });
        if (!created.ok || !created.id) throw new Error('no view');
        const view = created.id;
        expect(store.execute({ kind: 'addToView', view, ids: [iriId(DATASET), iriId(QUERY)], at: { x: 0, y: 0 } }).ok).toBe(true);
        expect(store.execute({ kind: 'createNote', view, text: 'a\nb', at: { x: 0, y: 500 } }).ok).toBe(true);

        const lines = store.reads.viewLines(view)!;
        const stored = store.reads.view(view)!;
        expect(lines[0]).toMatch(/^view "Compact check" \S+$/);
        expect(lines.length - 1).toBe(stored.boxes.length + stored.edges.length + stored.arrows.length);
        expect(lines).toContainEqual(expect.stringMatching(/^card "Product events dataset" dcat:Dataset urn:name:Product%20events%20dataset -?\d+ -?\d+ \d+ \d+$/));
        expect(lines).toContainEqual(expect.stringMatching(/^card "Query service" dcat:DataService urn:name:Query%20service /));
        expect(lines).toContainEqual(expect.stringMatching(/^note -?\d+ -?\d+: a\\nb$/));
        expect(lines.filter(l => l.startsWith('edge '))).toContain('edge "Product events dataset" <osg://vocab/data-product-draft#exposedThrough> "Query service"');
        expect(store.reads.viewLines(iriId(QUERY))).toBeUndefined();
    });
});
