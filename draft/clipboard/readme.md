# Clipboard semantics: assessment and proposal

Status: proposal, not implemented. Owner contracts: `spec/manifest.hs` §6.4, `spec/ui-manifest.hs` §4.4, §5.8, §7.5.

## What the code does today

Code: `modeler/src/browser/diagram/diagram-configuration.ts` (ViewCopyPasteHandler), `modeler/src/node/glsp/handlers.ts` (clipboard handlers), `packages/model/src/commands.ts` (copyFromView, ViewClip), `packages/rdf/src/commands.ts` (pasteIntoView, cutFromView), `packages/rdf/src/ops.ts` (copyInstance).

| Gesture | Model data | Placements | Notes |
|---|---|---|---|
| Ctrl+C, Ctrl+V | New instances: new IRI, label with the next numeric suffix, fields, owned values, relations between the copied instances | New placements near the pointer | The clip holds IRIs only. The paste reads the source instances at paste time. A deleted source is skipped without a message. |
| Ctrl+C, Ctrl+V of a node shape | Same shape, no copy | New placement | Opposite identity rule to an instance in the same gesture. |
| Ctrl+X | None | Removes the source placements at once (one undo step) | Without a paste it is the same as Del. The clip is pastable only in this window. |
| Ctrl+X, Ctrl+V | None | Adds the same elements to the target view (second undo step) | In the same canvas: a removal, then a re-placement at the pointer, two undo steps. The paste fails only when the target already shows every element, for example a second paste of the same cut. |
| Ctrl+V of RDF text | Adds missing statements, same IRIs | Figures that the notations derive | A third identity rule: same IRIs, no removal, additive data. |
| Copy as RDF | None | None | Writes Turtle to the system clipboard. Ctrl+C writes a JSON token instead. |
| Groups, notes | None (view data) | New boxes in both modes | Consistent. |
| Edges | | Copied sides, color; bends dropped | `ui-manifest.hs` line 1286 says bends are dropped and §7.5 says "no edge sides", but `pasteIntoView` passes sides through. The test at `copy-paste.test.ts:44` checks sides. The document is wrong, not the code. |
| Arrows, file references, property shapes | Omitted from the clip | | Silent. |

## Why the user cannot predict the result

1. One key pair, Ctrl+C then Ctrl+V, answers the question "same element or new element?" by a key that was pressed before, Ctrl+C or Ctrl+X. The answer is also different for instances and shapes.
2. The model edit (new instances) happens at paste time, not at copy time. The result depends on edits between the two keys.
3. Cut changes the source before the paste runs. A paste that fails (target shows every element), or that never comes, leaves the elements removed. A cut and its paste are two undo steps.
4. Three identity rules exist for a paste: new IRIs (copy), same IRIs (cut), same IRIs plus additive statements (RDF text).
5. No feedback states what happened: how many placed, how many skipped, how many copied.

## Proposal: two axes, each on its own control

Axis 1, identity: same element or new element. Axis 2, source placement: keep or remove.

Rule: **the clipboard carries references and never creates model data.** Only two explicit commands create data: Duplicate and Paste RDF.

| Gesture | Identity | Source placement | Command |
|---|---|---|---|
| Ctrl+C, Ctrl+V | Same elements | Kept | `addToView` with the clip layout (dimensions, color, display, edge sides). Elements already in the target are skipped. |
| Ctrl+X, Ctrl+V | Same elements | Removed at paste time | One command `moveBetweenViews`, one undo step. The cut only marks the clip and dims the source placements. Escape or a new copy clears the mark; nothing changes. |
| Ctrl+D, Edit → Duplicate | New elements | Kept | `duplicate`: `copyInstance` of each selected instance, placed beside the source in the same view, relations between the copies, same appearance. Selection moves to the copies. Node shapes: refused with a message until a shape copy exists. |
| Ctrl+V of RDF text | Same IRIs, additive statements | n/a | Unchanged (`pasteRdf`). |
| Copy as RDF | n/a | n/a | Unchanged. Ctrl+C also writes this Turtle as `text/plain`, so a paste in a text editor gives RDF, not a token. The clip token goes to a custom media type. |

Consequences:

