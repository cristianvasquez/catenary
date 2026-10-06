# Agent guide: Catenary

Theia + GLSP editor for RDF models. Files are the source of truth. One backend `ModelStore` indexes them with Oxigraph. Each `EditCommand` produces one undo step.

## Read first, and only this

- [docs/architecture.md](docs/architecture.md) sections **Packages** (import rules), **Code map** and **Testing** (which test layer to use). Read other documents only when the task needs them.
- [spec/open.md](spec/open.md) for unresolved decisions, defects and unfinished checks.
- Do not read whole directories to orient yourself. Use the code map to go to the file.

## Documentation

- Keep data and transaction contracts in `spec/manifest.hs`. Keep interaction contracts in `spec/ui-manifest.hs`.
- Keep unresolved decisions and implementation gaps in `spec/open.md`. Do not change a contract merely to match the code.
- Keep commands and the documentation map in `readme.md`. Keep packages, the code map and test guidance in `docs/architecture.md`. Keep user-visible behavior in `docs/user-guide.md`.
- Record a design rule in the manifest that owns it, with a one-line reason. A rule that code cites by number goes in the "Design rules" index at the top of `spec/manifest.hs`. Do not add decision records or one file per decision.
- Documents in `docs/` are for people: short, current state only, no history. The manifests are the full contract for agents.
- Do not add journals, status inventories or feature specs. Git history holds work records. `spec/open.md` holds what is not finished.
- A handoff of unfinished design work goes in the `readme.md` of its folder under `draft/`. The next agent starts there.
- The manifests are Haskell modules. `pnpm check` typechecks them with GHC (`scripts/check-manifests.mjs`), so a name or type that does not match fails. Each new signature needs a stub in the "Compile-only stubs" section at the end of its file. Write a rule as an equation when it fits, not as a stub.

## Simple English

Apply ASD-STE100-style prose to technical documentation. These rules do not change code, identifiers, schemas or command syntax.

- Use one name per concept and one meaning per word. Prefer short, common words and American spelling.
- Use active voice and direct verbs. Remove marketing adjectives, nominalizations, stacked auxiliaries and unnecessary phrasal verbs.
- Give one instruction per sentence. Limit instructions to 20 words and descriptions to 25 words.
- Use articles. Do not use contractions or semicolons. Prefer a simple tense over an unnecessary continuous tense.
- Keep one topic per paragraph, with at most six sentences. Do not insert line breaks within a prose paragraph.
- Use numbered steps with one imperative action per item. Put a condition before its command.
- Apply all rules to procedures and error messages. General reference prose can use technical words beyond the STE dictionary.
- Before delivery, check sentence length, punctuation, voice and terminology. Split sentences over 20 words when practical.
- A mechanical check cannot certify technical accuracy or full STE compliance.

## No blank nodes

Catenary does not work with blank nodes. The read skolemizes each blank node immediately, and after that every node is an IRI. Do not write code that handles blank nodes, keeps them, or writes them back. If you find such code, remove it as part of your change and simplify what depends on it. Catenary is a drafting environment: simplicity is more important than round-trip fidelity of blank nodes.

## Before you change code

1. `git status --short`. Other agents can work in this tree at the same time. Do not revert, reformat or "fix" changes that you did not make.
2. If `pnpm check` fails in files that you did not change, report it and stop. Do not work around it.

## Done means

Run `pnpm verify` (check → test → build; stops at the first failure) and show its summary lines in your report. Add `--e2e` when you changed browser wiring. A step that you did not run is "not verified", not "passed". Do not chain commands in a way that hides a failed build (`a; b`); `pnpm verify` stops for you.

Keep a test at the lowest layer that detects the failure (docs/architecture.md → Testing). Browser steps only for gestures and rendering.

## Test the running app with the CLI

Never test in `workspace/`: it is the user's data. Use a copy and your own port:

```sh
cp -r workspace "$SCRATCH/ws"
(cd app && exec node lib/backend/main.js "$SCRATCH/ws" --hostname 127.0.0.1 --port 3917) > "$SCRATCH/backend.log" 2>&1 &
pnpm -s catenary --port 3917 status        # build.stale / build.restartNeeded / windows[].reloadNeeded must be false
pnpm -s catenary --port 3917 rpc open "\"$SCRATCH/ws/demo/library.trig\""   # the backend starts with an empty model; the argument is JSON
```

Several backends can run at the same time, for example the user's desktop instances. Always give `--port` or `CATENARY_PORT`. Without them, the CLI can select a backend of the user. To list the running backends, run `pnpm -s catenary status` without `--port`: with several backends, the error lists ports and workspaces.

Commands that need no window: `status`, `model`, `rpc`, `exec`. The UI commands (`commands`, `run`, `prompt`, `answer`, `ui`, `messages`, `eval`) need a browser window: a headless Chromium page (`playwright-core`, `/usr/bin/chromium`) on the same port is enough. See readme → Command-line interface. Stop the processes you started, by PID. `pkill -f <pattern>` can match your own shell.

## Assertions

- RDF files: query with the `rdf` CLI (`rdf read f.ttl | rdf select --query-file q.rq`). No grep on RDF, no assumptions about prefixes or text layout.
- Text in the UI: exact match. `hasText: 'relation'` also matches `qualifiedRelation`.
- A claim in your report needs the output that shows it.

## At the end

- Update the document that owns a changed rule. Update `readme.md` for command changes and `docs/architecture.md` for file map changes. Use lowercase `readme.md`.
- Report what changed, what was verified (with numbers) and what is open. Put open items in `spec/open.md`, and remove items that are done.
- Commit only when the user asks.
