# Workspace and files

A workspace is a folder of RDF files. The files are the model: Catenary reads them into an in-memory index, and each edit writes a text patch to the file that holds the statement. A change on disk by another program is read back.

**Caution:** each edit writes the files and can make a Git commit. Use a copy of valuable data for experiments. Reads keep the subject, predicate and object of each statement, but merge the source named graphs of model files. Writes do not restore those graph names. View files keep their view graph IRI.

## Open or create a workspace

The first start copies the bookshop example to `~/.local/share/catenary/workspaces/example`, or `$XDG_DATA_HOME/catenary/workspaces/example`. Catenary edits the copy. A non-empty default workspace is never overwritten. Set `CATENARY_WORKSPACE` to open another folder.

1. Select **File → Open Workspace**.
2. Select a folder or a `workspace.trig` file.

If the folder has no workspace file, Catenary uses default settings and asks once where new subjects go. **File → New Workspace** proposes `workspace.catenary.trig` as the file name. Catenary creates the proposed files (`<name>.shapes.ttl`, `<name>.skos.ttl`, `<name>.data.ttl`) and `views/main.view.trig`.

In the desktop app, each workspace runs in its own process with its own window. **File → New Window** and a workspace opened in a new window start a new process. If the workspace is already open, its window comes to the front.

## Which files are the model

All supported RDF files in the folder and its subfolders are part of the model: Turtle, TriG, N-Triples, N-Quads and JSON-LD (read and write), N3 and RDF/XML (read-only). Hidden files, `*.bak`, `node_modules`, nested workspaces and the exclude globs of the settings are not part of it.

A file has no fixed role. What a file contains comes from its triples. Shapes, SKOS vocabularies, instances and views can sit in any file. The Explorer shows a letter for what each file holds: **V** views, **S** shapes, **C** concepts, **I** instances, **W** workspace settings. **D** marks the default file for new subjects, and a lock marks a locked file.

## The Explorer

A file in the Explorer opens what it holds, not what its name says. A view file of the open workspace shows the view. The workspace file shows the Workspace settings. Another model RDF file opens in its Model explorer. Other files open as text. Use **Open With** to open any file as text.

Selecting a file of another workspace shows its text. Double-click it or press Enter to open that workspace and its view. A file that mixes workspace settings and a view opens as text with a message: move the view into its own file.

Drag a file from the Explorer onto a canvas to link to it. A view file gives a view reference, another file a file reference.

## Settings

Open the workspace file to show the Workspace settings. A change writes the workspace file at once. It is not an undo step.

- **New subjects**: for Shapes, SKOS / Collections and Everything else, select Auto or File. Auto puts a new subject near subjects of its kind: shapes in the file with most node shapes, a concept or collection in the file of its scheme or collection, another subject in the file with most subjects of its class. With File, type a path or click Browse… A path that does not exist becomes a new file at the first write. Everything else also takes a new subject that Auto cannot place, for example the first subject of a new class.
- **Prefixes**: hover a row to edit or remove it. Add a prefix in the last row. A warning icon marks a namespace that does not end with `/` or `#`.
- **Exclude**: globs of files that are not model files, relative to the workspace folder. A change reads the files again.
- **Locked files**: globs of locked (read-only) files, relative to the workspace folder.
- **Validation**: what SHACL validation checks after each change. **Off** shows no problems and no badges. **Open views** checks only the elements on the open views. It is faster on a large model, but a shape that reads elements outside the open views can report too much or too little. **All** checks the whole model. The status bar shows the mode.
- **Auto-commit**: **On** commits the written files to Git 60 seconds after the last content edit, and at a save. **Off** (the default) writes the files and makes no commit. Outside a Git repository, Catenary makes no commit and the section shows "not a git repository".
- **Label language**: a language tag, for example `en`. Labels in this language show first (`rdfs:label`, `skos:prefLabel`, `sh:name`). `en` also takes `en-GB`. Empty: a label without a language, else the first in order.

Person settings (theme, text sizes, edge style, layout spacing) are preferences of the application. They are not in the workspace.

## Locked files and import

A locked file is a file that Catenary must not change, for example an official vocabulary. Catenary reads it, but it refuses each change to its statements. You can add statements about its subjects. They go to the file of Everything else.

- Right-click a file in the Explorer and select **Lock** or **Unlock**. The workspace file stores the path.
- If a change edits a locked file, Catenary asks whether to unlock it. Select Unlock to make the change, or Cancel to keep the file as it is.
- Properties shows a Locked row with the locked files of an instance. Locked values outside the form show as plain text.
- A file with blank nodes in a format that Catenary does not write (N3, RDF/XML) cannot be locked. Import it instead.
- Validation does not check locked files as a whole. It checks your own statements, all statements about their subjects, and the types of the resources that they refer to.

To import files:

1. Select **File → Import RDF Files…**, or **Import Files…** in the Workspace settings.
2. Select one or more RDF files.

A file that is already in the workspace is locked where it is. For a file from outside the workspace, Catenary writes a Turtle copy to `imported/<name>.ttl` and locks the copy. If one file cannot be read, Catenary imports none of them. Each blank node gets an IRI. Catenary adds a prefix of the file to the workspace prefixes if the workspace does not use that name or namespace. The import reads the workspace again. This clears the undo history.

## Old namespaces

Catenary now uses published namespaces for its own terms, under `https://cristianvasquez.github.io/catenary/vocab/`. Older workspaces use namespaces that start with `osg://vocab/`, for example `osg://vocab/view#`. An old workspace still opens. Catenary reads each old term as the new term, and a save writes the new namespace.

To rewrite all files of an old workspace at one time:

1. Close the workspace in Catenary.
2. Open a terminal in the Catenary repository.
3. Run `pnpm migrate-vocab <folder> --dry-run` to see which files change.
4. Run `pnpm migrate-vocab <folder>` to write the files.

The command changes only the namespace text. It keeps the formatting and the comments of each file. It does not change a file without old terms. The packaged desktop app does not include the command.

## History and Git

If the workspace is in a Git repository and Auto-commit is On, Catenary writes each edit at once and commits later. A commit runs 60 seconds after the last content edit, at a save, when Catenary stops and when another workspace opens. A move or a resize alone does not start the 60 seconds. The commit contains the changed files only. Other staged changes stay out of it. The commit message gives the kinds of edits with their counts and the views that changed, for example `Catenary: setBounds ×12, createRelation ×2 (tasks)`. The **Source Control** view shows changes and history. A file changed outside Catenary is read again. This clears the undo history.

All windows of a workspace share one undo history. One edit is one transaction and one undo step.

## Model index failure

Catenary keeps the model in an in-memory index. If the index fails, Catenary reads the files again once. A warning says: "The model index failed and was read again from the files. Undo history was cleared." Edits that were not written yet can be lost. If the second read fails too, Catenary shows one error and stops reading. Restart Catenary.
