# Publish the Catenary vocabularies

Handoff for the kata round that makes the Catenary vocabularies dereferenceable on the GitHub Pages site, and moves every reference from the `osg://vocab/…` namespaces to the published ones.

## Vision

A view file, a workspace file or a notation file uses IRIs such as `osg://vocab/view#element`. Nothing resolves them. After this round, the same term is `https://cristianvasquez.github.io/catenary/vocab/view#element`. A browser that opens the namespace gets a page that documents each term. A tool that fetches the Turtle gets `vocab/view.ttl`. The site already deploys on each push to `main` (`.github/workflows/pages.yml`), so publishing the vocabulary is one more set of files under `www/`.

## What exists

| Namespace | Terms defined in | Used by (files outside tests) |
|---|---|---|
| `osg://vocab/view#` | nowhere as RDF; `NS.view` in `packages/model/src/terms.ts` | all view files, the five notations, `spec/manifest.hs`, `scripts/e2e.cjs` |
| `osg://vocab/workspace#` | nowhere as RDF; `NS.ws` in `terms.ts`, `workspaceNamespace` in `spec/manifest.hs` line 201 | every `workspace.trig`, `examples/bookshop/workspace.trig` |
| `osg://vocab/notation#` | `docs/notation/notation.ttl` (RDFS, documented), `NT()` in `packages/model/src/notation-graph.ts` | the five notations in `packages/rdf/notations/`, `packages/shacl/notations/shapes.ttl`, `docs/notation/catenary.shapes.ttl` |
| `osg://vocab/notation/shapes#`, `…/skos#`, `…/classes#`, `…/instances#`, `…/marks#` | the notation files themselves; `SHN`, `VSN` in `packages/model/src/notation-schema.ts` | notations, `view.trig` placements that name a figure class |
| `osg://vocab/data-product-draft#` | `examples/bookshop/workspace.trig` prefix `dpm`, `shapes-doc.ts` line 183 | an example domain, not a Catenary vocabulary: out of scope |
| `osg://vocab/trellis-model#`, `…/trellis-ui#` | legacy, kept by `spec/manifest.hs` line 450 | out of scope |

Counts of `osg://vocab` on 2026-10-13: 88 `view#`, 43 `workspace#`, 13 `notation#`, 24 in the five notation sub-namespaces. Files: 2 in `packages/model/src`, 2 in `packages/rdf/src`, 5 notations, 2 in `docs/notation`, 3 in `examples/bookshop`, 3 in `spec/manifest.hs`, 1 in `scripts/e2e.cjs`, and 52 test files and fixtures under `packages/*/test`.

User data: 3 files in `~/.local/share/catenary/workspaces` and 36 `.trig`/`.ttl` files elsewhere under `~/os` use the old namespaces. They are not in this repository. They need the migration tool of kata 3.

Precedent: `spec/manifest.hs` line 450 keeps the legacy `osg://vocab/trellis-*` terms on read. A read-time alias of the old namespaces follows the same rule.

## Decisions

Settled with the user on 2026-10-13: the first option of each item.

1. **Namespace base.** `https://cristianvasquez.github.io/catenary/vocab/<name>#`. A `w3id.org` redirect (`https://w3id.org/catenary/<name>#`) is stabler across hosts, but needs a pull request to the w3id repository before anything resolves. Recommendation: GitHub Pages now; a w3id redirect later is a second rename with the same tool.
2. **Hash or slash.** Hash. Each vocabulary is one small file, one page, and the terms are anchors on it. GitHub Pages cannot do content negotiation, so a slash namespace would gain nothing.
3. **Which vocabularies.** `view`, `workspace`, `notation`, and the five notation sub-namespaces as one file `notation-figures`? Or keep the five as they are, at `vocab/notation/shapes#` and so on? Recommendation: keep the five paths as they are, under `vocab/notation/`, so a rename is mechanical.
4. **Publication format.** For each vocabulary: the Turtle file at `www/public/vocab/<name>.ttl`, and a page `www/vocab/<name>.md` generated from the Turtle by a script (`scripts/www-vocab.mjs`), with one heading per term, its type, its comment, its domain and range. The namespace IRI without a fragment resolves to that page. A `view` and a `workspace` vocabulary do not exist as RDF today: kata 1 writes them from the code that uses the terms.
5. **Migration of existing files.** Three options:
   - (a) Read-time alias only: the reader maps the old namespace to the new one, files keep the old text until the next write of that file. Simple, but a file that is never written stays old, and a grep of the workspace shows both.
   - (b) One-shot rewrite on open: when a workspace opens and a file contains an old namespace, Catenary rewrites the prefix lines and the full IRIs of that file and writes it back once, with a message. Deterministic, but it writes files that the user did not edit (and commits them in a Git workspace).
   - (c) A CLI command `catenary migrate-vocab <folder>` that rewrites the files, plus a read-time alias so an old workspace still opens. The user runs the command when they want.
   Recommendation: (c). It keeps writes explicit, and the alias keeps old drafts readable.
