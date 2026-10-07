import { execFileSync } from 'child_process';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { childArgs, hashWorkspace, profileDir } from '../src/electron-main/electron-main-module';

describe('Electron process per workspace', () => {
    it('gives the profile that scripts/desktop.sh gives (Linux)', () => {
        const ws = '/tmp/some workspace';
        const hash = execFileSync('bash', ['-c', 'printf "%s" "$1" | sha256sum | cut -c1-16', '_', ws], { encoding: 'utf8' }).trim();
        expect(path.basename(profileDir(ws, path.posix))).toBe(hash);
        expect(path.basename(profileDir(''))).toBe('no-workspace');
    });

    it('on Windows, one profile for one folder in another case or with /', () => {
        expect(profileDir('c:/Users/Me/WS', path.win32)).toBe(profileDir('C:\\Users\\me\\ws', path.win32));
        expect(profileDir('/ws/A', path.posix)).not.toBe(profileDir('/ws/a', path.posix));
    });

    it('the workspace of a window URL hash is a file path on Windows', () => {
        expect(hashWorkspace('/c:/Users/me/my%20ws', path.win32)).toBe('C:\\Users\\me\\my ws');
        expect(hashWorkspace('//server/share/ws', path.win32)).toBe('\\\\server\\share\\ws');
        expect(hashWorkspace('/home/me/my%20ws', path.posix)).toBe('/home/me/my ws');
        expect(hashWorkspace('', path.win32)).toBe('');
    });

    it('replaces the workspace and the profile, keeps the app path and the other flags', () => {
        const argv = ['/bin/electron', '.', '/ws/a', '--plugins=local-dir:/p', '--user-data-dir=/old'];
        expect(childArgs(argv, true, '/ws/b')).toEqual(['.', '/ws/b', '--plugins=local-dir:/p', `--user-data-dir=${profileDir('/ws/b')}`]);
        expect(childArgs(['/opt/Catenary', '--x'], false, '')).toEqual(['--x', `--user-data-dir=${profileDir('')}`]);
    });
});
