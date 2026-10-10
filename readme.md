---
uuid: bfcdef83-5200-47fe-a2a5-a7cf76a3190c
repo-uri: osg://repo/github.com/cristianvasquez/catenary
repo-name: catenary
repo-group: rdf
tags: [repo/rdf]
layout: node.js
---

# Catenary

Catenary edits RDF models with Theia and GLSP. SHACL shapes supply fields, relation choices and validation. Several diagrams can show the same elements. The files on disk are the model: each edit writes them and can make a Git commit.

## Documentation

Read in this order, from overview to detail:

| Document | Content |
|---|---|
| [Overview](docs/overview.md) | Purpose, main ideas, vocabulary |
| [User guide](docs/user-guide.md) | What a user does: workspace, views, shapes, keys, settings |
| [Architecture](docs/architecture.md) | Data flow, store layout, packages, code map, persistence, testing |
| [Notation vocabulary](docs/notation/) | The `nt:` vocabulary and the SHACL of views, placements and notations (ADR 0014) |
| [Data contract](spec/manifest.hs) | Files, RDF, commands, transactions, persistence, queries, CLI protocol |
| [Interaction contract](spec/ui-manifest.hs) | Interaction rules, keys, selection, panels, controls |
| [Open work](spec/open.md) | Open decisions, known defects, verification gaps |
| [Agent guide](AGENTS.md) | Work rules for agents and documentation style |

The contracts are Haskell modules. The optional `pnpm check:manifests` target typechecks them with GHC. It skips the check when GHC is absent. A mismatch of names or types fails when GHC is available.

## Run

