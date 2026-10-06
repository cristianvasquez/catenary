// Path rules, with the platform as a parameter (default: the platform of the process). Tests give `path.win32` or `path.posix` to
// check the Windows rules on Linux. Paths that go into files use `/` on every platform, so that a file written on Windows reads on
// Linux and the reverse.

import * as nodePath from 'path';
import { pathToFileURL } from 'url';

export type PathApi = nodePath.PlatformPath;

const isWindows = (p: PathApi) => p.sep === '\\';

/** The absolute path; on Windows with an upper-case drive letter (one spelling for paths that come from different sources). */
export function absolutePath(file: string, p: PathApi = nodePath): string {
    const r = p.resolve(file);
    return isWindows(p) ? r.replace(/^[a-z]:/, d => d.toUpperCase()) : r;
}

/** A key to compare two paths: Windows file names are not case-sensitive, and git gives `C:/…` where Node has `C:\…`. */
export function pathKey(file: string, p: PathApi = nodePath): string {
    const r = p.resolve(file);
    return isWindows(p) ? r.toLowerCase() : r;
}

/** Whether `file` is in `folder` or in a subfolder of it (not the folder itself). */
export function isInside(folder: string, file: string, p: PathApi = nodePath): boolean {
    const r = p.relative(folder, file);
    return r !== '' && r !== '..' && !r.startsWith('..' + p.sep) && !p.isAbsolute(r);
}

/** The path of `to` relative to the folder `from`, with `/` (the form in files); `.` for the folder itself. */
export function portableRelative(from: string, to: string, p: PathApi = nodePath): string {
    return p.relative(from, to).split(p.sep).join('/') || '.';
}

/** A relative path from a file, resolved against `dir`. Accepts `\` as separator too (files written by earlier Windows builds). */
export function resolveStored(dir: string, stored: string, p: PathApi = nodePath): string {
    return p.resolve(dir, stored.replace(/\\/g, '/'));
}

/** The `file:` IRI of a path (the base IRI of a parsed file). */
export function fileIri(file: string, p: PathApi = nodePath): string {
    return pathToFileURL(p.resolve(file), { windows: isWindows(p) }).href;
}

/** The path in `paths` that names the same file as `file` (on Windows: another case or separator), else `file`. */
export function knownPath(paths: Iterable<string>, file: string, p: PathApi = nodePath): string {
    const k = pathKey(file, p);
    for (const x of paths) if (pathKey(x, p) === k) return x;
    return file;
}
