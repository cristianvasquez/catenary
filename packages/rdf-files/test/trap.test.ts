import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore, StoreTrap, TRAP_MESSAGE, TrapGuard, isWasmTrap, rdf } from 'rdf-files';

const q = rdf.quad(rdf.namedNode('urn:s'), rdf.namedNode('urn:p'), rdf.namedNode('urn:o'));

/** A store whose `match` traps once as the WASM store does, and whose later calls panic (also a RuntimeError) until it is replaced. */
class TrappingStore extends OxigraphStore {
    armed = false;
    trapped = false;
    calls = 0;
    protected check(): void {
        this.calls++;
        if (this.trapped) throw new WebAssembly.RuntimeError('unreachable'); // the log prints "panicked at … Parking not supported"
        if (this.armed) { this.trapped = true; throw new WebAssembly.RuntimeError('unreachable'); }
    }
    override match(...a: Parameters<OxigraphStore['match']>) { this.check(); return super.match(...a); }
    override add(x: Parameters<OxigraphStore['add']>[0]) { this.check(); super.add(x); }
}

describe('trap guard (§3.4)', () => {
    it('law_trapStopsStoreCalls: converts a WebAssembly trap to one StoreTrap, reports it once and makes no later call of the store', () => {
        const inner = new TrappingStore();
        const onTrap = vi.fn();
        const guard = new TrapGuard(inner, onTrap);
        guard.add(q);
        expect(guard.match(null, null, null, null)).toHaveLength(1);
        inner.armed = true;
        expect(() => guard.match(null, null, null, null)).toThrow(StoreTrap);
        const calls = inner.calls;
        for (const call of [() => guard.add(q), () => guard.match(), () => guard.select('SELECT * WHERE { ?s ?p ?o }'), () => guard.size]) {
            expect(call).toThrow(TRAP_MESSAGE);
        }
        expect(inner.calls).toBe(calls);
        expect(onTrap).toHaveBeenCalledTimes(1);
        expect(guard.trap?.cause).toBeInstanceOf(WebAssembly.RuntimeError);
        guard.fail('Restart.');
        expect(() => guard.match()).toThrow('Restart.');
    });

    it('passes other errors through without a trap', () => {
        const guard = new TrapGuard(new OxigraphStore(), vi.fn());
        expect(() => guard.select('SELECT nonsense')).toThrow();
        expect(guard.trap).toBeUndefined();
        expect(guard.match()).toEqual([]);
    });

    it('isWasmTrap: a RuntimeError by class or by name, a panic message; not a plain error', () => {
        expect(isWasmTrap(new WebAssembly.RuntimeError('unreachable'))).toBe(true);
        expect(isWasmTrap(Object.assign(new Error('unreachable'), { name: 'RuntimeError' }))).toBe(true);
        expect(isWasmTrap(new Error('panicked at parking_lot_core/src/thread_parker/wasm.rs:26:9'))).toBe(true);
        expect(isWasmTrap(new Error('Not a SELECT query.'))).toBe(false);
        expect(isWasmTrap('unreachable')).toBe(false);
    });
});