6. **Old namespace after the change.** The alias stays for one release, then goes. Record it in `spec/manifest.hs` next to the Trellis rule, with the removal condition.

## Katas

Katas 1 and 2 touch different files and run in parallel. Kata 3 depends on kata 2 (it uses the new namespaces and the alias).

| Kata | Title | Blocked by | Model, effort |
|---|---|---|---|
| K1 | Vocabulary files and their pages on the site | none | opus, medium |
| K2 | Rename the namespaces in code, notations, examples, manifest and tests; read-time alias | none | opus, medium |
| K3 | `catenary migrate-vocab` and the migration note on the site | K2 | opus, low |

### K1. Vocabulary files and their pages on the site

**Goal.** Publish the Catenary vocabularies as Turtle and as documentation pages under `www/vocab/`. No behavior change in the application.

**Context.** `docs/notation/notation.ttl` is the only vocabulary that exists as RDF (RDFS classes and properties with `rdfs:comment`, 13 terms under `osg://vocab/notation#`). The `view` terms are the string constants that `packages/model/src/terms.ts`, `packages/rdf/src/view-read.ts`, `packages/rdf/src/queries.ts` and the notations use with the `NS.view` prefix: list them with `grep -rhoE "view:[A-Za-z]+" packages/rdf/src packages/rdf/notations | sort -u`. The `workspace` terms are the `ws:` terms of `packages/rdf/src/settings.ts` and `files.ts`. The site is VitePress under `www/`; static files live in `www/public/`; the sidebar is in `www/.vitepress/config.mts`; `pnpm www:build` checks dead links. Kata 2 renames the namespaces in code at the same time: do not touch `packages/`, `spec/` or `examples/`. Use the new namespace base `https://cristianvasquez.github.io/catenary/vocab/` in the files that this kata writes.

**Do.**
1. Write `www/public/vocab/view.ttl`: one `rdfs:Class` or `rdf:Property` per term, with `rdfs:label`, `rdfs:comment` in Simple English, `rdfs:domain` and `rdfs:range` where the code fixes them. Declare the vocabulary as an `owl:Ontology` with `dct:title` and `dct:license`.
2. Write `www/public/vocab/workspace.ttl` the same way.
3. Move `docs/notation/notation.ttl` to `www/public/vocab/notation.ttl`, with the new namespace. Keep `docs/notation/catenary.shapes.ttl` in place, with the new prefix.
4. Do not copy the five notation files of `packages/rdf/notations/` or `packages/shacl/notations/shapes.ttl`: they are notations, not vocabularies. Their namespace declarations change in kata 2.
5. Write `scripts/www-vocab.mjs`: reads each `www/public/vocab/*.ttl` with the project's RDF reader (`packages/rdf-files`), and writes `www/vocab/<name>.md`: title, the namespace, a link to the Turtle, then one `##` per term with the anchor equal to the local name, the type, the comment, domain and range. Add the script as `www:vocab` in the root `package.json`, and run it in `.github/workflows/pages.yml` before the build.
6. Add a **Vocabularies** group to the sidebar in `www/.vitepress/config.mts` and a line in `www/what-is-catenary.md` under "Where to go next".
7. Update the documentation map in `readme.md` (the "Notation vocabulary" row) and the `docs/` links that pointed to `docs/notation/notation.ttl`.

Out of scope: any change under `packages/`, `spec/`, `examples/`, `scripts/` other than the new script.

**Done when.**
- `pnpm www:vocab && pnpm www:build` passes with no dead link.
- `www/vocab/view.md`, `workspace.md` and `notation.md` exist, and each term of the Turtle has a heading. Report the term counts.
- `pnpm check` passes (links, boundaries).
- `grep -rn "docs/notation/notation.ttl" --include='*.md' . | grep -v node_modules` finds nothing.

### K2. Rename the namespaces and keep a read-time alias

**Goal.** Every Catenary namespace in code, notations, examples, manifest and tests uses the published base. A file with the old namespace still opens, and is written with the new one.

**Context.** The namespaces are defined in `packages/model/src/terms.ts` (`NS.view`, `NS.ws`), `packages/model/src/notation-graph.ts` line 14 (`NT`), `packages/model/src/notation-schema.ts` line 25 (`SHN`, `VSN`), and as prefix lines in the five files of `packages/rdf/notations/`, `packages/shacl/notations/shapes.ttl`, `docs/notation/catenary.shapes.ttl`, `examples/bookshop/workspace.trig` and its two views, `spec/manifest.hs` lines 183 and 201, and `scripts/e2e.cjs`. Tests and fixtures: 52 files under `packages/*/test` (`grep -rl "osg://vocab" packages/*/test | wc -l`). Reads go through `packages/rdf-files` (the parser) into `packages/rdf/src/loader.ts`. The legacy Trellis rule in `spec/manifest.hs` line 450 is the precedent for an alias. Kata 1 writes files under `www/` at the same time: do not touch `www/`. `osg://vocab/data-product-draft#` and the `trellis-*` namespaces stay as they are.

