// The state of PendingMembers (pending-members.ts), without GLSP: the members that "+ concept" / "+ member" of a value set card sent
// and that the server model does not show yet. The card draws them at once; a server model that has the label confirms one.

/** A member row of a value set card (ValueSetNode.members). */
export type MemberRow = { uri: string; label: string; broader?: string[]; instance: string };

/** The part of a GLSP model root that the state reads and changes. */
export interface ModelRoot {
    revision?: number;
    index: { getById(id: string): object | undefined };
}

export const PENDING_TIMEOUT = 5000;
const PENDING = 'pending:';

/** The row of a pending member: no IRI yet (`pending:<label>#…`: its key, and "…" as its local name). */
export const pendingRow = (label: string): MemberRow => ({ uri: `${PENDING}${encodeURIComponent(label)}#…`, label, instance: '' });
export const isPendingRow = (m: MemberRow) => m.uri.startsWith(PENDING);

export class PendingMembersState {
    /** Value set card id -> the labels sent, and when. */
    readonly sent = new Map<string, { label: string; at: number }[]>();
    /** Cards that show pending rows: the next application removes the rows that are not pending any more. */
    protected readonly drawn = new Set<string>();
    revision?: number;

    add(set: string, label: string, now = Date.now()): void {
        this.sent.set(set, [...this.sent.get(set) ?? [], { label, at: now }]);
    }

    remove(set: string, label: string): void {
        const rest = (this.sent.get(set) ?? []).filter(p => p.label !== label);
        if (rest.length) this.sent.set(set, rest); else this.sent.delete(set);
    }

    /**
     * Draw the pending rows on `root`. A new server model confirms the labels that its card has. Rows of earlier applications are
     * replaced (a removed pending member leaves the card).
     */
    apply(root: ModelRoot, now = Date.now()): void {
        const fromServer = root.revision !== undefined && root.revision !== this.revision;
        if (fromServer) this.revision = root.revision;
        for (const set of new Set([...this.sent.keys(), ...this.drawn])) {
            const pending = this.sent.get(set) ?? [];
            const card = root.index.getById(set) as { members?: MemberRow[] } | undefined;
            if (!card?.members) {
                this.sent.delete(set);
                this.drawn.delete(set);
                continue;
            }
            const members = card.members.filter(m => !isPendingRow(m));
            const shown = new Set(members.map(m => m.label));
            const left = pending.filter(p => now - p.at <= PENDING_TIMEOUT && !(fromServer && shown.has(p.label)));
            if (left.length) this.sent.set(set, left); else this.sent.delete(set);
            const rows = left.filter(p => !shown.has(p.label)).map(p => pendingRow(p.label));
            card.members = [...members, ...rows];
            if (rows.length) this.drawn.add(set); else this.drawn.delete(set);
        }
    }
}
