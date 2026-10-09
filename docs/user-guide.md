# User guide

This guide describes what a user can do with Catenary. The exact rules for each gesture are in the [interaction contract](../spec/ui-manifest.hs).

**Caution:** each edit writes the files and can make a Git commit. Use a copy of valuable data for experiments. Named graphs in model files do not survive a write (open work STORE1).

## Open or create a workspace

The first `pnpm start` or `pnpm desktop` copies `examples/bookshop` to `~/.local/share/catenary/workspaces/example`, or `$XDG_DATA_HOME/catenary/workspaces/example`. Catenary edits the copy and does not change the tracked example. Set `CATENARY_WORKSPACE` to open another folder. A non-empty default workspace is never overwritten.

1. Select File → Open Workspace.
2. Select a folder or a `workspace.trig` file.

A file in the navigator opens what it holds, not what its name says, when you select it. A view file of the open workspace shows the view. The workspace file shows the Workspace settings. Selecting a file of another workspace shows its text: double-click it or press Enter to open that workspace and its view. A file that mixes workspace settings and a view opens as text with a message: move the view into its own file. Other model RDF files open in their Model explorer. Other files open as text. Use Open With to open any file as text.

If the folder has no workspace file, Catenary uses default settings and asks once where new subjects go. File → New Workspace proposes `workspace.catenary.trig` as the filename. You can change it. Catenary creates the proposed files (`<name>.shapes.ttl`, `<name>.skos.ttl`) and `views/main.view.trig`.

In the desktop app, each workspace runs in its own process with its own window. File → New Window and a workspace opened in a new window start a new process. If the workspace is already open, its window comes to the front. `bash scripts/desktop.sh <folder>` does the same from the command line.

All supported RDF files in the folder and its subfolders are part of the model: Turtle, TriG, N-Triples, N-Quads and JSON-LD (read and write), N3 and RDF/XML (read only). Hidden files, `*.bak`, `node_modules`, nested workspaces and the exclude globs of the settings are not part of it.

## The screen

| Area | Content |
|---|---|
| Files (left, first tab) | The file navigator. Each file shows letters for what it contains: V views, S shapes, C concepts, I instances. D marks the default file, R an imported (read-only) file. Right-click a model file to mark it as imported or as own. |
| Search (left) | Faceted search on text, type and "Linked to". At most 200 results. |
| Main area | File presentations: Canvas, Source, Model explorer, Settings. Model folders load when you open them. |
| Right area | Properties (fields from all applicable shapes, violations, an action toolbar with a More actions menu), Appearance: Style of the selection (color, display, size, edge sides, visibility), View (Apply Layout, spacing, hidden edges), Preferences (text sizes, edge style), Links (incoming and outgoing statements, views, source files, and Instances for selected node shapes). |
| Outline | Frames, cards and placed relations of the active view. |
| Problems | SHACL results. A click selects the focus instance. |

Catenary resets saved layouts once when you first open this version. Later sessions restore your pane arrangement.

## Views and canvases

In the browser, append `?view=<view-id>` to the backend URL to open a specific view. Use `pnpm -s catenary --port PORT model views --keys` to get view IDs. For example: `http://localhost:3931/?view=n-urn_3aname_3aPackage_2520provenance`. The link selects a view in the current workspace after startup, even when other tabs were restored. An unknown view shows an error and leaves normal startup behavior unchanged. The link does not select a workspace or start a backend.

