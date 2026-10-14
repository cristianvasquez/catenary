# Documents and export

A Markdown file of the workspace is a document. A document can show views between its paragraphs, and the export writes the views as SVG files.

## Embed a view

A view embed is a standard Markdown image with the IRI of the view as its target:

```markdown
The system separates storage from presentation.

![Main](urn:name:Main)
```

The IRI identifies the view. The text in brackets is only a caption, so a new view label does not break the embed. A link such as `[Main](urn:name:Main)` stays a link.

To insert a view:

1. Open the Markdown file in the text editor.
2. Put the cursor where the view goes.
3. Right-click and select **Insert View…**, or run it from the command palette.
4. Select the view by its label.

## Export

**Export Markdown…** writes the selected Markdown files and folders to another folder. A selected folder includes its subfolders. Each view embed becomes an image link to an SVG file in `_resources/`.

1. Select the Markdown files and folders in the Explorer.
2. Right-click the selection and select **Export Markdown…**.
3. Select **Choose…** and select the destination folder.
4. Clear the checkbox of each document that you do not want to export.
5. Select **Export**.

The root is the deepest folder that contains the selection. The export keeps the folder structure under the root. Each view gives one SVG file, also when several documents embed it. The SVG shows the view at zoom 100 %, without selection or edit controls. Linked images and attachments are copied: a file under the root goes to the same path, a file outside the root goes to `_resources/`.

The export stops and writes nothing when:

- an embed of a checked document names a view that does not exist;
- a selected file or folder does not exist;
- the destination is the root or a folder in it;
- the export would overwrite a file that an earlier export did not write, or a file that changed after that export.

Catenary records the files that it writes in `_resources/.catenary-export.json`. A later export updates these files and removes the ones that it no longer writes. It does not change other files of the destination.

## Run the last export again

**Run Last Markdown Export** repeats the last successful export of the workspace. It uses the same files, folders, destination and unchecked documents, and it shows no dialog. Use it to update the exported documents after you change a view.

1. Open the command palette.
2. Select **Run Last Markdown Export**.

A document that you added to an exported folder is also exported. Without an earlier export, the command shows a message and writes nothing.
