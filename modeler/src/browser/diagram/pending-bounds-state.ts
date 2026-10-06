// The state of PendingBounds (pending-bounds.ts), without GLSP: the bounds that this client sent and not yet seen in a server model.

/** The part of a GLSP model root that the state reads and changes. */
export interface ModelRoot {
    revision?: number;
    index: { getById(id: string): object | undefined };
}

export const TIMEOUT = 3000;

export type Bounds = { x: number; y: number; width: number; height: number };

/** The same bounds, within a rounding of the server (integer coordinates). */
const same = (a: Bounds, b: Bounds) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;

/**
 * The bounds that this client sent for each element, oldest first, and when it sent the last one. `revision`: the last server model
 * seen (a feedback command also runs on the current model, which is not a confirmation).
 */
export class PendingBoundsState {
    readonly sent = new Map<string, { bounds: Bounds[]; at: number }>();
    revision?: number;

    /** Apply the pending bounds to `root`. A new server model drops the bounds up to the ones that it has. */
    apply(root: ModelRoot, now = Date.now()): void {
        const fromServer = root.revision !== undefined && root.revision !== this.revision;
        if (fromServer) this.revision = root.revision;
        for (const [id, entry] of [...this.sent]) {
            const element = root.index.getById(id);
            if (!element || !('bounds' in element) || now - entry.at > TIMEOUT) {
                this.sent.delete(id);
                continue;
            }
            if (fromServer) {
                const confirmed = entry.bounds.findIndex(b => same(b, (element as { bounds: Bounds }).bounds));
                if (confirmed >= 0) entry.bounds.splice(0, confirmed + 1);
                if (!entry.bounds.length) {
                    this.sent.delete(id);
                    continue;
                }
            }
            (element as { bounds: Bounds }).bounds = entry.bounds[entry.bounds.length - 1];
        }
    }
}
