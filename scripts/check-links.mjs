#!/usr/bin/env node
// Checks the relative links of the Markdown files in Git: the target file exists, and a #fragment names a heading of the target.
// No dependencies: CI runs it before the install. External links (http, mailto) are not checked.
// Usage: node scripts/check-links.mjs [file.md ...]   (default: all Markdown files in Git)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = process.argv.length > 2
    ? process.argv.slice(2)
    : execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

/** Markdown text without fenced code blocks and inline code, with the line numbers kept. */
const prose = text => {
    let fence = null;
    return text.split('\n').map(line => {
        const m = /^\s*(```|~~~)/.exec(line);
        if (m) { fence = fence === m[1] ? null : fence ?? m[1]; return ''; }
        return fence ? '' : line.replace(/`[^`]*`/g, '');
    });
};

/** GitHub heading anchors of a Markdown file. */
const anchorCache = new Map();
function anchors(file) {
    if (!anchorCache.has(file)) {
        const seen = new Map();
        const set = new Set();
        for (const line of prose(readFileSync(file, 'utf8'))) {
            const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
            if (!h) continue;
            const slug = h[1].toLowerCase().replace(/<[^>]*>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
                .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
            const n = seen.get(slug) ?? 0;
            seen.set(slug, n + 1);
            set.add(n ? `${slug}-${n}` : slug);
        }
        anchorCache.set(file, set);
    }
    return anchorCache.get(file);
}

let failures = 0;
for (const file of files) {
    const abs = resolve(root, file);
    prose(readFileSync(abs, 'utf8')).forEach((line, i) => {
        for (const m of line.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
            const target = m[1];
            if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
            const [path, fragment] = target.split('#');
            const dest = path ? resolve(dirname(abs), decodeURIComponent(path)) : abs;
            let error;
            if (!existsSync(dest)) error = 'no such file';
            else if (fragment && statSync(dest).isFile() && dest.endsWith('.md') && !anchors(dest).has(decodeURIComponent(fragment).toLowerCase())) {
                error = `no heading #${fragment}`;
            }
            if (error) {
                failures++;
                console.log(`${relative(root, abs)}:${i + 1}: ${target}: ${error}`);
            }
        }
    });
}
console.log(failures ? `check-links: ${failures} broken links` : `check-links: ${files.length} files, no broken links`);
process.exit(failures ? 1 : 0);
