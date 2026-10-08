# Overview

Catenary is a desktop and browser editor for RDF models. It is built on Theia (workbench) and GLSP (diagrams). It is a drafting tool: simple behavior is more important than full round-trip fidelity of every RDF syntax.

## What a user does with it

A user opens a folder of RDF files and edits the model in diagrams, forms and text. SHACL shapes in the same folder define which fields a form shows, which relations are valid and which data is in violation. Several diagrams (views) can show the same elements. Each edit writes the files at once and, in a Git repository, makes a commit.

## Main ideas

- **Files are the model.** The workspace is a folder of RDF files. Catenary reads them into an in-memory index (Oxigraph) for queries and validation. An edit writes a text patch to the file that holds the statement. A change on disk by another program is read back.
- **No file roles.** A file is not a "data file" or a "shapes file". What a file contains comes from its triples. Shapes, SKOS vocabularies, instances and views can sit in any file.
- **Views are RDF too.** A view is one `*.view.trig` file with one named graph. It holds placements (position, size, color) of model elements. A placement never asserts a model statement.
- **Notations draw views.** A notation derives the figures of the elements. A placed element is a box or a line; an element without a placement is a row of the card that owns it.
- **Shapes drive the UI.** Forms, relation pickers, palette entries and validation come from SHACL shapes. Catenary can propose shapes from existing data.
- **No blank nodes.** A read replaces each blank node with a `urn:skolem:` IRI. After that every node is an IRI.
- **One undo history.** All windows share one backend store. One edit command is one transaction and one undo step.

## Vocabulary

| Term | Meaning |
|---|---|
| Workspace | A folder of RDF files, with an optional `workspace.trig` that holds settings (prefixes, file placement, exclusions, protection). |
| Element | An IRI resource or a triple (a relation). Its statements define its content. |
| Layer | Classification of a statement: **Domain** (instances, relations, SKOS), **Shapes** (node shapes, property shapes, logical constraints), **Project** (views, placements, notes, frames, settings). |
| View | An element that a canvas shows. One view per `*.view.trig` file. |
| Placement | The occurrence of one element in one view, with geometry and style. An element has at most one placement per view. |
| Notation | An ordered list of figure shapes that says how a view draws elements. Built into Catenary (`packages/rdf/notations/`). |
| Figure | What a notation derives for one element: a box, a line or a hub. Figures are computed, never stored. |
| Card | A box figure of an instance, node shape or value set. |
| Row | A part of a card that the view does not place: a property, a relation, a concept, a logical constraint (a row group). |
| Connector | A relation (a triple with an IRI object) drawn as a line between two cards. |
| Hub | The figure of a logical constraint or a generalization set: a node that joins its member lines. |
| Pill | The small end box of a line: private to its line for a datatype, node kind or "any"; shared for a class without a node shape. |
| Mark | A Project element that exists only through its placements: note, frame, file reference, entity group. |
| Value set | A SKOS scheme or collection used as the range of a property. |

## Status

Catenary runs as a browser app and as an Electron app on Linux. The release packages for Windows and macOS are built on Linux. A CI workflow checks the Windows package on a Windows runner. The macOS packages are not tested on macOS. Known defects and open decisions are in [open work](../spec/open.md).

## Where to read next

1. [User guide](user-guide.md): what a user can do, panel by panel.
2. [Architecture](architecture.md): packages, data flow, persistence.
3. [Data contract](../spec/manifest.hs) and [interaction contract](../spec/ui-manifest.hs): the exact rules.
