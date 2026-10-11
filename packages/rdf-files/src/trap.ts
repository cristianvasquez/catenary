// A WebAssembly trap in the quad store (Oxigraph: `RuntimeError: unreachable`, also after a Rust panic). The Rust side unwinds
// without releasing its lock: every later call of the same store panics ("Parking not supported on this platform"). The guard is the
// one place that detects a trap. After it, the guard answers each call with the same StoreTrap without a call of the store, and the
// owner of the store builds a new one.

import type { Quad, Term } from '@rdfjs/types';
import type { Bindings, QuadStore } from './store';

/** The error of each call after a trap. `cause`: the trap. */
export class StoreTrap extends Error {
    override readonly name = 'StoreTrap';
    constructor(message: string, override readonly cause: Error) {
        super(message);
    }
}

/** A WebAssembly trap or a Rust panic. Checked by name too: the RuntimeError class of another realm is not `WebAssembly.RuntimeError`. */
export function isWasmTrap(e: unknown): e is Error {
    if (!(e instanceof Error)) return false;
    return e instanceof WebAssembly.RuntimeError || e.name === 'RuntimeError' || e.message.startsWith('panicked at ');
}

export const TRAP_MESSAGE = 'The model index failed. The files are read again.';

/** A quad store that converts a trap of `inner` to a StoreTrap, reports it once to `onTrap`, and makes no further call of `inner`. */
export class TrapGuard implements QuadStore {
    /** Set at the first trap. Each later call throws it. */
    trap?: StoreTrap;

    constructor(protected readonly inner: QuadStore, protected readonly onTrap?: (trap: StoreTrap) => void) {}

    /** Change the message of the calls after the trap (for example when the new store failed too). */
    fail(message: string): void {
        if (this.trap) this.trap.message = message;
    }

    protected guard<T>(fn: () => T): T {
        if (this.trap) throw this.trap;
        try {
            return fn();
        } catch (e) {
            if (!isWasmTrap(e)) throw e;
            this.trap = new StoreTrap(TRAP_MESSAGE, e);
            this.onTrap?.(this.trap);
            throw this.trap;
        }
    }

    get size(): number { return this.guard(() => this.inner.size); }
    has(q: Quad): boolean { return this.guard(() => this.inner.has(q)); }
    add(q: Quad): void { this.guard(() => this.inner.add(q)); }
    delete(q: Quad): void { this.guard(() => this.inner.delete(q)); }
    match(s?: Term | null, p?: Term | null, o?: Term | null, g?: Term | null): Quad[] { return this.guard(() => this.inner.match(s, p, o, g)); }
    select(query: string): Bindings[] { return this.guard(() => this.inner.select(query)); }
    construct(query: string): Quad[] { return this.guard(() => this.inner.construct(query)); }
}