- Create a view: Model → New View, the `+` after the editor tabs, or New View on a folder of the navigator. Type the name of the view file. The view opens with the label "unnamed view N", and no other dialog appears. Rename it when you want (F2, or Properties): the file name stays.
- Duplicate a view: Duplicate View in the view actions. Type the name of the file of the copy (proposed: `<name>-copy` next to the source). The copy opens as "<label> copy", with no other dialog.
- Open a view: select its file in the navigator, or a view row in the Model explorer. A view file is a TriG file that declares a view. Its name does not matter. New views propose `*.view.trig`.
- Create an element: use the palette above the canvas. From left to right: Shape (the large tile), Scheme and Collection, one tool per class with a target-class shape, and Group and Note for the view.
- Place an existing element: drag it from the Model explorer, Search or Links onto a canvas. Its relations to cards already on the view are placed too.
- Open a file tree: open a model RDF file, or select **Open as… → Model** from another presentation.
- Use **Open beside…** to open another presentation beside the current pane. Reopening a presentation focuses its existing pane.
- Move or split Model panes with the same tab controls as source editors and canvases.
- Filter a tree: type while a row has focus, or use the fuzzy filter input. Matches can have gaps. The tree hides nonmatching branches and highlights matching characters. It keeps ancestors of matches visible. Press Escape in the input to clear the filter.
- Drag a folder to place all its descendants, including elements hidden by the filter. A folder drag does not create instances.
- Move elements: drag from one file tree to another. Confirm the element count and destination. Only statements supplied by the source file move. Other files and resource IRIs stay unchanged. Undo restores the transfer.
- Move a shape with its structural nodes. If a nested shape has an unselected parent, select that parent before moving it. View files are not file-move destinations.
- Link to a file: drag a file from the navigator onto a canvas. A view file gives a view reference, another file a file reference.
- Card controls (halo): Reveal, Remove, More actions, expand incoming/outgoing neighbors, create incoming/outgoing relations with `+`.
- Several selected cards: Collect combines them into one entity group with bundled edges. A member has no card of its own while it is in the group; its relations and arrows end at the group.
- An instance card shows the properties that have a value. A relation to an instance that the view does not show is a row of the card.
- Notes: double-click or F2 opens a Markdown editor. Ctrl+Enter commits, Escape cancels.
- Copy, cut and paste: Ctrl+C, Ctrl+X, Ctrl+V on a canvas. The clip stays in the window. Paste creates new instances; cut and paste moves the placements.
- Paste arranges new placements near the pointer. Existing placements stay fixed. Copied frames move with their contents.
- The canvas fits the pasted placements so they remain visible.
- Paste raw RDF to add missing statements and show figures from the canvas notations. Existing resource IRIs remain unchanged.
- New statements use the configured file destinations. Named graphs require confirmation before paste discards their graph names.
- Copy as RDF in Edit or the canvas context menu copies readable Turtle. It includes selected statements and owned values, without placement metadata.
- Apply Layout: Layered (ELK) or Force (cola.js). The view then fits to its content.
- Use **Open as…** or **Open beside…** in a pane toolbar or context menu.
- Every model RDF file offers Source and Model. A view also offers Canvas. The workspace file also offers Settings.
- The workspace Model pane uses the current explorer query. Workspace metadata stays outside the model index.

### View notes

Select a view to edit its Markdown **Notes** in Properties. Like Label, the field saves when you leave it. Click its external-link icon to move editing into Theia’s Markdown editor beside the diagram. The Properties text area disappears while that editor is open.

Notes save automatically after a short pause in typing. Close the editor when you finish. Closing saves the latest text and restores the Properties field, without a save prompt. A failed save keeps the editor open with your text. Notes stay in the view file, not a separate Markdown file.

## Shapes

- A new node shape opens its name for edit. The typed name also sets the target class: the known class with that name, else a new class IRI from the name. Escape keeps the default name and sets no class.
- A property of a node shape is a row of its card, or a line to the box of its end: a node shape, a value set, an "in" or "one of" box, or a class pill. When a card arrives, the lines between it and the shown boxes are placed. ⇥ on a row shows the line; the return arrow on the line shows the row again. A box that ⇥ brought leaves with its last line.
- A property with a datatype, a node kind or no range is a row. Its end is private: it shows as a line only as a member of a logical constraint, with its own pill beside the card.
- A logical constraint (sh:or, sh:xone, sh:and) without a hub on the view is a row group: the operator, then its members. ⇥ on the operator row shows the hub and its member lines. Del or the return arrow on a member line removes the whole hub. A property under sh:not is a row with the tag «not».
- `+ attribute` adds an `xsd:string` property with cardinality 0..1. Click the cardinality badge to cycle 0..* → 0..1 → 1 → 1..*.
- Double-click a path or line label to edit the path. Double-click a pill to edit the target.
- Drag the logic handle of a property onto another property of the same shape to make an Or constraint.
- Value sets: `+ concept` and `+ member` add concepts to a SKOS scheme or collection. Drag a concept onto another to add a broader parent.
- Containers: a node shape card, an entity group, a value set and a "one of" box show their parts as rows. They move, resize and take Del in the same way. A part that the view draws, as its own card or as a line from the container, is not a row. ➟ on a row shows the part beside its row, with a line from the container. Remove that card or line to get the row back. In an entity group, ➟ takes the member out of the group.
- Propose Node Shapes from Data (on a class or instance) and Model → Propose Missing Shapes create shapes from the existing data. The result opens in a new view "proposed shapes". Review it: it describes the data, it is not a rule.
- A change of a path or a target class can propose a data migration. Apply it with "Apply to data", or dismiss it.
- In Properties, enter one predicate per line in Target subjects of or Target objects of. Each field selects the union of its predicates.
- Enter shape IRIs in Node constraints. These shapes check the same focus node. A property-level node constraint checks property values.
- Shape cards show their targets. Dashed arrows show predicate targeting and node constraints. These arrows do not change the data.
- The applicable-shape control shows unplaced shapes for an instance. The checked-instance control shows unplaced instances for a shape.
- Properties shows a form for each applicable shape. A shape can apply to a node that fails its constraints.

## Keys

| Key | Effect |
|---|---|
| F2 | Rename the selected element, or edit a note |
| F12 | Go to Source: open the file of the element at its line. With nothing selected on a canvas: the view file |
| Ctrl+T | Find an element |
| F3 / Shift+F3 | Next / previous occurrence of the element in views |
| Del | Remove the placement from the view. The model does not change |
| Ctrl+Del | Delete the element from the model, after confirmation |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo (shared model history, outside text inputs) |
| Escape | Cancel the current edit. It never commits |

