# Risk-based CI profiles (proposal)

Status: proposal, not implemented. The next agent starts here. Decision row: `CI1` in [spec/open.md](../../spec/open.md).

The current pipeline runs almost the same checks for each change. A one-line CSS change and a change of the file writer both wait for the full unit suite and two webpack builds. At the same time, some high-risk changes get less than they need: the browser tests never run in CI, and the release publishes packages that no job started. This proposal gives each change a risk profile. The profile selects the checks. Low-risk changes get fast feedback, and data, API, security and packaging changes get more validation than today.

## 1. Current state, measured

Source: GitHub Actions runs 40 to 60 of `ci.yml`, Windows runs 10 to 15, Release runs 4 to 6 (all from 2026-10-07). Job `verify` of run 59 (`3dcb616`) gives the step times.

| Step of `ci.yml` | Time | Notes |
|---|---|---|
| Runner setup, apt headers, Node | 25 s | The apt step installs X11, xkbfile and libsecret headers for native Theia modules. |
| `pnpm install --frozen-lockfile` | 43 s | Includes `postinstall`: drivelist build, Electron download, VS Code plugin download. |
| `pnpm verify` → `check` | 42 s | Import rules, GHC on the manifests, rdf-serialization build, `tsc -b`, test typecheck. |
| `pnpm verify` → `test` | 157 s | 572 Vitest tests in 75 files, 2 workers on CI. |
| `pnpm verify` → `build` | 37 s | `tsc -b` again, then `theia build` for `app` and `electron-app`. |
| **Total wall time** | **4.5–5.5 min** | Same for every change. |

### 1.1 Redundant runs

| Finding | Evidence | Cost |
|---|---|---|
| `ci.yml` runs on `push` and on `pull_request`. A commit on a PR branch runs CI twice on the same SHA. | Runs 53/54 (`0edded1`), 55/56 (`61bea66`), 46/47 (`7884592`), 42/43 (`c5b6cac`). | One duplicate run of 5 min per PR commit. |
| A version tag runs `ci.yml` again on a SHA that is already green on `main`. | Run 59 (`main`) and run 60 (`v0.1.0`), both `3dcb616`. | 4 min per release. The release does not wait for it anyway (see 1.3). |
| `release.yml` runs on each branch push that changes `release.yml` or `scripts/package.sh`. It builds five packages and signs two macOS apps. | Release runs 4 and 5, about 6 min each, on non-tag branches. | About 6 min of Linux and 2 macOS jobs per branch push. |
| A manual dispatch of `windows.yml` and its `pull_request` trigger run on the same SHA. | Runs 12 and 13 (`7884592`). | 4 min of Windows runners. |
| The same SHA is built up to three times: in `ci.yml`, in the `windows.yml` package job and in `release.yml`. | Runs 59, Windows 15 and Release 6 on `3dcb616`. | Each build repeats install and `theia build`. Packages are not built once and promoted. |

### 1.2 Checks whose cost does not match the risk

