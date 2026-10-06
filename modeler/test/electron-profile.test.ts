import { execFileSync } from 'child_process';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { childArgs, profileDir } from '../src/electron-main/electron-main-module';

describe('Electron process per workspace', () => {
    it('gives the profile that scripts/desktop.sh gives', () => {
        const ws = '/tmp/some workspace';
        const hash = execFileSync('bash', ['-c', 'printf "%s" "$1" | sha256sum | cut -c1-16', '_', ws], { encoding: 'utf8' }).trim();
        expect(path.basename(profileDir(ws))).toBe(hash);
        expect(path.basename(profileDir(''))).toBe('no-workspace');
    });

    it('replaces the workspace and the profile, keeps the app path and the other flags', () => {
        const argv = ['/bin/electron', '.', '/ws/a', '--plugins=local-dir:/p', '--user-data-dir=/old'];
        expect(childArgs(argv, true, '/ws/b')).toEqual(['.', '/ws/b', '--plugins=local-dir:/p', `--user-data-dir=${profileDir('/ws/b')}`]);
        expect(childArgs(['/opt/Catenary', '--x'], false, '')).toEqual(['--x', `--user-data-dir=${profileDir('')}`]);
    });
});
