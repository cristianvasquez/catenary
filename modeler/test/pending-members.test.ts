import { describe, expect, it } from 'vitest';
import { MemberRow, PENDING_TIMEOUT, PendingMembersState, isPendingRow } from '../src/browser/diagram/pending-members-state';

// "+ concept" / "+ member" of a value set card: the new row shows before the server model has it, and only once after.

const root = (revision: number, members: MemberRow[]) => {
    const card = { members: [...members] };
    return { revision, card, index: { getById: (id: string) => (id === 'set' ? card : undefined) } };
};
const row = (label: string): MemberRow => ({ uri: 'urn:' + label, label, instance: '' });
const labels = (members: MemberRow[]) => members.map(m => `${m.label}${isPendingRow(m) ? ' (pending)' : ''}`);

describe('pending members', () => {
    it('a pending row until the server model has the label; then the server row only', () => {
        const s = new PendingMembersState();
        s.add('set', 'Red', 0);
        const local = root(1, [row('Blue')]);
        s.apply(local, 1);
        expect(labels(local.card.members)).toEqual(['Blue', 'Red (pending)']);
        // Applied again to the same model (another pending member): one pending row, not two.
        s.apply(local, 2);
        expect(labels(local.card.members)).toEqual(['Blue', 'Red (pending)']);
        const stale = root(2, [row('Blue')]);
        s.apply(stale, 3);
        expect(labels(stale.card.members)).toEqual(['Blue', 'Red (pending)']);
        const confirmed = root(3, [row('Blue'), row('Red')]);
        s.apply(confirmed, 4);
        expect(labels(confirmed.card.members)).toEqual(['Blue', 'Red']);
        expect(s.sent.size).toBe(0);
    });

    it('a removed pending member leaves the card; a member without confirmation leaves after the timeout', () => {
        const s = new PendingMembersState();
        s.add('set', 'Red', 0);
        const r = root(1, [row('Blue')]);
        s.apply(r, 1);
        s.remove('set', 'Red');
        s.apply(r, 2);
        expect(labels(r.card.members)).toEqual(['Blue']);
        s.add('set', 'Green', 0);
        const late = root(2, [row('Blue')]);
        s.apply(late, PENDING_TIMEOUT + 1);
        expect(labels(late.card.members)).toEqual(['Blue']);
        expect(s.sent.size).toBe(0);
    });
});
