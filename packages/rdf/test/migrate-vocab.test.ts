// scripts/migrate-vocab.mjs: rewrites the legacy Catenary namespaces to the published ones, as text, only in files that change.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { LEGACY_NAMESPACES } from '@catenary/model';

const SCRIPT = fileURLToPath(new URL('../../../scripts/migrate-vocab.mjs', import.meta.url));
const run = (...args: string[]) => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('the script uses the same namespace map as the model', async () => {
    const script = await import(SCRIPT);
    expect(script.LEGACY_NAMESPACES).toEqual(LEGACY_NAMESPACES);
});

it('rewrites old namespaces in prefixes and full IRIs (also JSON-LD .json), keeps other files and plain .json byte-identical, and a second run changes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-migrate-'));
    dirs.push(dir);
    const a = '# a comment\n@prefix view: <osg://vocab/view#> .\n@prefix ex: <http://example.org/> .\n\nex:v a view:View ;   view:shows ex:x .\n';
    const b = '<osg://vocab/workspace#ws> {\n  <osg://vocab/workspace#ws> <osg://vocab/notation/shapes#mode> <osg://vocab/notation#Default> .\n}\n';
    const c = '@prefix ex: <http://example.org/> .\nex:a ex:b "osg://vocab/other" .\n';
    writeFileSync(join(dir, 'a.ttl'), a);
    writeFileSync(join(dir, 'b.trig'), b);
    writeFileSync(join(dir, 'c.ttl'), c);
    const plain = '{"example": "osg://vocab/view#View"}\n';
    writeFileSync(join(dir, 'plain.json'), plain);
    writeFileSync(join(dir, 'e.json'), '{"@context": {"view": "osg://vocab/view#"}, "@id": "http://example.org/v", "@type": "view:View"}\n');

    expect(run(dir, '--dry-run')).toBe('would change a.ttl (1 replacements)\nwould change b.trig (4 replacements)\nwould change e.json (1 replacements)\n3 file(s) to change\n');
    expect(readFileSync(join(dir, 'a.ttl'), 'utf8')).toBe(a);

    expect(run(dir)).toBe('changed a.ttl (1 replacements)\nchanged b.trig (4 replacements)\nchanged e.json (1 replacements)\n3 file(s) changed\n');
    const V = 'https://cristianvasquez.github.io/catenary/vocab/';
    expect(readFileSync(join(dir, 'a.ttl'), 'utf8')).toBe(a.replace('osg://vocab/view#', V + 'view#'));
    const newB = readFileSync(join(dir, 'b.trig'), 'utf8');
    expect(newB).toBe(`<${V}workspace#ws> {\n  <${V}workspace#ws> <${V}notation/shapes#mode> <${V}notation#Default> .\n}\n`);
    for (const old of Object.keys(LEGACY_NAMESPACES)) expect(newB).not.toContain(old);
    expect(readFileSync(join(dir, 'c.ttl'))).toEqual(Buffer.from(c));
    expect(readFileSync(join(dir, 'plain.json'))).toEqual(Buffer.from(plain));

    expect(run(dir)).toBe('0 file(s) changed\n');
});