| Check | Problem |
|---|---|
| Full Vitest suite (157 s) for every change | 48 of 75 test files are in `packages/rdf/test`. A change in `modeler/src/browser` cannot change the behavior of `@catenary/rdf`: `scripts/check-boundaries.mjs` forbids imports from `modeler` into the packages. The suite still runs them. The palette PR (#10) ran CI 5 times (runs 52–56) for two CSS lines and one color constant: about 25 runner minutes. |
| `electron-app` webpack build in every PR | No PR job starts the Electron app on Linux. The build only proves that the bundle compiles. That matters for `electron-app/` and `modeler/src/electron-main/`, not for a CSS or model rule change. |
| `scoped-doc.test.ts` and other fixture-wide tests | They compare store answers with the oracle for every view of every fixture. Several commits only adjust their timeouts (`b98db69`, `16763ca`, `51b09da`, `3572e6c`). They protect the queries of `@catenary/rdf`, so they belong to changes of that package and its dependencies only. |
| `postinstall` in every job | A docs or CSS job does not need Electron, drivelist or the VS Code plugins. The Windows `unit` job already uses `--ignore-scripts`. |

### 1.3 Gaps: risk without a check

| Gap | Consequence |
|---|---|
| `scripts/e2e.cjs` never runs in CI. | Browser wiring of gestures and rendering is checked only when an agent remembers `pnpm verify --e2e`. |
| The Windows path filter lists only packaging files. | A change of `packages/model/src/paths.ts` or `packages/rdf-files/src/paths.ts` does not start the Windows unit tests. The first Windows run found real path defects (`4fd0059`). |
| `release.yml` does not depend on a green CI result. | A tag on a red commit publishes packages. |
| The release does not start the packages that it publishes. | The Windows smoke test runs on a different build in `windows.yml`. The Linux tar.gz, the AppImage and the macOS apps never start in CI. |
| No check of the CLI and RPC contract against a running backend. | `protocol.ts`, `cli-protocol.ts` and `cli-endpoint.ts` are checked only by types and unit tests. |
| Changes to non-code inputs are invisible to an import graph. | Fixtures, `packages/rdf/notations/*.ttl` and `patches/*.patch` change behavior without a changed TypeScript import. |

## 2. Profiles

Five change profiles, ordered by risk. Each profile includes all checks of the lower profiles that apply. A release is a separate pipeline (section 6.4), not a change profile.

| Profile | Risk | Typical content |
|---|---|---|
| `docs` | No runtime effect | Markdown in `docs/`, `readme.md`, `spec/open.md`, `draft/`, `LICENSE` |
| `cosmetic` | Visual only, no logic | `modeler/css/**`, images |
| `standard` | Application behavior | `modeler/src/browser/**`, `packages/model/src/**` (except API files), the manifests, `examples/**`, tests |
| `critical` | Data on disk, API, security | `packages/rdf/**`, `packages/rdf-files/**`, `packages/rdf-serialization/**`, `patches/**`, protocol, CLI, edit commands, snapshot schema, `modeler/src/node/**` |
| `platform` | Build, packaging, dependencies, CI | `pnpm-lock.yaml`, `package.json` files, `pnpm-workspace.yaml`, `.node-version`, `electron-app/**`, `modeler/src/electron-main/**`, `scripts/package.sh`, `.github/**`, the profile rules |

## 3. Decision matrix

● = blocking. ○ = runs, does not block the merge. M = runs on `main` after the merge (blocks the release, see 6.3). – = does not run. Times are estimates from the measured steps.

| Check | Time | `docs` | `cosmetic` | `standard` | `critical` | `platform` |
|---|---|---|---|---|---|---|
| Classify the change (`scripts/risk-profile.mjs`) | 5 s | ● | ● | ● | ● | ● |
| Markdown link and anchor check (new, no install) | 5 s | ● | ● | ● | ● | ● |
| Install without scripts (`--ignore-scripts`) | 25 s | – | ● | ● | – | – |
| Full install with `postinstall` | 45 s | – | – | – | ● | ● |
| CSS parse of changed files (postcss) | 5 s | – | ● | ● | ● | ● |
| Browser form test (first test of `e2e.cjs` by `--test-name-pattern`: CSS on the SHACL form; needs the `packages/model` build, not the app build) | 30 s | – | ● | ● | ● | ● |
| Import rules (`check-boundaries.mjs`) | 1 s | – | – | ● | ● | ● |
| Manifests (GHC) | ~10 s | – | – | ● | ● | ● |
| Typecheck (`tsc -b`, test config) | ~30 s | – | – | ● | ● | ● |
| Unit tests, affected only (`vitest related` + path map, section 4.3) | 20–150 s | – | – | ● | – | – |
| Unit tests, full suite, sharded in 2 jobs | ~90 s wall | – | M | M | ● | ● |
| Build `app` (`theia build`) | ~25 s | – | M | ● | ● | ● |
| Build `electron-app` | ~15 s | – | M | M | ● | ● |
| Full e2e (`pnpm e2e`) | ~2 min | – | M | ● if `modeler/src/browser/**` changed, else M | ● | ● |
| CLI and RPC contract smoke (new: backend on a fixture copy, `catenary rpc`) | ~40 s | – | – | M | ● | ● |
| Windows unit subset (paths, files, watcher, Git) | ~4 min | – | – | – | ● if paths, files, watcher or Git changed, else nightly | ● |
| Package one target + desktop smoke on Linux (xvfb) | ~3 min | – | – | – | ○ | ● |
| Windows package + smoke on `windows-latest` | ~4 min | – | – | – | nightly | ● if Windows-relevant, else nightly |
| All release targets, dry run, no publish | ~6 min | – | – | – | – | ● if `release.yml` or `package.sh` changed |
| Review by a code owner of the changed area | – | – | – | – | ● | ● |
| **Blocking wall time (estimate)** | | **< 30 s** | **≈ 1.5 min** | **3–5 min** | **6–8 min** | **8–12 min** |

Today every profile costs 4.5–5.5 min. `standard` keeps about the same time but gains the e2e tests for browser changes. `critical` and `platform` take longer than today, because they add checks that do not exist today.

## 4. Rules to assign a profile

### 4.1 Algorithm

1. Compute the diff between the merge base and the PR head. Do not use the last commit only.
2. Map each changed file to a profile with the path rules in 4.2. The first matching rule wins.
3. A file that matches no rule gets `standard`. A low profile is an allowlist, never a default.
4. Apply the content tripwires in 4.4. A tripwire can only raise a profile.
5. The PR profile is the highest profile of all files and tripwires.
6. A label `risk:critical` or `risk:platform` raises the profile. No label can lower it.
7. Write the profile, the file that set it and the rule that matched to the job summary.

### 4.2 Path rules

Keep the rules in one file, `.github/risk-profiles.yml`. A change to that file is `platform`.

| Order | Pattern | Profile |
|---|---|---|
| 1 | `.github/**`, `scripts/package.sh`, `scripts/install-*.sh`, `scripts/build-*.sh`, `scripts/smoke-desktop.mjs`, `scripts/check-windows-package.mjs`, `scripts/verify.mjs`, `scripts/e2e.cjs`, `vitest.config.mts`, `tsconfig*.json` | `platform` |
| 2 | `pnpm-lock.yaml`, `**/package.json`, `pnpm-workspace.yaml`, `.node-version`, `electron-app/**`, `app/**`, `modeler/src/electron-main/**` | `platform` |
| 3 | `patches/**` | `platform` (a patch changes serialization or validation, and it changes dependencies) |
| 4 | `packages/rdf/**`, `packages/rdf-files/**`, `packages/rdf-serialization/**`, `packages/rdf/notations/*.ttl`, `packages/rdf/test/fixtures/**` | `critical` |
| 5 | `modeler/src/node/**`, `modeler/src/common/protocol.ts`, `modeler/src/common/cli-protocol.ts`, `scripts/catenary.mjs` | `critical` (API and CLI, token check) |
| 6 | `packages/model/src/commands.ts`, `packages/model/src/snapshot.ts`, `packages/model/src/ids.ts`, `packages/model/src/paths.ts` | `critical` (each edit command writes files; IDs and paths are persisted) |
| 7 | `packages/model/**`, `modeler/src/**`, `modeler/test/**`, `examples/**`, `spec/*.hs`, `scripts/*.mjs` (others) | `standard` |
| 8 | `modeler/css/**`, `*.png`, `*.svg` in `docs/` | `cosmetic` |
| 9 | `**/*.md`, `LICENSE` | `docs` |
| 10 | Anything else | `standard` |

`spec/*.hs` is not `docs`. GHC typechecks the manifests in `pnpm check`, so a manifest edit can break the build.

### 4.3 Affected tests in `standard`

Vitest `related` selects tests by the import graph of the changed source files. The import graph misses some inputs. The path map adds them:

| Changed path | Add these tests |
|---|---|
| `packages/model/**` | Full suite (all layers import the model) |
| `packages/rdf/test/fixtures/**`, `packages/rdf/notations/**` | All of `packages/rdf/test`, `modeler/test/model-service.test.ts` |
| `examples/**` | `packages/rdf/test/workspace-files.test.ts`, `packages/rdf/test/workspace.test.ts` |
| A test helper (`helpers.ts`, `project-full.ts`, `doc-reference.ts`, `view-part-reference.ts`) | All tests of its package |

If `vitest related` fails or selects zero tests for a changed `.ts` file, run the full suite.

### 4.4 Content tripwires

A tripwire reads the diff text. It can only raise the profile.

| Tripwire | Raise to |
|---|---|
| A new or removed import of `node:fs`, `fs`, `child_process`, `node:child_process`, `worker_threads` in any file | `critical` |
| A new call of `writeFile`, `rename`, `rm`, `unlink`, `exec`, `spawn` | `critical` |
| A change of a string that contains `http://` or `https://` in a namespace or IRI constant | `critical` (persisted IRIs) |
| A deleted test file, or a new `.skip`, `.only`, `todo` or `skip:` in a test | `critical`, and the gate fails on `.only` |
| A diff larger than 400 changed lines or 20 files | At least `standard` |
| A rename or move of a file in `packages/` | `critical` (export paths and boundaries) |

## 5. Examples

Real commits of this repository, with the profile that the rules give them.

| Change | Files | Profile | Why |
|---|---|---|---|
| `61bea66` Make colored cards and notes translucent | `modeler/css/modeler.css` | `cosmetic` | CSS only |
| `0edded1` Align note default with refined palette | `modeler/css/modeler.css` | `cosmetic` | CSS only |
| `1461f47` Refine diagram color presets | `modeler/src/browser/diagram/card-chrome.ts` | `standard` | A color constant in TypeScript. The classifier cannot prove that a `.ts` change is visual only. Affected tests: `modeler/test` only. |
| `532bdf6` Default line style is 'direct' | `edge-preferences.ts`, its test, `ui-manifest.hs`, `user-guide.md` | `standard` | Behavior default. Affected tests plus GHC. Full e2e because `modeler/src/browser` changed. |
| `b9d514d` Formalize the manifests | `spec/*.hs`, docs, code comments | `standard` | GHC must typecheck the manifests. |
| A typo fix in `docs/user-guide.md` | one `.md` file | `docs` | Link check only |
| A new row in `spec/open.md` | one `.md` file | `docs` | Link check only |
| A new read query (architecture → "Add a read query") | `packages/model/src/queries.ts`, `packages/rdf/src/queries.ts`, a panel in `modeler/src/browser` | `critical` | `packages/rdf/**` matches. The query reads the store, and the RPC service exposes it. |
| A change of the TriG view writer | `packages/rdf/src/trig.ts` | `critical` | Writes user files |
| A change of the Turtle text patch | `packages/rdf-files/src/text-patch.ts` | `critical` + Windows subset | Writes user files. Line ends differ on Windows. |
| A change of the CLI token check | `modeler/src/node/cli-token-validator.ts` | `critical` | Security |
| `b0ef2ef` shacl-engine release with a patch | `patches/shacl-engine@1.1.2.patch`, `pnpm-workspace.yaml`, lockfile | `platform` | Dependency and validation behavior |
| `3dcb616` Bookshop example workspace | `examples/**`, `scripts/desktop.sh`, `scripts/smoke-desktop.mjs`, a test | `platform` | `smoke-desktop.mjs` matches rule 1. Without that file the change is `standard`. |
| `0bd276c` AppImage in the release workflow | `.github/workflows/release.yml` | `platform` | Release dry run is blocking |
| A tag `v0.2.0` | none | Release pipeline | Section 6.4 |

## 6. Pipeline architecture

### 6.1 Triggers

| Event | Runs |
|---|---|
| `pull_request` | Classify, then the jobs of the profile |
| `push` to `main` | Full set: everything with ● or M in the `platform` column, except the release dry run |
| `push` to other branches | Nothing. A branch without a PR gets checks on demand (`workflow_dispatch`) or locally with `pnpm verify`. |
| Nightly schedule on `main` | Full set plus Windows unit subset, Windows package smoke and Linux package smoke |
| Tag `v*` | Release pipeline only. No CI run. |

### 6.2 Jobs and the gate

```
pull_request
  └─ classify (5 s) ──► profile, file list, reason
        ├─ lint-docs            ● all profiles
        ├─ fast   (install --ignore-scripts, css parse, form test, check, affected tests)
        ├─ unit-1 / unit-2      (full suite, sharded: packages/rdf | the rest)       critical, platform
        ├─ build-e2e            (full install, build app [+ electron-app], e2e, CLI smoke)
        ├─ windows-unit         (windows-latest)                                     by rule
        ├─ package-smoke        (one target, xvfb)                                    platform
        └─ gate  ◄── needs all; passes when each job that the profile requires passed
```

Branch protection requires only `gate`. Jobs that the profile does not need are skipped, and a skipped job does not fail the gate. A required job that is skipped or cancelled fails the gate. This avoids the GitHub problem that a path-filtered required check never reports.

### 6.3 Blocking and non-blocking

| Stage | Blocks the merge | Blocks the release | On failure |
|---|---|---|---|
| PR checks with ● | Yes | Indirectly | Fix in the PR |
| PR checks with ○ | No | No | Comment on the PR |
| Post-merge full set on `main` (M) | No | Yes | Open an issue with label `ci-escape`, the PR, its profile and the failed check. Fix or revert before the next tag. |
| Nightly | No | Yes, if it is the latest result for the SHA | Same as post-merge |

A post-merge failure of a PR that ran a reduced profile is an escape. Escapes drive the rule review (section 8).

### 6.4 Release pipeline (`release.yml`)

1. `gate`: read the check results of the tag SHA. Continue only if the post-merge full set on `main` passed for this exact SHA. Stop with a message otherwise. Do not run the tests again.
2. `package`: build all targets once on `ubuntu-22.04`.
3. `smoke`: start each package that is published. Linux tar.gz and AppImage under xvfb, the Windows zip on `windows-latest` (the steps of `windows.yml` smoke), the macOS apps after the ad hoc signature.
4. `release`: write `SHA256SUMS` and publish. A hyphen in the tag makes a prerelease.

The `windows.yml` package job downloads the package artifact of the same SHA when one exists. It does not build again.

## 7. Safeguards against a wrong low profile

1. Allowlist for low profiles. Only `docs` and `cosmetic` patterns can produce those profiles. An unknown path gets `standard`.
2. Highest profile wins over all files of the whole PR diff.
3. Labels only raise. Lowering needs a change to `.github/risk-profiles.yml`, and that change is `platform` with code-owner review.
4. Content tripwires (4.4) find risky code in files with a low-risk path.
5. Unit tests for the classifier. The examples table in section 5 becomes a test fixture. A change of the rules must keep these answers or change the table in the same PR.
6. Fallback to more tests. A classifier error, an empty `vitest related` result for a changed `.ts` file or a missing merge base runs the full `platform` set.
7. Post-merge full set on every `main` commit. A reduced PR profile never reduces what runs on `main`.
8. Shadow runs. In the first four weeks, every PR also runs the full set as a non-blocking job. Later, run it on 1 of 5 reduced-profile PRs, chosen by the PR number. A shadow failure that the reduced profile did not find counts as an escape.
9. Release gate. No package is published without a green full set on the exact SHA.
10. Mandatory review for `critical` and `platform` through `CODEOWNERS` on the paths of rules 1 to 6.

## 8. Metrics

Collect a baseline for two weeks before reduced profiles block anything. The GitHub Actions API gives all values except the defect counts.

| Metric | Definition | Target |
|---|---|---|
| Time to green, per profile | p50 and p90 from the PR head push to a green `gate` | `docs` p50 < 1 min, `cosmetic` p50 < 2 min, `standard` p50 ≤ today (≈ 5 min) |
| Release lead time | From the merge commit on `main` to the published release of that SHA | Less than today: no repeated CI run, no build per workflow |
| Runner minutes per merged PR | Sum over all workflows, Windows and macOS minutes weighted by the GitHub multiplier | −40 % for `docs` and `cosmetic` PRs, no target for `critical` |
| Duplicate runs | Runs of the same workflow on the same SHA | 0 |
| Escape rate, per reduced profile | Post-merge or shadow failures of PRs with that profile ÷ PRs with that profile | ≤ 1 in 50 PRs. Above that, tighten the rule that let the change through. |
| Classifier raise rate | PRs where a human added a `risk:*` label | Rising values mean that the rules are too weak |
| Change failure rate | Releases followed by a revert or a fix release within 14 days ÷ releases | Not higher than the baseline |
| Defects per release | Issues with label `bug` that cite a released version | Not higher than the baseline |
| Flake rate | Jobs that fail and then pass on the same SHA without a change | Falls. Each flake gets an issue. |
| Coverage of high-risk changes | Share of `critical` and `platform` PRs that ran e2e, CLI smoke and the Windows subset where the rules require them | 100 % |

The repository has one release today (`v0.1.0`). A change-failure baseline from one release is not reliable. Use the escape rate and the shadow runs as the main quality signal until there are at least five releases.

## 9. Migration plan

Each phase is one PR. Each phase can be undone alone. A repository variable `CI_PROFILES=off` makes the classifier return `platform` for every change, which is the current behavior plus the new checks.

| Phase | Change | Risk | Exit condition |
|---|---|---|---|
| 0 | Remove pure duplicates: `ci.yml` on `push` to `main` only plus `pull_request`. No CI on tags. `release.yml` on tags and `workflow_dispatch` only. Start the metrics collection. | None: the same checks run on each PR SHA. | Two weeks of baseline data |
| 1 | Add `scripts/risk-profile.mjs`, `.github/risk-profiles.yml` and the classifier tests. Run it in shadow: print the profile, still run the full set. | None | The classifier output matches a manual review of 20 PRs |
| 2 | Close the gaps: e2e and the CLI smoke in CI for `critical`, `platform` and browser changes. Add the source paths of 4.2 rule 6 and `packages/rdf-files/src/{paths,file-sync,git}.ts` to the Windows trigger. Release gate and package smoke in `release.yml`. | More time for high-risk PRs | e2e passes on `main` three times in a row without a flake |
| 3 | Make `docs` and `cosmetic` blocking with their reduced sets. Keep the full set as a non-blocking shadow job. Add the `gate` job and make it the only required check. | Low: CSS and Markdown only | 4 weeks, escape rate ≤ 1 in 50 |
| 4 | `standard` uses affected tests. Shard the full suite in 2 jobs for `critical` and `platform`. Skip `electron-app` builds outside `platform` and `critical`. | Medium | 4 weeks, escape rate ≤ 1 in 50 |
| 5 | Build once, promote the artifact: `windows.yml` and `release.yml` use the package of the SHA. Reduce the shadow runs to 1 in 5. | Low | Release lead time below the baseline |
| 6 | Review every quarter: the escapes, the raise rate and the slowest checks. Change the rules in `.github/risk-profiles.yml` with the classifier tests. | – | – |

Do not remove a test to make a profile faster. A slow test moves to the profile whose risk it covers. It does not leave the full set.

## 10. Target state

- One required check, `gate`, on each PR. The classifier selects the jobs. Each job runs once per SHA.
- `main` always runs the full set after the merge. The nightly run adds Windows and package smoke tests.
- A tag runs no tests. It checks that the full set passed on the SHA, builds each package once, starts each package and publishes.
- The browser tests, the CLI contract smoke and the Windows tests run where the rules say. They no longer depend on an agent who remembers them.

### 10.1 Example flows

**CSS-only change** (`modeler/css/modeler.css`, like `61bea66`)

1. PR opened. `classify` → `cosmetic` (rule 8).
2. `lint-docs` and `fast` in parallel: install without scripts, postcss parse of `modeler.css`, the browser form test with the changed CSS.
3. `gate` passes after about 1.5 min. Today: about 5 min, twice (push and PR).
4. Merge. `main` runs the full set, including the full e2e. A failure opens a `ci-escape` issue and blocks the next tag.

**Normal application feature** (a new panel action in `modeler/src/browser`, a rule in `packages/model/src/selection.ts`, tests)

1. `classify` → `standard` (rule 7). No tripwire.
2. `fast`: check (import rules, GHC, typecheck), then affected tests. The model changed, so the path map runs the full suite.
3. `build-e2e` in parallel: build `app`, run the full e2e, because `modeler/src/browser` changed.
4. `gate` passes after about 4–5 min, the same as today, but with e2e coverage that does not exist today.
5. Merge. `main` runs the full set with the `electron-app` build and the CLI smoke.

**Database or API change** (the TriG writer in `packages/rdf/src/trig.ts`, a new field in `modeler/src/common/protocol.ts`)

1. `classify` → `critical` (rules 4 and 5). `CODEOWNERS` requests a review.
2. `fast`: check. `unit-1` (`packages/rdf/test`) and `unit-2` (all other tests) in parallel.
3. `build-e2e`: full install, both builds, full e2e, CLI smoke: a backend on a copy of the fixtures, `catenary rpc` for the changed query, and an RDF comparison of the written file with the `rdf` CLI.
4. The writer changed, so `windows-unit` runs the paths, files, watcher and Git tests on `windows-latest`.
5. `package-smoke` (Linux, xvfb) runs as non-blocking information.
6. `gate` passes after about 6–8 min and the review. Merge. `main` and the nightly run repeat the full set and the Windows package smoke.

**Publishing-only release** (tag `v0.2.0` on a commit of `main`)

1. The tag starts `release.yml` only. `ci.yml` does not run.
2. `gate` reads the checks of the tag SHA. The post-merge full set passed, so the release continues. If it failed or is missing, the job stops and names the failed check.
3. `package` builds the Linux, Windows and macOS packages once.
4. `smoke` starts the Linux tar.gz and AppImage under xvfb, the Windows zip on `windows-latest`, and the macOS apps after the ad hoc signature.
5. `release` writes `SHA256SUMS` and publishes. No unit test runs again. Today: a CI run of 4 min that the release ignores, then 6.5 min of packaging with no package started.