Use Node 22.23.3 and pnpm 11.3.0. Dependencies: Theia 1.74.1, GLSP 2.8.0, [shaclxtract](https://www.npmjs.com/package/shaclxtract).

```sh
pnpm install          # dependencies, native drivelist, Electron, VS Code Git plugin
pnpm build            # packages, extension, browser app and Electron app
pnpm start            # browser app: http://localhost:3100, example workspace
pnpm desktop          # Electron app on the example workspace
pnpm install-desktop  # Linux launcher entry
pnpm package linux-x64   # portable package in dist/: linux-x64, win32-x64, darwin-x64, darwin-arm64
pnpm package linux-x64 --appimage  # also dist/Catenary-linux-x64.AppImage
node scripts/check-windows-package.mjs   # layout and binaries of the Windows package (pnpm package:win first)
xvfb-run -a node scripts/smoke-desktop.mjs   # start the desktop app and check paths, writes, Git, watcher
pnpm test             # source-based tests
pnpm check            # package boundaries, Markdown links, CSS and TypeScript
pnpm check:manifests  # optional manifest typecheck with GHC; skips when GHC is absent
pnpm build:browser    # the build without the Electron app
node scripts/smoke-cli.mjs      # CLI and RPC contract against the browser backend (build first)
pnpm verify           # check → test → build, stops at the first failure
pnpm verify --e2e     # also run browser smoke tests
```

Canvas command `catenary.copyAsRdf` copies selected model RDF as readable Turtle without placement metadata.
RPC queries `prepareRdfPaste(text, mediaType?)` and `copyAsRdf(viewId, ids)` parse and export clipboard RDF.
The `pasteRdf` edit accepts parsed N-Quads, a view, an optional position, and explicit consent to flatten named graphs.

By default, the first start copies [`examples/bookshop`](examples/bookshop/readme.md) to `~/.local/share/catenary/workspaces/example` or `$XDG_DATA_HOME/catenary/workspaces/example`. Catenary edits the copy, not the tracked example, and does not overwrite a non-empty workspace. Set `CATENARY_WORKSPACE` to use another folder. For another desktop workspace, use `bash scripts/desktop.sh <folder>`. Each workspace gets its own Electron profile in `~/.config/catenary/profiles/<hash>`, so each workspace runs in its own process with its own backend. A second launch on the same workspace focuses the open window. `--user-data-dir=<dir>` overrides the profile. Backend logs of all instances also go to `~/.local/state/catenary/backend.log`.

The Windows package is built on Linux. The workflow `.github/workflows/windows.yml` checks it on a Windows runner. It runs on demand (Actions → Windows → Run workflow) and when a change touches the package scripts, the desktop app or the lockfile. It runs the tests of paths, files, the watcher and Git with real Windows paths, and it starts `Catenary.exe` and `Catenary.cmd` with `scripts/smoke-desktop.mjs dist\Catenary-win32-x64 [--crlf | --launcher]`.

The install script builds `drivelist` in a temporary directory because node-gyp fails on some paths with spaces. Both applications load the downloaded plugins for Source Control with `--plugins=local-dir:plugins`.

## Releases

The [release workflow](.github/workflows/release.yml) builds portable packages for Linux, Windows and macOS. To publish a release, push a version tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The workflow publishes only a commit whose CI run on `main` passed. It builds on Linux with `scripts/package.sh`, starts each package once, signs the macOS apps ad hoc on macOS and attaches these files to a GitHub release:

| File | Platform | Start |
|---|---|---|
| `Catenary-linux-x64.tar.gz` | Linux x64 (glibc 2.35 or later) | `./catenary` |
| `Catenary-linux-x64.AppImage` | Linux x64 (glibc 2.35 or later) | `chmod +x` the file, then run it |
| `Catenary-win32-x64.zip` | Windows x64 | `Catenary.exe` |
| `Catenary-darwin-arm64.dmg`, `.zip` | macOS, Apple silicon | `Catenary.app` |
| `Catenary-darwin-x64.dmg`, `.zip` | macOS, Intel | `Catenary.app` |

A tag with a hyphen, for example `v0.2.0-rc.1`, makes a prerelease. A pull request that changes the packaging files, or a manual run, builds the packages as workflow artifacts without a release. The packages have no Apple or Windows code signature:

- macOS: after you copy Catenary to Applications, run `xattr -dr com.apple.quarantine /Applications/Catenary.app`. Alternatively, open it once from System Settings → Privacy & Security → Open Anyway.
- Windows: SmartScreen can show a warning. Select More info → Run anyway. Source Control needs `git.exe` on the PATH.
- Linux: the AppImage needs FUSE 2 (`libfuse2`). Without FUSE, run it with `--appimage-extract-and-run`. The AppImage turns off the Electron sandbox when the kernel does not allow unprivileged user namespaces, for example on Ubuntu 24.04. If the tar.gz package stops with a sandbox error, run `./catenary --no-sandbox`, or give `chrome-sandbox` to root with mode 4755.

## Command-line interface

`pnpm -s catenary` controls a running backend. Use `--help` for syntax and `rpc` for the available methods. Each backend writes `$XDG_RUNTIME_DIR/catenary/<pid>.json` (port, token, workspace). The CLI selects the backend from `--port`, then `CATENARY_PORT`, then the only running backend, then the backend of the workspace that contains the current directory. Otherwise it fails and lists the running backends. The [data contract](spec/manifest.hs) defines authentication and exit codes.

```sh
pnpm -s catenary --port 3917 status
pnpm -s catenary --port 3917 rpc open '"/tmp/catenary-test/workspace.trig"'
pnpm -s catenary --port 3917 model views --keys
pnpm -s catenary --port 3917 exec '{"kind":"createView","label":"Test view"}'
pnpm -s catenary --port 3917 commands view
pnpm -s catenary --port 3917 run catenary.newInstance
pnpm -s catenary --port 3917 prompt
pnpm -s catenary --port 3917 answer --pick Dataset
pnpm -s catenary --port 3917 answer --cancel
pnpm -s catenary --port 3917 run catenary.exportMarkdown '"/tmp/catenary-test/docs"' '"/tmp/catenary-out"'
```

`status`, `model`, `rpc` and `exec` need no browser window. The other commands need a connected window; a headless Chromium page is sufficient. Before a test, `status` must report `build.stale`, `build.restartNeeded` and each window's `reloadNeeded` as false. A backend without a frontend starts with an empty model, so open the test workspace explicitly. Keep the backend on localhost.

`rpc view <view-id> <ids>` reads selected placements and their dependencies. Omit `ids` to read the full view. Both arguments are JSON.

`rpc viewDescription '"<view-id>"'` reads only a view's Markdown description, without diagram counts. See [Performance checks](docs/user-guide.md#performance-checks) for the five Trace metrics.

`rpc setTracing true` starts the trace of the backend for the CLI connection, `rpc trace 0` reads the spans and totals, and `rpc setTracing false` stops it. Figure synchronization spans identify notation input, per-view derivation and placement-rule time. `rpc stopTracing 0` returns the final batch before stopping the CLI connection. Read spans show the RDF view ID, instance count and file-origin query count under the calling RPC. The Trace panel (View → Trace) shows the same data.

Model RDF files open as file-scoped Model documents. **Open as…** (`catenary.openAs`) and **Open beside…** (`catenary.openBeside`) select a presentation. Both accept a file path and a presentation name: `Source`, `Model`, `Canvas`, or `Settings`. Reopening focuses the existing pane. `explorerChildren(key, file, offset)` returns one page of rows of a source file. `explorerSearch(text, file)` returns the flat filter list. `explorerDrag(selection)` resolves complete folder contents. The `moveElementsToFile` edit moves source statements, and `placeExplorerElements` places a mixed selection in one undo step.

## License

Copyright (C) 2026 Cristian Vasquez.

Catenary is free software: you can redistribute it and modify it under the terms of the [GNU Affero General Public License](LICENSE) as published by the Free Software Foundation, version 3 of the License or any later version. Catenary has no warranty. See the license for details.
