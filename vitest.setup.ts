// Vitest runs the test files of a worker in one module graph (isolate: false in vitest.config.mts). Reset the process-wide state that
// a test file can change, so that each file starts as in a new process.
import { afterAll, beforeAll, vi } from 'vitest';
import { DEFAULT_PREFIXES, setPrefixes } from '@catenary/model';

// One prefix table for each process (shapes-doc.ts): a store that opens a workspace sets it.
beforeAll(() => setPrefixes(DEFAULT_PREFIXES));
afterAll(() => {
    setPrefixes(DEFAULT_PREFIXES);
    vi.useRealTimers();
});
