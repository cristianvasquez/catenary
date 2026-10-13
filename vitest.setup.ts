// After each test: restore the process-wide state that a test can change and that Vitest does not restore (vitest.config.mts restores
// mocks, globals and environment variables). Isolation gives each file a new module graph, so this protects the next test of a file.
import { afterEach, vi } from 'vitest';
import { DEFAULT_PREFIXES, setPrefixes } from '@catenary/model';

afterEach(() => {
    // One prefix table for each process (shapes-doc.ts): a store that opens a workspace sets it.
    setPrefixes(DEFAULT_PREFIXES);
    vi.useRealTimers();
});
