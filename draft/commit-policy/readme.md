# Commit policy: decouple the git commit from the write

Handoff of the round that replaces "one write, one commit" with a scheduled commit. The orchestrator keeps this file. It is not committed unless the user asks.

## Vision

A write stays immediate (ADR 0003: the files are the model). A git commit is a record of a burst of work, not of one drag. The history of a workspace reads like a log of what the user did, and the user can name a commit with a checkpoint.

Evidence: EP-catenary-dprod has 2092 commits, 1502 of them `Catenary: setBounds` (72 %), about 1535 layout-only.

## Decisions (settled with the user, 2026-10-20)

| Decision | Choice |
|---|---|
| Trigger | 60 s after the last content edit, `dispose`, `open` of another workspace, `save()`. Fixed delay, no manifest setting. No view-switch trigger: the backend has no such signal. |
| Layout-only edits (setBounds, setLayout, setEdgeLayout) | Never start or restart the timer. They fold into the next commit. |
| Message | `Catenary: <kind ×N, …> (<view labels>)`, kinds by count, max 5 kinds, max 3 views. |
| Checkpoint | `ModelService.checkpoint(message)`, user text verbatim. Needs a repository, not `ws:autoCommit`. CLI through the generic `rpc`. Theia command `catenary.checkpoint` with an input box. |

## Open

- GIT2 in `spec/open.md`: `commitFiles` without `--cleanup=verbatim` (roborev 512). Candidate follow-up kata.
- Should an exec batch from an agent commit at once instead of at idle? Today: at idle, or `rpc save` / `rpc checkpoint` to force it.
- A commit on view switch needs a client signal (`view-session.ts`). Not planned.

## Katas

| Id | Title | Blocked by | Model, effort |
|---|---|---|---|
| gjem | Commit on idle, not on write: aggregated auto-commit message | – | done, merged f8ccae8 (Tests 1168, e2e 23, roborev 507 F→fixed, 508 P) |
| 7x4f | Checkpoint RPC: one commit with the user message | gjem | done, merged 2e505cf (Tests 1172, e2e 23, roborev 512 F, finding declined as out of scope) |
| jch1 | Theia command catenary.checkpoint with an input box | 7x4f | done, merged 76266c1 (Tests 1174, e2e 23, roborev 516 P) |

Round 1 complete 2026-10-20: main at 76266c1, verify passes (Tests 1174). All worktrees removed. Worktrees under the session scratchpad: `wt-<id>`, branch `kata/<id>-<slug>`. Merge locally in that order, verify main, then create the next worktree.

## Agent contract (short)

Work only in the worktree. `kata show <id>` is the task. `pnpm verify` (with `--e2e` when the kata says so). Commit with the kata id first. Wait for the roborev job, apply findings inside the kata text, comment the others. No push, no PR. Close with `kata close <id> --done --commit <sha>`, else label `needs-review`.
