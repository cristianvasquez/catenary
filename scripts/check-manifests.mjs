#!/usr/bin/env node
// Typecheck the contracts spec/manifest.hs and spec/ui-manifest.hs with GHC (no code generation). A name or a type that one
// section uses and no section declares, or that two sections use differently, fails the check. Warnings fail too.
// Needs ghc on PATH (Debian/Ubuntu: apt-get install ghc; else ghcup).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(join(tmpdir(), 'catenary-ghc-'));
const r = spawnSync('ghc', ['-fno-code', '-fforce-recomp', '-Wall', '-Werror', '-v0', '-outputdir', out,
    'spec/manifest.hs', 'spec/ui-manifest.hs'], { cwd: root, stdio: 'inherit' });
rmSync(out, { recursive: true, force: true });
if (r.error?.code === 'ENOENT') {
    console.log('check-manifests: skipped (GHC is not installed).');
    process.exit(0);
}
if (r.error) {
    console.error(`check-manifests: cannot run ghc (${r.error.message}). Install GHC: apt-get install ghc, or https://www.haskell.org/ghcup/.`);
    process.exit(1);
}
if (r.status !== 0) {
    console.error('check-manifests: the manifests do not typecheck. Fix the contract, not only the stub.');
    process.exit(1);
}
console.log('check-manifests: spec/manifest.hs and spec/ui-manifest.hs typecheck.');
