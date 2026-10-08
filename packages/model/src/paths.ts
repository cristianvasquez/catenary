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

/** The view file that the user types for a new view: `/` as separator, `.trig` added when missing (a view file is TriG, any name). */
export const viewFileInput = (text: string): string => {
    const t = text.trim().replace(/\\/g, '/');
    return /\.trig$/i.test(t) ? t : `${t}.trig`;
};

/**
 * A proposed file for a new view in `dir` (relative, '' for the workspace folder) that is not `taken`: `<base><ext>`, then
 * `<base>-2<ext>`, … Default: `unnamed-view.view.trig`.
 */
export function freeViewFile(dir: string, taken: ReadonlySet<string | undefined>, base = 'unnamed-view', ext = '.view.trig'): string {
    const at = (i: number) => `${dir ? dir.replace(/\/$/, '') + '/' : ''}${base}${i === 1 ? '' : '-' + i}${ext}`;
    let i = 1;
    while (taken.has(at(i))) i++;
    return at(i);
}

/** The proposed file of a copy of the view in `file`: `<name>-copy` in its folder, with its extension (`.view.trig` or `.trig`). */
export function copyViewFile(file: string, taken: ReadonlySet<string | undefined>): string {
    const ext = /\.view\.trig$/i.test(file) ? '.view.trig' : '.trig';
    const name = baseName(file).slice(0, -ext.length);
    const dir = /[\\/]/.test(file) ? dirName(file).replace(/\\/g, '/') : '';
    return freeViewFile(dir, taken, `${name}-copy`, ext);
}
