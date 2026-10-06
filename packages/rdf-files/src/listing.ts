// The RDF files of a folder and its subfolders, with exclude globs.

import { promises as fs } from 'fs';
import * as path from 'path';
import { RDF_FORMATS } from './formats';
import { portableRelative } from './paths';

/** A glob (`*`, `**`, `?`) as a regular expression on a path relative to the root folder, with `/`. */
export function globRegExp(glob: string): RegExp {
    const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?|\*|\?/g, m => (m.startsWith('**') ? '(.*/)?' : m === '*' ? '[^/]*' : '[^/]'));
    return new RegExp(`^${re.replace(/\(\.\*\/\)\?$/, '.*')}$`);
}

/** RDF file extensions, without `.xml` (other XML files are common). */
export const LISTED_EXTENSIONS = RDF_FORMATS.flatMap(f => f.extensions).filter(e => e !== '.xml');

/** Names that `listRdfFiles` does not enter or list by default: hidden files and folders, `node_modules`, `*.bak`. */
export const skipName = (name: string, folder: boolean) => name.startsWith('.') || (folder ? name === 'node_modules' : name.endsWith('.bak'));

export interface ListOptions {
    /** Globs relative to the root folder, with `/`. A match is not listed. */
    exclude?: string[];
    /** File extensions with the dot, lower case. Default: LISTED_EXTENSIONS. */
    extensions?: string[];
    /** Files and folders not to list or enter, by name. Default: `skipName`. */
    skip?: (name: string, folder: boolean) => boolean;
    /**
     * A check of each candidate file, before the globs. `skip`: not listed. `stop`: no file of the folder of the file and its
     * subfolders is listed; in the root folder, `stop` acts as `skip`. Undefined: listed.
     */
    check?: (file: string, top: boolean) => Promise<'skip' | 'stop' | undefined>;
}

/**
 * The RDF files of `root` and its subfolders, in path order. Not: the names that `skip` gives, other extensions, `.json` files without
 * `@context` (not JSON-LD), and the files that `exclude` or `check` removes.
 */
export async function listRdfFiles(root: string, options: ListOptions = {}): Promise<string[]> {
    const globs = (options.exclude ?? []).map(globRegExp), extensions = options.extensions ?? LISTED_EXTENSIONS, skip = options.skip ?? skipName;
    /** The files of `dir` and its subfolders; empty when a check stops the folder. */
    const walk = async (dir: string, top: boolean): Promise<string[]> => {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return [];
        }
        const files: string[] = [];
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!skip(e.name, true)) files.push(...await walk(p, false));
                continue;
            }
            if (!e.isFile() || skip(e.name, false) || !extensions.includes(path.extname(e.name).toLowerCase())) continue;
            const checked = await options.check?.(p, top);
            if (checked === 'stop' && !top) return [];
            if (checked) continue;
            if (globs.some(g => g.test(portableRelative(root, p)))) continue;
            if (path.extname(p).toLowerCase() === '.json' && !(await hasContext(p))) continue;
            files.push(p);
        }
        return files;
    };
    return (await walk(root, true)).sort();
}

/** A JSON file with `@context` (JSON-LD). */
async function hasContext(file: string): Promise<boolean> {
    try {
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        const has = (v: unknown): boolean => Array.isArray(v) ? v.some(has) : v !== null && typeof v === 'object' && Object.hasOwn(v, '@context');
        return has(value);
    } catch {
        return false;
    }
}
