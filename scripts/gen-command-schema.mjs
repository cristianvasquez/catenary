#!/usr/bin/env node
// Writes packages/model/src/command-schema.json from the EditCommand union of packages/model/src/commands.ts (manifest §12).
// Each kind in source order: { kind, doc, fields: [{ name, type, optional }] }. "types": the type aliases of commands.ts that the fields use.
// Usage: node scripts/gen-command-schema.mjs [--check] [--source FILE]
//   --check: generate into a temporary file and fail when it differs from the committed file.
//   --source: read another commands.ts (default: packages/model/src/commands.ts).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'packages/model/src/command-schema.json');
const args = process.argv.slice(2);
const check = args.includes('--check');
const sourceAt = args.indexOf('--source');
const source = sourceAt >= 0 ? args[sourceAt + 1] : join(root, 'packages/model/src/commands.ts');

const oneLine = s => s.replace(/\s+/g, ' ').trim();

/** The text of the last JSDoc block in `text`, lines joined with a space; '' when there is none. */
function lastJsDoc(text) {
    const blocks = [...text.matchAll(/\/\*\*([\s\S]*?)\*\//g)];
    if (!blocks.length) return '';
    return oneLine(blocks[blocks.length - 1][1].split('\n').map(l => l.replace(/^\s*\*?\s?/, '')).join(' '));
}

/** The type text of a member of a type literal or an interface: `name?: type`. */
const memberText = (m, sf) => `${m.name.getText(sf)}${m.questionToken ? '?' : ''}: ${oneLine(m.type.getText(sf))}`;

function commandSchema(file) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const text = sf.getFullText();
    const declared = new Map();   // name -> text, in source order
    let union;
    for (const s of sf.statements) {
        if (ts.isTypeAliasDeclaration(s)) {
            if (s.name.text === 'EditCommand') union = s.type;
            else declared.set(s.name.text, oneLine(s.type.getText(sf)));
        } else if (ts.isInterfaceDeclaration(s)) {
            declared.set(s.name.text, `{ ${s.members.map(m => memberText(m, sf)).join('; ')} }`);
        }
    }
    if (!union || !ts.isUnionTypeNode(union)) throw new Error(`${file}: no union type EditCommand`);
    const used = new Set();
    const collect = node => {
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && declared.has(node.typeName.text) && !used.has(node.typeName.text)) {
            used.add(node.typeName.text);
            const decl = sf.statements.find(s => (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) && s.name.text === node.typeName.text);
            ts.forEachChild(decl, collect);
        }
        ts.forEachChild(node, collect);
    };
    let prevEnd = union.pos;
    const commands = union.types.map(member => {
        if (!ts.isTypeLiteralNode(member)) throw new Error(`${file}: a member of EditCommand is not an object type: ${member.getText(sf)}`);
        const doc = lastJsDoc(text.slice(prevEnd, member.getStart(sf)));
        prevEnd = member.end;
        let kind;
        const fields = [];
        for (const m of member.members) {
            const name = m.name.getText(sf);
            if (name === 'kind') { kind = m.type.literal.text; continue; }
            fields.push({ name, type: oneLine(m.type.getText(sf)), optional: !!m.questionToken });
            collect(m.type);
        }
        return { kind, doc, fields };
    });
    const types = Object.fromEntries([...declared].filter(([name]) => used.has(name)));
    return JSON.stringify({ commands, types }, null, 2) + '\n';
}

const json = commandSchema(source);
if (check) {
    const dir = mkdtempSync(join(tmpdir(), 'command-schema-'));
    try {
        const fresh = join(dir, 'command-schema.json');
        writeFileSync(fresh, json);
        let committed = '';
        try { committed = readFileSync(target, 'utf8'); } catch { /* missing: stale */ }
        if (readFileSync(fresh, 'utf8') !== committed) {
            process.stderr.write('command-schema.json is stale: run pnpm gen:schema\n');
            process.exit(1);
        }
    } finally { rmSync(dir, { recursive: true, force: true }); }
} else {
    writeFileSync(target, json);
}
