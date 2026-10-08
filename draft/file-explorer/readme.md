# File-scoped Model explorer

## Completed implementation

- Added **Open in Model Explorer** to the file navigator. Each file has a reusable dockable tree.
- Scoped tree rows by source-file statements. References alone do not add a resource to the file scope.
- Added ordered-character fuzzy matching, ranking, highlights and visible ancestors. Clearing the filter restores expansion state.
- Replaced folder-to-instance creation with folder-content dragging. Folder contents include hidden descendants and exclude duplicates.
- Added one-command placement of mixed explorer selections on a canvas.
- Added file-tree drops with count and destination confirmation. Transfers move only source-file statements and preserve other origins and IRIs.
- Extended history with provenance changes. File transfers support undo, redo and persistence.
- Added read-only checks. Structural shape nodes move with their parent. Transfers reject nested shapes with unselected parents.
- Updated contracts, user guidance, the architecture map and command documentation.

## Verification

`pnpm verify --e2e` passed:

```text
ok   check    4.9s
ok   test    19.2s  686 passed (686)
ok   build   10.2s
ok   e2e     84.7s  10 passed, 0 failed
verify: passed (check, test, build, e2e).
```

Logs: `/tmp/catenary-verify-iZEgko`.

The browser test covers the context menu, fuzzy highlights, hidden folder contents, canvas placement, widget reuse, file transfer and undo. Unit tests cover source scoping, deduplication, persistence, duplicate origins, relation-only transfers, shape transfers and imported-file refusal.

## Limits

The filter uses fzf-style matching, not the fzf query language. View files are not transfer destinations. Large-workspace filtering remains unprofiled. Existing cross-file write rollback and nested-resource ownership gaps remain in `spec/open.md`.

No commit was made. A running application needs a restart to load this build.
