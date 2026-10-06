import { describe, expect, it } from 'vitest';
import type { MigrationChange } from '@catenary/model';
import type { Patch } from '../src/graph';
import { History } from '../src/history';
import { rdf } from '../src/terms';

const patch = (n: string): Patch => [{ op: 'add', quad: rdf.quad(rdf.namedNode('urn:s'), rdf.namedNode('urn:p'), rdf.literal(n)) }];
const proposal = (from: string): { change: MigrationChange; reason: string } => ({ change: { kind: 'renameClass', from, to: from + '2' }, reason: 'test' });

describe('History', () => {
    it('undo and redo move one step and restore the patch queue of that step', () => {
        const h = new History();
        h.record(patch('1'), undefined, [proposal('A')]);
        h.record(patch('2'), undefined, []);
        expect(h.migrations.map(m => m.id)).toEqual(['m1']);
        expect(h.take('undo')?.patch).toEqual(patch('2'));
        expect(h.take('undo')?.patch).toEqual(patch('1'));
        expect(h.migrations).toEqual([]);
        expect(h.take('undo')).toBeUndefined();
        expect(h.take('redo')?.patch).toEqual(patch('1'));
        expect(h.migrations.map(m => m.id)).toEqual(['m1']);
        expect([h.canUndo, h.canRedo]).toEqual([true, true]);
    });

    it('a new step clears redo; an applied entry leaves the queue; a command without a patch is not a step', () => {
        const h = new History();
        h.record(patch('1'), undefined, [proposal('A'), proposal('B')]);
        h.take('undo');
        h.take('redo');
        h.record(patch('2'), 'm1', []);
        expect(h.canRedo).toBe(false);
        expect(h.migrations.map(m => m.id)).toEqual(['m2']);
        h.record([], undefined, [proposal('C')]);
        expect(h.migrations.map(m => m.id)).toEqual(['m2']);
        h.take('undo');
        expect(h.migrations.map(m => m.id)).toEqual(['m1', 'm2']);
    });

    it('keeps the last 200 steps; dismiss and clear', () => {
        const h = new History();
        for (let i = 0; i < 205; i++) h.record(patch(String(i)), undefined, i === 204 ? [proposal('A')] : []);
        let n = 0;
        while (h.take('undo')) n++;
        expect(n).toBe(200);
        h.take('redo');
        h.record(patch('x'), undefined, [proposal('B')]);
        expect(h.dismiss('nope')).toBe(false);
        expect(h.dismiss(h.migrations[0].id)).toBe(true);
        h.clear();
        expect([h.canUndo, h.canRedo, h.migrations]).toEqual([false, false, []]);
    });
});
