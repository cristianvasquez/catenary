import { describe, expect, it } from 'vitest';
import { baseName, copyViewFile, dirName, freeViewFile, relativePath, viewFileInput } from '../src';

describe('backend paths in the user interface', () => {
    it('baseName and dirName with / and \\', () => {
        expect(baseName('/ws/data/a.ttl')).toBe('a.ttl');
        expect(baseName('C:\\ws\\data\\a.ttl')).toBe('a.ttl');
        expect(baseName('a.ttl')).toBe('a.ttl');
        expect(dirName('/ws/data/a.ttl')).toBe('/ws/data');
        expect(dirName('C:\\ws\\data\\a.ttl')).toBe('C:\\ws\\data');
    });

    it('relativePath: /, \\, drive letter case', () => {
        expect(relativePath('/ws', '/ws/data/a.ttl')).toBe('data/a.ttl');
        expect(relativePath('C:\\ws', 'C:\\ws\\data\\a.ttl')).toBe('data/a.ttl');
        expect(relativePath('c:\\WS', 'C:\\ws\\a.ttl')).toBe('a.ttl');
        expect(relativePath('C:\\ws\\', 'C:\\ws\\a.ttl')).toBe('a.ttl');
    });

    it('relativePath: undefined outside the folder', () => {
        expect(relativePath('/ws', '/ws2/a.ttl')).toBeUndefined();
        expect(relativePath('/ws', '/ws')).toBeUndefined();
        expect(relativePath('/Ws', '/ws/a.ttl')).toBeUndefined();
        expect(relativePath('C:\\ws', 'D:\\ws\\a.ttl')).toBeUndefined();
    });

    // law_newViewFileIsTrig
    it('viewFileInput: any name, .trig added when missing, / as separator', () => {
        expect(viewFileInput(' views/road ')).toBe('views/road.trig');
        expect(viewFileInput('plans\\road.view')).toBe('plans/road.view.trig');
        expect(viewFileInput('road.TriG')).toBe('road.TriG');
    });

    it('freeViewFile: unnamed-view.view.trig in the folder, -2, … when taken', () => {
        expect(freeViewFile('views', new Set())).toBe('views/unnamed-view.view.trig');
        expect(freeViewFile('', new Set(['unnamed-view.view.trig']))).toBe('unnamed-view-2.view.trig');
        expect(freeViewFile('a/', new Set(['a/unnamed-view.view.trig', 'a/unnamed-view-2.view.trig']))).toBe('a/unnamed-view-3.view.trig');
    });

    it('copyViewFile: <name>-copy next to the source, with its extension; -2, … when taken', () => {
        expect(copyViewFile('views/road.view.trig', new Set())).toBe('views/road-copy.view.trig');
        expect(copyViewFile('plans/road.trig', new Set(['plans/road-copy.trig']))).toBe('plans/road-copy-2.trig');
        expect(copyViewFile('road.trig', new Set())).toBe('road-copy.trig');
    });
});