**Do.**
1. Change the four constants in `packages/model/src` to the new base `https://cristianvasquez.github.io/catenary/vocab/`, with the paths `vocab/view#`, `vocab/workspace#`, `vocab/notation#`, `vocab/notation/shapes#`, `vocab/notation/skos#`, and the same for `classes`, `instances`, `marks`.
2. Replace the prefix lines and full IRIs in the notation files, `docs/notation/catenary.shapes.ttl`, the example workspace and views, `scripts/e2e.cjs`.
3. Add a read-time alias in the loader: a term whose IRI starts with one of the old namespaces is read as the new IRI. Put the old-to-new table in one exported constant in `packages/model/src/terms.ts` (`LEGACY_NAMESPACES`). The alias applies to model files, view files and the workspace file. Writes always use the new namespace. A view keeps its graph IRI (not in these namespaces).
4. Add the rule to `spec/manifest.hs` next to line 450: one prose line with the reason, the equation `legacyNamespaces`, and a law `law_legacyNamespaceRead` (a read of a file with an old term yields the new term). Change `workspaceNamespace` on line 201.
5. Add a test in `packages/rdf/test/` that opens a fixture with the old namespaces (one workspace file, one view file) and checks: the model has the new terms, a write of each file uses only the new namespace, and the view graph IRI is unchanged. Cite the law.
6. Replace the old namespaces in the other test files and fixtures with `sed`, then run the tests. A test that checks the old text literally is changed to the new text.
7. Update `AGENTS.md` only if a rule there names the namespace (grep first).

Out of scope: `www/`, the migration CLI (kata 3), the `dpm` and `trellis` namespaces.

**Done when.**
- `pnpm verify` passes. Report the test count before and after (the new test adds at least 1).
- `grep -rn "osg://vocab/\(view\|workspace\|notation\)" --include='*.ts' --include='*.tsx' --include='*.ttl' --include='*.trig' --include='*.hs' --include='*.cjs' --include='*.mjs' . | grep -v node_modules | grep -v LEGACY_NAMESPACES | grep -v "test/fixtures/legacy"` finds nothing.
- `pnpm check:manifests` passes when GHC is present, or reports the skip.
- `pnpm e2e` passes (the browser smoke test uses the workspace namespace).

### K3. The migration command and its note on the site

**Goal.** A user can rewrite an existing workspace from the old namespaces to the published ones with one command, and the site says how.

**Context.** Kata 2 added `LEGACY_NAMESPACES` in `packages/model/src/terms.ts` and the read-time alias. The CLI is `scripts/catenary.mjs` (backend commands) and the readme section "Command line interface". `packages/rdf-files` reads and writes the supported formats and keeps the text of a file for patches (`text-patch.ts`). The user has 3 workspaces in `~/.local/share/catenary/workspaces` and about 36 more files under other folders; this kata does not touch them, it only provides the tool.

**Do.**
1. Add `scripts/migrate-vocab.mjs`: `node scripts/migrate-vocab.mjs <folder> [--dry-run]`. It walks the folder (same file set as the model: the supported RDF extensions, not hidden, not `node_modules`), reads each file as text, replaces each old namespace by its new one in prefix declarations and in full IRIs (`<osg://vocab/view#…>`), and writes the file back only when it changed. It prints one line per changed file and a total. `--dry-run` prints without writing. It does not parse the RDF: a text replacement is enough because the old namespaces are unique strings, and it keeps formatting and comments.
2. Register it as `pnpm migrate-vocab` in the root `package.json`.
3. Add a test in `packages/rdf/test/` or `scripts/` (where the other script tests are) with a temporary folder: two files with old terms, one without; after the run, the first two contain only new terms, the third is byte-identical, and a second run changes nothing.
4. Write the note on the site: `www/reference/workspace.md`, a section **Old namespaces** after "Locked files and import": what changed, that an old workspace still opens, and the command. Simple English, numbered steps.
5. Add the command to the readme "Run" block, one line.

Out of scope: running the command on the user's folders; the packaged desktop app (the command is a repository script).

**Done when.**
- `pnpm verify` passes; report the test count.
- `node scripts/migrate-vocab.mjs packages/rdf/test/fixtures --dry-run` reports 0 changed files (kata 2 already renamed them), except the legacy fixture of kata 2 which it must report.
- `pnpm www:build` passes.

## Agent contract (short)

One worktree per kata under the scratch folder, branch `kata/<id>-<slug>`, `pnpm install --prefer-offline --frozen-lockfile`, work from `kata show <id>`, `pnpm verify`, commit with the kata id first, wait for the roborev job, apply findings inside the kata text, comment the others, `kata close --done` with the commit, no push, no pull request.

## Status

All three katas closed and merged into main on 2026-10-13: nh68 `3b69791`, kebm `d977aa7`, q429 `47d2809`. The read-time alias of the old namespaces stays for one release (decision 6). The user's own workspaces are migrated with `pnpm migrate-vocab`; the example workspace copy under `~/.local/share/catenary/workspaces/example` opens through the alias until it is saved or migrated.
