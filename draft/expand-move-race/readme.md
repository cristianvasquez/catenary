# Expand, then move at once: the card goes back

Report of the user: expand a card from another one (halo arrow, `expandOut`), drag the new card at once, and after about one second the card goes back to its first position.

## What is known

- The expand runs through RPC (`actions.ts` `expand` → `showRelations` → `executeAndSelect` → `model.execute`). The move runs through the GLSP session (`handlers.ts` `ChangeBoundsHandler` → `ViewSession.edit` → `setBounds`). Both reach the same store.
- `executeAndSelect` (`actions.ts:450`) waits with `whenShown(w, select)` (`view-editors.ts:342`) on the raw ids of the command (relation ids for `showRelations`, instance ids for `addToView`). The diagram index holds placement ids, so the wait always ends at its 2 s timeout, then `selection.set` runs. Line 441 of the same file already uses `whenPlaced` for this reason. `uncollect` (`actions.ts:591`) has the same call.
- `repro.cjs` (this folder) reproduces the gesture: own backend on a copy of `examples/bookshop`, headless Chromium, halo expand, pick one neighbor, drag at once, sample the card position for 4 s, log the GLSP frames. Run: `SCRATCH=<dir> node draft/expand-move-race/repro.cjs` (needs `pnpm build`). `DRAG_DELAY=3000` delays the drag; `DX`, `DY` set the drag start inside the card.
- Result in this setup: the move reaches the store (`rpc view` shows the new x, y), the card stays. At +2 s after the expand update the selection fires and the Properties panel re-lays out: the canvas shifts by about 11 px, no card moves.
- The jump back was seen once, when the drag ended outside the viewport: no ChangeBounds operation was sent, and the next render reset the move feedback. The user's case is not reproduced.

## Not tested

- A workspace that is a git repository (each write runs `git add` and `git commit`, `saver.ts`, `git.ts`). The user's workspaces are git repositories; the scratch copy is not.
- Validation that changes the report (reason `validation` → `ViewSession.refresh`) and a larger model. The bookshop model sends no refresh after the expand.
- The Electron app.
