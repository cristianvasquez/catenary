// Git as the history of the files: the status of a folder and commits of written files.

import { execFile } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import * as path from 'path';

/** Run git in `cwd`. `out`: stdout (trimmed, except with `-z`), or the error text. */
export const git = (cwd: string, ...args: string[]) => new Promise<{ ok: boolean; out: string }>(resolve =>
    execFile('git', args, { cwd, timeout: 30000 }, (e, stdout, stderr) => resolve({ ok: !e, out: e ? String(stderr || e.message).trim() : (args.includes('-z') ? String(stdout) : String(stdout).trim()) })));

/**
 * A folder as git spells it: the real path. On Windows also the long name of a short 8.3 name (`C:\Users\RUNNER~1`). Unchanged when the
 * folder does not exist.
 */
const realDir = (dir: string) => { try { return realpathSync.native(dir); } catch { return dir; } };

/**
 * The files with changes in the git repository of `folder` (absolute paths; both paths of a rename or copy). `repo: false`: the folder
 * is not in a repository.
 */
export async function gitChanges(folder: string): Promise<{ ok: true; files: string[] } | { ok: false; repo: boolean; error: string }> {
    const top = await git(folder, 'rev-parse', '--show-toplevel');
    if (!top.ok) return { ok: false, repo: false, error: top.out };
    const status = await git(top.out, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
    if (!status.ok) return { ok: false, repo: true, error: status.out };
    // Git gives paths under its real path of the repository: give them in the spelling of `folder`.
    const realFolder = realDir(folder);
    const own = (entry: string) => path.join(folder, path.relative(realFolder, path.resolve(top.out, entry)));
    const files: string[] = [];
    const entries = status.out.split('\0');
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry) continue;
        files.push(own(entry.slice(3)));
        if (/[RC]/.test(entry.slice(0, 2))) files.push(own(entries[++i]));
    }
    return { ok: true, files };
}

/**
 * Commit the written files: in each git repository that has some of them, `git add` and `git commit --only`, so that other staged
 * changes of the user are not in the commit. Files ignored by git and files outside a repository: no commit. Returns an error text, or
 * undefined.
 */
export async function commitFiles(files: string[], message: string): Promise<string | undefined> {
    const byRepo = new Map<string, string[]>();
    for (const file of files) {
        const top = await git(path.dirname(file), 'rev-parse', '--show-toplevel');
        if (!top.ok) continue;
        const rel = path.relative(top.out, path.join(realDir(path.dirname(file)), path.basename(file)));
        if ((await git(top.out, 'check-ignore', '-q', '--', rel)).ok) continue;
        // A removed file: only when git knows it.
        if (!existsSync(file) && !(await git(top.out, 'ls-files', '--error-unmatch', '--', rel)).ok) continue;
        (byRepo.get(top.out) ?? byRepo.set(top.out, []).get(top.out)!).push(rel);
    }
    for (const [repo, rels] of byRepo) {
        const add = await git(repo, 'add', '-A', '--', ...rels);
        if (!add.ok) return `Not committed: ${add.out}`;
        if ((await git(repo, 'diff', '--cached', '--quiet', '--', ...rels)).ok) continue; // nothing changed in git
        const commit = await git(repo, 'commit', '--only', '-q', '-m', message, '--', ...rels);
        if (!commit.ok) return `Not committed: ${commit.out}`;
    }
    return undefined;
}
