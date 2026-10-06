import { describe, expect, it } from 'vitest';
import { MODEL_QUERIES } from '@catenary/model';
import { ModelServiceImpl } from '../src/node/model-service';

describe('ModelServiceImpl read queries', () => {
    it('has a prototype method for each query, which calls the store method with the store as `this` and returns a promise', async () => {
        const store = {
            prefix: 'store',
            ...Object.fromEntries(Object.keys(MODEL_QUERIES).map(name => [name, function (this: { prefix: string }, ...args: unknown[]) {
                return `${this.prefix}.${name}(${args.join(',')})`;
            }]))
        };
        const service = Object.assign(new ModelServiceImpl(), { store });
        for (const name of Object.keys(MODEL_QUERIES) as (keyof typeof MODEL_QUERIES)[]) {
            expect(Object.hasOwn(ModelServiceImpl.prototype, name)).toBe(true);
            const call = (service[name] as (...a: unknown[]) => Promise<unknown>)('a', 1);
            expect(call).toBeInstanceOf(Promise);
            expect(await call).toBe(`store.${name}(a,1)`);
        }
    });
});
