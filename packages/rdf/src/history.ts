// Undo, redo and the patch queue. One EditCommand = one patch = one undo step. Each step keeps the patch queue before and after it.

import type { Migration, MigrationChange } from '@catenary/model';
import type { Patch } from './graph';

const UNDO_LIMIT = 200;

export type QueueEntry = Omit<Migration, 'count'>;

/** One undo step: the patch, and the patch queue before and after it. */
export interface Step {
    patch: Patch;
    transferFiles: string[];
    queue: [QueueEntry[], QueueEntry[]];
}

export class History {
    /** The patch queue. */
    migrations: QueueEntry[] = [];
    protected undoStack: Step[] = [];
    protected redoStack: Step[] = [];
    protected seq = 0;

    get canUndo(): boolean { return this.undoStack.length > 0; }
    get canRedo(): boolean { return this.redoStack.length > 0; }

    /**
     * Record a command. The queue loses the entry that the command applied (`applied`) and gets the entries that it proposed. A command
     * without a patch changes nothing (its proposed entries still use ids).
     */
    record(patch: Patch, applied: string | undefined, proposed: { change: MigrationChange; reason: string }[], transferFiles: string[] = []): void {
        const before = this.migrations;
        let queue = applied ? before.filter(m => m.id !== applied) : before;
        queue = [...queue, ...proposed.map(p => ({ id: `m${++this.seq}`, reason: p.reason, ...p.change }))];
        if (!patch.length) return;
        this.migrations = queue;
        this.undoStack.push({ patch, transferFiles, queue: [before, queue] });
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
        this.redoStack = [];
    }

    /** The step that `take` would give, without a move. */
    peek(reason: 'undo' | 'redo'): Step | undefined {
        const from = reason === 'undo' ? this.undoStack : this.redoStack;
        return from[from.length - 1];
    }

    /** The step to undo or redo, moved to the other stack; undefined: none. The patch queue goes back to its state of that step. */
    take(reason: 'undo' | 'redo'): Step | undefined {
        const [from, to] = reason === 'undo' ? [this.undoStack, this.redoStack] : [this.redoStack, this.undoStack];
        const step = from.pop();
        if (!step) return undefined;
        to.push(step);
        this.migrations = step.queue[reason === 'undo' ? 0 : 1];
        return step;
    }

    /** Remove an entry of the patch queue without applying it. Not an undo step. False: no such entry. */
    dismiss(id: string): boolean {
        const next = this.migrations.filter(m => m.id !== id);
        if (next.length === this.migrations.length) return false;
        this.migrations = next;
        return true;
    }

    /** No undo, no redo, an empty queue (after an open, or after files changed on disk). */
    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
        this.migrations = [];
    }
}
