import { describe, expect, it } from 'vitest';
import type { EditCommand } from '@catenary/model';
import { EDIT_COMMAND_KINDS, commandShapeError, executeCommand } from '../src/commands';
import { emptyGraph, meta } from './helpers';

const exec = async (c: unknown) => executeCommand(emptyGraph(), await meta(), c as EditCommand);

describe('law_execMessageNamesTheFault (manifest §12)', () => {
    it('a value without a string kind gives the shape message', async () => {
        for (const c of [[{ kind: 'createView', label: 'V' }], {}, { kind: 3 }, null, 'createView']) {
            expect(await exec(c), JSON.stringify(c)).toEqual({ ok: false, error: 'An edit command is a JSON object with a string kind.' });
        }
    });

    it('an unknown string kind gives the restart hint and the known kinds', async () => {
        const r = await exec({ kind: 'frobnicate' });
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toBe(`Unknown command kind "frobnicate". If the frontend sent it, restart the backend. Known kinds: ${EDIT_COMMAND_KINDS.join(', ')}.`);
        expect(EDIT_COMMAND_KINDS).toContain('createView');
    });

    it('a known kind has no shape error', () => {
        for (const kind of EDIT_COMMAND_KINDS) expect(commandShapeError({ kind })).toBeUndefined();
        expect(commandShapeError({ kind: 'toString' })).toMatch(/^Unknown command kind "toString"/);
    });
});
