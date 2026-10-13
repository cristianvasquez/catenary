# What is Catenary

Catenary is a scribble tool for RDF models. You use it to make mockups: a draft of some shapes and some example data, drawn on a canvas, until the two agree. The name comes from the hanging chain models that Gaudí used to find the form of the Sagrada Família. You hang the parts, and the consistent form shows itself.

## How it is used

A modeling session has no fixed order. Sometimes you create the instances first and derive the shapes from them. Sometimes you draw the shapes first and then create instances to test them. You do not know a priori which one comes first, and Catenary does not force you.

- **The canvas is the main authoring tool.** A canvas shows the entities that you want to create or connect. You create a shape or an instance with the palette, and you connect two cards with a relation. The Properties panel edits the fields of the selected card.
- **Several canvases, one model.** Each canvas is a view of the same model. You open one view per facet of the design problem: the shapes, the example data, one feature. A change in one view shows in all of them.
- **Import from outside.** You can import data, shapes or ontologies from other files into a draft. Catenary copies the file into the workspace and locks it. You refer to its elements, but you do not change them.
- **Write it up and share it.** A Markdown document in the workspace can embed views. Export writes the document with its diagrams as SVG files, so you can share the result or put it in a repository.

The intended loop is: think, draw, check, write, share. The result is a small, consistent model that explains an idea.

## What it is not

Catenary does not replace mature RDF tools. It is designed for small datasets: a few files, some hundreds of elements. It is not a triple store, not an ontology editor for large vocabularies, and not a validation service. When a draft is done, take the files to the tool of your choice.

## Status and disclaimers

Catenary is a personal tool. I add a function when I need it, bit by bit, and my time is limited. Read these notes before you use it:

- **The application is incomplete.** Some paths work well, others are rough. The [open work](https://github.com/cristianvasquez/catenary/blob/main/spec/open.md) file lists known defects and open decisions.
- **The ergonomics are rough.** Some actions take more clicks than they should, and some panels are dense. I hope to make this better. Suggestions are welcome in the [issues](https://github.com/cristianvasquez/catenary/issues).
- **Each edit writes the files at once.** Use a copy of valuable data for experiments. Reads keep the statements, but merge the source named graphs of model files. Writes do not restore those graph names.
- **No blank nodes.** A read replaces each blank node with an IRI. The files that Catenary writes do not contain blank nodes.
- **Platforms.** Linux is tested. The Windows package is checked on a Windows runner. The macOS package is built, but not tested on macOS.

## Future work

In no fixed order:

- Richer editing of instances: tables and forms outside the canvas.
- Other notations for a view, beyond cards and lines.
- Better ergonomics of the common paths.

## Where to go next

- The [tutorial](/tutorial/01-new-workspace) builds a small bookshop model from an empty folder.
- The [reference](/reference/workspace) describes each part of the screen.
- The vocabularies define the terms of [view files](/vocab/view), of the [workspace file](/vocab/workspace) and of [notations](/vocab/notation).
