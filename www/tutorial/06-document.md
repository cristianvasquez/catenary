# 6. Write it up

A Markdown file in the workspace is a document. It can show a view between its paragraphs, and the export writes the view as an SVG file.

## A document with a view

1. Right-click the workspace folder in the Explorer and select **New File**. Name it `notes.md`.
2. Write a few lines. Put the cursor on an empty line.
3. Right-click and select **Insert View…**. Select **Books**.

The editor inserts a Markdown image whose target is the IRI of the view:

```markdown
![Books](urn:name:Books)
```

![The document with an embedded view](/images/scratch-document.png)

The IRI identifies the view. The text in brackets is only a caption, so a new view label does not break the embed.

## Export

1. Select `notes.md` in the Explorer.
2. Right-click it and select **Export Markdown…**.
3. Select **Choose…** and select a destination folder outside the workspace.
4. Select **Export**.

![The Export Markdown dialog](/images/scratch-export.png)

The export writes `notes.md` to the destination, with the embed replaced by an image link to `_resources/Books.svg`. The SVG shows the view at zoom 100 %, without selection or edit controls. A later export of the same files updates them.

You now have a document with a diagram that you can share, and a folder of RDF files that holds the model behind it. The [reference](/reference/workspace) describes each part of the screen in detail.
