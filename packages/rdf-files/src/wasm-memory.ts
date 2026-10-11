// The WebAssembly memory of the Oxigraph store (spec/open.md STORE3). The oxigraph package does not export its instance, so the
// constructor of WebAssembly.Instance is wrapped before the package loads: the instance whose exports have `store_new` and `memory` is
// Oxigraph. Import this module before 'oxigraph' (oxigraph-store.ts does). The memory of a WebAssembly instance never shrinks.

let memory: WebAssembly.Memory | undefined;

const Instance = WebAssembly.Instance;
WebAssembly.Instance = new Proxy(Instance, {
    construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget) as WebAssembly.Instance;
        const exports = instance.exports as Record<string, unknown>;
        if (!memory && typeof exports.store_new === 'function' && exports.memory instanceof WebAssembly.Memory) memory = exports.memory;
        return instance;
    }
});

/** The bytes of the WebAssembly memory of Oxigraph. Undefined: the package did not load through the wrapped constructor. */
export function oxigraphMemoryBytes(): number | undefined {
    return memory?.buffer.byteLength;
}
