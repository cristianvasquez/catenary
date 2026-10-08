// Path rules on Windows and on POSIX, checked on any platform: the functions take `path.win32` or `path.posix`.
import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Manifest, NEAR, WS, manifestQuads, readManifest } from '../src/files';
import { absolutePath, fileIri, isInside, knownPath, pathKey, portableRelative, resolveStored } from 'rdf-files';
import { rdf } from '../src/terms';

describe('paths on Windows', () => {
    it('absolute paths have an upper-case drive letter (as Theia gives them)', () => {
        expect(absolutePath('c:\\ws\\a.ttl', win32)).toBe('C:\\ws\\a.ttl');
        expect(absolutePath('C:/ws/a.ttl', win32)).toBe('C:\\ws\\a.ttl');
    });

    it('path keys ignore case and the separator', () => {
        expect(pathKey('C:/Users/Me/ws/a.ttl', win32)).toBe(pathKey('c:\\users\\me\\ws\\a.ttl', win32));
        expect(pathKey('/ws/A.ttl', posix)).not.toBe(pathKey('/ws/a.ttl', posix));
    });

    it('isInside: a subfolder yes; the folder, a sibling with the same prefix, another drive no', () => {
        expect(isInside('C:\\ws', 'C:\\ws\\data\\a.ttl', win32)).toBe(true);
        expect(isInside('C:\\ws', 'c:\\WS\\a.ttl', win32)).toBe(true);
        expect(isInside('C:\\ws', 'C:\\ws', win32)).toBe(false);
        expect(isInside('C:\\ws', 'C:\\ws2\\a.ttl', win32)).toBe(false);
        expect(isInside('C:\\ws', 'C:\\a.ttl', win32)).toBe(false);
        expect(isInside('C:\\ws', 'D:\\ws\\a.ttl', win32)).toBe(false);
        expect(isInside('C:\\ws', 'C:\\ws\\..name.ttl', win32)).toBe(true);
        expect(isInside('/ws', '/ws/data/a.ttl', posix)).toBe(true);
        expect(isInside('/ws', '/ws2/a.ttl', posix)).toBe(false);
    });

    it('relative paths for files use /', () => {
        expect(portableRelative('C:\\ws', 'C:\\ws\\data\\a.ttl', win32)).toBe('data/a.ttl');
        expect(portableRelative('C:\\ws\\views', 'C:\\ws\\data\\a.ttl', win32)).toBe('../data/a.ttl');
        expect(portableRelative('C:\\ws', 'C:\\ws', win32)).toBe('.');
        expect(portableRelative('/ws', '/ws/data/a.ttl', posix)).toBe('data/a.ttl');
    });

    it('stored relative paths resolve with / and with \\ on both platforms', () => {
        expect(resolveStored('C:\\ws', 'data/a.ttl', win32)).toBe('C:\\ws\\data\\a.ttl');
        expect(resolveStored('C:\\ws', 'data\\a.ttl', win32)).toBe('C:\\ws\\data\\a.ttl');
        expect(resolveStored('/ws', 'data\\a.ttl', posix)).toBe('/ws/data/a.ttl');
        expect(resolveStored('/ws/views', '../data/a.ttl', posix)).toBe('/ws/data/a.ttl');
    });

    it('file IRIs', () => {
        expect(fileIri('C:\\ws\\a b.ttl', win32)).toBe('file:///C:/ws/a%20b.ttl');
        expect(fileIri('/ws/a b.ttl', posix)).toBe('file:///ws/a%20b.ttl');
    });
});

describe('manifest paths across platforms', () => {
    const manifest = (defaultFile: string): Manifest => ({ defaultFile, placement: { shapes: defaultFile, concepts: NEAR, instances: NEAR }, exclude: [], imported: [] });
    const stored = (m: Manifest, workspace: string, platform: typeof win32) =>
        manifestQuads(m, workspace, platform).filter(q => q.predicate.equals(WS.defaultFile)).map(q => q.object.value);

    it('a manifest written on Windows has / and opens on Linux', () => {
        const quads = manifestQuads(manifest('C:\\ws\\data\\a.ttl'), 'C:\\ws\\w.trig', win32);
        expect(stored(manifest('C:\\ws\\data\\a.ttl'), 'C:\\ws\\w.trig', win32)).toEqual(['data/a.ttl']);
        expect(readManifest(quads, '/home/me/ws/w.trig', posix).defaultFile).toBe('/home/me/ws/data/a.ttl');
        expect(readManifest(quads, '/home/me/ws/w.trig', posix).placement).toEqual({ shapes: '/home/me/ws/data/a.ttl', concepts: NEAR, instances: NEAR });
    });

    it('a manifest written on Linux opens on Windows', () => {
        const quads = manifestQuads(manifest('/home/me/ws/data/a.ttl'), '/home/me/ws/w.trig', posix);
        expect(readManifest(quads, 'C:\\ws\\w.trig', win32).defaultFile).toBe('C:\\ws\\data\\a.ttl');
    });

    it('a manifest of an earlier Windows build (with \\) opens on Linux', () => {
        const g = rdf.namedNode('urn:name:workspace');
        const quads = [rdf.quad(g, WS.defaultFile, rdf.literal('data\\a.ttl'), g)];
        expect(readManifest(quads, '/home/me/ws/w.trig', posix).defaultFile).toBe('/home/me/ws/data/a.ttl');
    });
});

describe('knownPath', () => {
    const disk = ['C:\\ws\\data.ttl', 'C:\\ws\\views\\main.view.trig'];

    it('on Windows, a manifest path in another case or with / is the file on disk', () => {
        expect(knownPath(disk, 'C:\\ws\\Data.ttl', win32)).toBe('C:\\ws\\data.ttl');
        expect(knownPath(disk, 'c:/WS/DATA.TTL', win32)).toBe('C:\\ws\\data.ttl');
    });

    it('a new file stays as it is; on POSIX the case counts', () => {
        expect(knownPath(disk, 'C:\\ws\\new.ttl', win32)).toBe('C:\\ws\\new.ttl');
        expect(knownPath(['/ws/data.ttl'], '/ws/Data.ttl', posix)).toBe('/ws/Data.ttl');
    });
});