- Instances and shapes follow one rule: a paste places the same element.
- Ctrl+C then Ctrl+V in the same canvas is a no-op with one message: "Already in this view. Duplicate (Ctrl+D) makes copies."
- Cut and paste cannot leave the source half done. `law_cutWithoutPasteChangesNothing`.
- The clip needs no snapshot: a reference is read at paste time by definition. A deleted element is skipped and counted.
- Transport. Ctrl+C and Ctrl+X write two entries to the system clipboard: the custom type `application/x-catenary-view-clip` with the clip ID, and `text/plain` with the Turtle of Copy as RDF. A paste in a canvas first looks for the custom type and resolves its ID in the window clipboard service. Found: reference paste (or move). Not found, or another window: the `text/plain` goes through Paste RDF, the explicit data command, with its rules (same IRIs, additive statements, named-graph consent). So a paste in another window never silently creates data: it is a Paste RDF, and the status line says so. A reference paste between windows stays unsupported (§5.8 `pastable`).
- Another model in the same window (workspace switch): the clip holds IRIs, so a reference paste places the IRIs that exist there and counts the rest as missing. Unchanged.
- Groups and notes are view data: a paste creates new boxes, a cut moves them. A frame moves with its contents.
- Every paste ends with one status line: "Placed 3. Skipped 2 already in this view. 1 missing from this model."

Open choices for the user:

1. Keep Duplicate in place (beside the source) or at the pointer. Proposal: beside the source, like Apply Layout keeps things predictable; the pointer is for paste.
2. Ctrl+D is free in `ui-manifest.hs` §4.4 `Key`. Confirm no Theia default conflicts (Theia binds Ctrl+D in text editors only).
3. Whether a paste of a copied group in the same view creates a second empty group (yes, it is view data) or is skipped.

## Changes if accepted

- `spec/manifest.hs` §6.4: replace the copy rule; add `Duplicate [Id] Id` and `MoveBetweenViews Id Id ViewClip (Maybe Point)` to `EditCommand`; drop `clipIsCut`, `law_pasteCopyMintsNew`; add `law_pasteNeverMintsIris`, `law_cutWithoutPasteChangesNothing`, `law_duplicateMintsNew`.
- `spec/ui-manifest.hs` §4.4: add `CtrlD -> Duplicate`; §5.8: one identity rule, status line; §7.5 and line 1286: fix the sides sentence.
- `packages/rdf/src/commands.ts`: `pasteIntoView` loses its copy branch; new `duplicate`, `moveBetweenViews`. `cutFromView` is removed.
- `modeler/src/browser/diagram/diagram-configuration.ts`: cut marks, paste sends the move; Ctrl+C writes Turtle as text.
- `spec/open.md` F-UNDO-1: remove "Cut and paste remain separate operations".
- `docs/user-guide.md` lines 76 to 81.
- Tests: `packages/rdf/test/copy-paste.test.ts` rewritten per table.

## Feedback of a cut

A cut marks the clip and the canvas shows the mark: the source placements and their edges dim to the inactive style of ADR 0015 (same as an inactive Links row), with a dashed outline. The mark stays until one of these events: a paste (the elements move), Escape on the canvas, a new Ctrl+C or Ctrl+X (the new clip replaces the mark), or a close of the window. Undo does not touch the mark: no command ran. The status bar shows "3 elements cut. Paste moves them. Escape cancels." A paste in the same canvas clears the mark with the message "Already in this view", nothing moves. The mark is window state (`CanvasHighlight`-like, `modeler/src/browser/diagram/`), not a model change, so it needs no command and no undo step.

## Paste of a Turtle fragment without prefix declarations

Case: the user copies a few lines from a model file in the text editor. The fragment uses `ex:`, `sh:`, `skos:` and has no `@prefix` lines. The parser fails and the message says "not valid RDF".

Fix, in `prepareRdfPaste` (`packages/rdf/src/clipboard.ts`), untyped text only (`text/plain`):

1. Parse the text as given. Success: done.
2. Failure: prepend one `@prefix` line per entry of the backend prefix table (`model-store.ts` snapshot `prefixes.table`, manifest §2.5) that the text does not declare, and parse again as Turtle, then TriG. Failure again: the existing "not valid RDF" message.
3. The paste records nothing about prefixes: the workspace table stays the single source (§2.5, "declarations in model files do not fill it").

Not proposed: a message that names the unknown prefixes, a fragment without a subject, and a `@base` for relative IRIs.

Test: `packages/rdf/test/rdf-clipboard.test.ts`, a fragment with `ex:` and `sh:` only, no `@prefix`, parses with the table; a fragment with an unknown prefix still fails.
