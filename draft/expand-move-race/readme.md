# Expand, then move at once: the card goes back

Report of the user: expand a card from another one (halo arrow, `expandOut`), drag the new card at once, and after about one second the card goes back to its first position.

## What is known

- The expand runs through RPC (`actions.ts` `expand` → `showRelations` → `executeAndSelect` → `model.execute`). The move runs through the GLSP session (`handlers.ts` `ChangeBoundsHandler` → `ViewSession.edit` → `setBounds`). Both reach the same store.
- Before kata rkyk, `executeAndSelect` waited with `whenShown` on raw ids, so the selection came at the 2 s timeout. Since rkyk (merge 803fe81) it waits with `whenPlaced`: in the runs below the selection of the new card comes 50 to 180 ms after the expand update.
- `repro.cjs` (this folder) reproduces the gesture: own backend on a copy of `examples/bookshop`, headless Chromium, halo expand, pick one neighbor, drag at once, sample the card position for 4 s, log the GLSP frames. Run: `SCRATCH=<dir> node draft/expand-move-race/repro.cjs` (needs `pnpm build`). Environment:
  - `CATENARY_ROOT`: the checkout whose build runs (default: the repository of the script). `PREFIX`: the name prefix of the run folder in `SCRATCH`.
  - `GIT=1`: the copy is a git repository with one commit. `AUTO_COMMIT=1`: `ws:autoCommit` on, so each write commits.
  - `VALIDATION=1`: validation mode "views". The expand then changes the violations of the view (see Results). `VALIDATION_DATA=1` also changes the data and shapes (not used in the results).
  - `FAST=1`: no CLI call, screenshot or DOM probe between the new card and the drop. The drop then comes about 80 ms after the card shows.
  - `DRAG_DELAY=<ms>` delays the drag. `DX`, `DY` set the drag start inside the card.
- The script prints, relative to the drop: the backend spans (`command`, `file`, `change`, `validation run`, `view <label>`, `read changed files`), the selection changes (hook on `ctx.selection.onDidChange`, no GLSP select frame is sent), the card position at each animation frame, the GLSP frames, and the new card position in each `setModel`/`updateModel`. It also prints the store box before and after, the git log of the copy and the load average.
- Result before kata rkyk, in the non-git setup: the move reaches the store (`rpc view` shows the new x, y), the card stays. At +2 s after the expand update the selection fires and the Properties panel re-lays out: the canvas shifts by about 11 px, no card moves.
- The jump back was seen once, when the drag ended outside the viewport: no ChangeBounds operation was sent, and the next render reset the move feedback. The user's case is not reproduced.

## Results

Kata ayb7, worktree build of 803fe81 (after rkyk), headless Chromium, copies of `examples/bookshop`. Times are in ms relative to the drop. Drag: 400 px left, 200 px down on the screen. "Load" is the 1-minute load average at the start of the run (other agents ran e2e tests on the machine).

| Run | Setup | Load | Store kept the move | Screen position changed after the drop | Frames and spans after the expand |
|---|---|---|---|---|---|
| a | no git | 7.07 | yes: (820,240) → (420,440) | no (last change at -32, the drag) | expand update -351 (820,240); ChangeBounds +1; update +9 (420,440). No further update. |
| b | git, auto-commit off | 2.82 | yes: → (420,440) | no (last change at -37) | Same frames as a. No `file commit` span. The git log has only the first commit. |
| c | git, auto-commit on | 6.22 | yes: → (420,440) | no (last change at -33) | Same frames as a. `file commit` -324 (+32 ms) and +10 (+29 ms). |
| d | c + validation "views" | 1.21 | yes: → (160,570) | no (last change at -33) | Validation run -103, `change validation` (5 elements) -90, `view Repro` refresh -90, update rev 3 at -86 with the old position (820,240), during the drag. ChangeBounds +1, update rev 4 at +9 (160,570). |
| e | d + FAST | 1.18 | yes: → (160,570) | no (last change at +6, the drop frame) | Update +11 (160,570). Validation run +107, refresh +121, update rev 4 at +127 with the new position (160,570). |
| f50 | e + DRAG_DELAY 50 | 0.82 | yes: → (160,570) | no (last change at +3) | Update +12 (160,570). Validation run +38, update rev 4 at +62 with the new position. |
| f100 | e + DRAG_DELAY 100 | 0.78 | yes: → (420,440) | no (last change at +6) | Validation run -13 found 0 violations, `change validation` with 0 elements, no refresh. Update +11 (420,440). |
| g | c + FAST, local git identity in the copy (roborev 142) | 1.16 | yes: → (160,570) | no (last change at +3) | Expand update -144 (820,240); update +10 (160,570). Commits by the local identity "repro". |

- In runs d, e, f50 and f100 the canvas scale differs: when the first open puts the halo arrow under the Properties panel, the script zooms out with one wheel step (scale 0.61). The drag then moves the card to (160,570) in the model.
- No run has a `read changed files` or `own write` span: no watch event reached the backend in the 4 s after the drop.
- Run d shows that a validation refresh can send a model with the old position during the drag. The move tool feedback keeps the card under the pointer, and the ChangeBounds goes after it. Each model after the drop has the new position, because the server builds it from the store after `setBounds`. Thus `pending-bounds` never had to hold a move against a stale model in these runs.
- The selection of the new card comes 50 to 180 ms after the expand update (a: 158 ms, d: 182 ms, e: 54 ms). With FAST=1 it comes during the drag. It does not move the card.

Result: negative, 8 runs. The jump back is not reproduced with a git repository, with auto-commit, or with a validation refresh before or after the drop.

## Next things to try

1. The Electron app, with the user's settings: `ws:autoCommit`, the validation mode and the size of the model. Ask the user for these values; do not open the user's folders.
2. A watch event close to the drop: a write by another program (editor, sync tool, git hook) to a model or view file. It gives a `read changed files` span and a `disk` change (rebuild). A view file read from disk before the `setBounds` write would carry the old position.
3. A stale model after the confirmation: `PendingBoundsState.apply` deletes the entry when a server model has the sent bounds. A later model with the old bounds is then shown. A unit test on `pending-bounds-state.ts` can show the order "confirm, then stale model". The backend would need a refresh that builds its model before `setBounds` and sends it after the update of `setBounds`.
4. A `setBounds` confirmation later than 3 s under load (`TIMEOUT` in `pending-bounds-state.ts`): the client then shows the server model, which can still have the old position.
5. A drag that ends outside the viewport: no ChangeBounds is sent (seen once before rkyk).

## Not tested

- The Electron app.
- A model larger than the bookshop example.
- An external change of a model file during the gesture.