## Settings

Open `workspace.trig` to show Workspace settings. A change writes the workspace file at once. It is not an undo step.

- **New subjects**: for Shapes, SKOS / Collections and Everything else, select Auto or File. Auto puts a new subject near subjects of its kind: shapes in the file with most node shapes, a concept or collection in the file of its scheme or collection, another subject in the file with most subjects of its class. With File, type a path or click Browse… A path that does not exist becomes a new file at the first write. Everything else also takes a new subject that Auto cannot place, for example the first subject of a new class. With Auto, that is the first Turtle file with statements.
- **Prefixes**: hover a row to edit or remove it. Add a prefix in the last row. Above 12 prefixes, a filter shows. A warning icon marks a namespace that does not end with `/` or `#`.
- **Exclude**: globs of files that are not model files, relative to the workspace folder. A change reads the files again.
- **Imported**: globs of imported (read-only) files, relative to the workspace folder. Import Files… is in this section and in the File menu.

The document toolbar has Open as and Open beside. Settings controls have Select in Explorer and More actions (Reset Prefixes to Defaults).

Person settings (theme, card, note and group text size, edge style, layout spacing) are Theia preferences. They are not in the workspace. The default edge style is Direct. Parallel direct edges use separate lanes that retain spacing when you zoom out. Vertical lanes reserve estimated label width. Self-links use wide loops with horizontal label runs and separate heights. These changes do not move cards. Direct edges can still cross other cards and unrelated labels.

## Imported files

An imported file is an official file that Catenary must not change. It is read only: Catenary reads it, but it refuses each change to its statements. You can add statements about its subjects. They go to the file of Everything else.

- Right-click a file in the file navigator and select Mark as Imported or Mark as Own. The workspace file stores the path.
- If a change edits an imported file, Catenary asks whether to mark it as own. Select Mark as Own to make the change, or Cancel to keep the file as it is.
- Properties shows an Imported row with the imported files of an instance. Imported values outside the form show as plain text.
- Mark as Imported writes pending changes first. A file with blank nodes in a format that Catenary does not write (N3, RDF/XML) cannot be marked. Import it instead.
- Validation does not check imported files as a whole, so large files do not slow down each edit. It checks your own statements, all statements about their subjects, and the types of the resources that they refer to.

To import official files:

1. Select File → Import RDF Files… or Import Files… in Workspace settings.
2. Select one or more RDF files.

A file that is already in the workspace is marked as imported where it is. For a file from outside the workspace, Catenary writes a Turtle copy to `imported/<name>.ttl` and marks the copy as imported. If one file cannot be read, Catenary imports none of them. Each blank node gets an IRI. Catenary adds a prefix of the file to the workspace prefixes if the workspace does not use that name or namespace. A warning names the prefixes that it did not add. The import reads the workspace again. This clears the undo history.

## Documents with views

A Markdown file of the workspace is a document. A document can show views between its paragraphs. A view embed is a standard Markdown image with the IRI of the view as its target:

```markdown
The system separates storage from presentation.

![Main](urn:name:Main)
```

The IRI identifies the view. The text in brackets is only a caption, so a new view label does not break the embed. A link such as `[Main](urn:name:Main)` stays a link.

To insert a view:

1. Open the Markdown file in the text editor.
2. Put the cursor where the view goes.
3. Right-click and select Insert View…, or run Insert View… from the command palette.
4. Select the view by its label.

## Export

Export Markdown… writes the documents of a folder and its subfolders to another folder. Each view embed becomes an image link to an SVG file in `_resources/`.

1. Right-click a folder in the file navigator.
2. Select Export Markdown….
3. Select the destination folder. The dialog starts at the last destination of this folder.

The export keeps the folder structure and the text of each document. Each view gives one SVG file, also when several documents embed it. The SVG shows the view at zoom 100 %, without selection, handles or edit controls. Links to documents of the folder do not change. Catenary copies linked images and attachments: a file in the folder goes to the same path, and a file outside the folder goes to `_resources/`.

The export stops and writes nothing in these cases:

- An embed names a view that does not exist, for example after a change of the view IRI. The message gives the file, the line and the IRI.
- The destination is the source folder or a folder in it.
- The export would overwrite a file that an earlier export did not write, or a file that changed after that export.

Catenary records the files that it writes in `_resources/.catenary-export.json`. A later export updates these files and removes the ones that it no longer writes. It does not change other files of the destination. A message reports links to missing files, folders and absolute paths. These links do not change.

## History and Git

If the workspace is in a Git repository, each write makes a commit of the changed files only (`git commit --only`). Other staged changes stay out of it. Source Control shows changes and history. A file changed outside Catenary is read again; this clears the undo history.

## Command line

`pnpm -s catenary` controls a running backend: read the model, run edit commands, run UI commands and answer prompts. See the [readme](../readme.md#command-line-interface).
