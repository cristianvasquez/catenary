// File paths of the backend as strings, for the user interface: `/` (Linux, macOS) or `\` (Windows) as separator. No Node `path`:
// the browser does not have it, and the platform of the backend is not the platform of the browser code.

const SEPARATOR = /[\\/]/;
const isDrivePath = (p: string) => /^[A-Za-z]:/.test(p);

/** The last name of a path: `a.ttl` of `/ws/a.ttl` and of `C:\ws\a.ttl`. */
export const baseName = (p: string): string => p.split(SEPARATOR).pop() ?? p;

/** The path without its last name: `/ws` of `/ws/a.ttl`, `C:\ws` of `C:\ws\a.ttl`. */
export const dirName = (p: string): string => p.replace(/[\\/][^\\/]*$/, '');

/**
 * The path of `file` relative to `folder`, with `/`; undefined when `file` is not in the folder or a subfolder. Paths with a drive
 * letter (Windows) are compared without case.
 */
export function relativePath(folder: string, file: string): string | undefined {
    const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
    const f = norm(folder), p = norm(file);
    const same = isDrivePath(f) ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b;
    return p.length > f.length + 1 && p[f.length] === '/' && same(p.slice(0, f.length), f) ? p.slice(f.length + 1) : undefined;
}
