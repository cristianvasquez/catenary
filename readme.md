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

The contracts use Haskell notation. They do not compile, and `pnpm verify` does not check them.

## Run

Use Node 22.23.3 and pnpm 11.3.0. Dependencies: Theia 1.74.1, GLSP 2.8.0, [shaclxtract](https://www.npmjs.com/package/shaclxtract).

```sh
pnpm install          # dependencies, native drivelist, Electron, VS Code Git plugin
pnpm build            # packages, extension, browser app and Electron app
pnpm start            # browser app: http://localhost:3100, example workspace
pnpm desktop          # Electron app on the example workspace
pnpm install-desktop  # Linux launcher entry
pnpm package:win      # dist/Catenary-win32-x64.zip, built on Linux
node scripts/check-windows-package.mjs   # layout and binaries of the Windows package
xvfb-run -a node scripts/smoke-desktop.mjs   # start the desktop app and check paths, writes, Git, watcher
pnpm test             # source-based tests
pnpm check            # package boundaries and TypeScript
pnpm verify           # check → test → build, stops at the first failure
pnpm verify --e2e     # also run browser smoke tests
```

By default, the first start copies [`examples/catalog`](examples/catalog/readme.md) to `~/.local/share/catenary/workspaces/example` or `$XDG_DATA_HOME/catenary/workspaces/example`. Catenary edits the copy, not the tracked example, and does not overwrite a non-empty workspace. Set `CATENARY_WORKSPACE` to use another folder. For another desktop workspace, use `bash scripts/desktop.sh <folder>`. Each workspace gets its own Electron profile in `~/.config/catenary/profiles/<hash>`, so each workspace runs in its own process with its own backend. A second launch on the same workspace focuses the open window. `--user-data-dir=<dir>` overrides the profile. Backend logs of all instances also go to `~/.local/state/catenary/backend.log`.

The Windows package is built on Linux. The workflow `.github/workflows/windows.yml` checks it on a Windows runner. It runs on demand (Actions → Windows → Run workflow) and when a change touches the package scripts, the desktop app or the lockfile. It runs the tests of paths, files, the watcher and Git with real Windows paths, and it starts `Catenary.exe` and `Catenary.cmd` with `scripts/smoke-desktop.mjs dist\Catenary-win32-x64 [--crlf | --launcher]`.

The install script builds `drivelist` in a temporary directory because node-gyp fails on some paths with spaces. Both applications load the downloaded plugins for Source Control with `--plugins=local-dir:plugins`.

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
```

`status`, `model`, `rpc` and `exec` need no browser window. The other commands need a connected window; a headless Chromium page is sufficient. Before a test, `status` must report `build.stale`, `build.restartNeeded` and each window's `reloadNeeded` as false. A backend without a frontend starts with an empty model, so open the test workspace explicitly. Keep the backend on localhost.
