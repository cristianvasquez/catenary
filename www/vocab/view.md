# Catenary view vocabulary

The terms of view files: a view, the placements of elements and statements in a view, and the marks that live in a view.

Namespace: `https://cristianvasquez.github.io/catenary/vocab/view#` (prefix `view:`)

Turtle: [view.ttl](./view.ttl){target="_self"}

This page is generated from the Turtle file by `pnpm www:vocab`. Do not edit it.

## view:EntityGroup {#EntityGroup}

- Type: `rdfs:Class`
- Label: Entity group

A mark that groups entities of the model.

## view:FileRef {#FileRef}

- Type: `rdfs:Class`
- Label: File reference

A mark that links to a file.

## view:Frame {#Frame}

- Type: `rdfs:Class`
- Label: Frame

A mark with a label. The geometry of one view gives what is inside the frame.

## view:Note {#Note}

- Type: `rdfs:Class`
- Label: Note

A mark with Markdown text.

## view:Placement {#Placement}

- Type: `rdfs:Class`
- Label: Placement

Shows one element or one statement in one view. A placement of an element has view:element. A placement of a statement has rdf:reifies.

## view:View {#View}

- Type: `rdfs:Class`
- Label: View

A diagram of the model. A view is a named graph, and the graph IRI is also the view subject. Its rdfs:label is its name.

## view:arrow {#arrow}

- Type: `rdf:Property`
- Label: arrow

An arrow from one element to another. It is visual only and is not part of the model. Its placements keep it.

## view:color {#color}

- Type: `rdf:Property`
- Label: color
- Domain: [view:Placement](#Placement)
- Range: `xsd:string`

The color of a box or a line.

## view:description {#description}

- Type: `rdf:Property`
- Label: description
- Domain: [view:View](#View)
- Range: `xsd:string`

The text that describes a view.

## view:display {#display}

- Type: `rdf:Property`
- Label: display
- Domain: [view:Placement](#Placement)
- Range: `xsd:string`

The content of a box. The value "simple" shows the title and the tags only. Without a value, the box shows all its rows.

## view:element {#element}

- Type: `rdf:Property`
- Label: element
- Domain: [view:Placement](#Placement)

The element that a placement shows. The element is an IRI, often in another file.

## view:file {#file}

- Type: `rdf:Property`
- Label: file
- Domain: [view:FileRef](#FileRef)
- Range: `xsd:string`

The path of the linked file, relative to the view file.

## view:fromSide {#fromSide}

- Type: `rdf:Property`
- Label: from side
- Domain: [view:Placement](#Placement)
- Range: `xsd:string`

The side of the start box where a line starts: "top", "right", "bottom" or "left". It is a routing hint.

## view:height {#height}

- Type: `rdf:Property`
- Label: height
- Domain: [view:Placement](#Placement)
- Range: `xsd:integer`

The height of a box, in canvas units.

## view:keptByLines {#keptByLines}

- Type: `rdf:Property`
- Label: kept by lines
- Domain: [view:Placement](#Placement)
- Range: `xsd:boolean`

On the placement of a box (true): a line or a hub brought the box. The box leaves the view with its last line. A box that the user placed has no value and stays.

## view:member {#member}

- Type: `rdf:Property`
- Label: member
- Domain: [view:EntityGroup](#EntityGroup)

An entity of an entity group.

## view:text {#text}

- Type: `rdf:Property`
- Label: text
- Domain: [view:Note](#Note)
- Range: `xsd:string`

The Markdown text of a note.

## view:toSide {#toSide}

- Type: `rdf:Property`
- Label: to side
- Domain: [view:Placement](#Placement)
- Range: `xsd:string`

The side of the end box where a line ends: "top", "right", "bottom" or "left". It is a routing hint.

## view:vertices {#vertices}

- Type: `rdf:Property`
- Label: vertices
- Domain: [view:Placement](#Placement)
- Range: `xsd:string`

The bends of a line from its start to its end, as "x,y x,y ..." in canvas units.

## view:view {#view}

- Type: `rdf:Property`
- Label: view
- Domain: [view:Placement](#Placement)
- Range: [view:View](#View)

The view of a placement.

## view:width {#width}

- Type: `rdf:Property`
- Label: width
- Domain: [view:Placement](#Placement)
- Range: `xsd:integer`

The width of a box, in canvas units.

## view:x {#x}

- Type: `rdf:Property`
- Label: x
- Domain: [view:Placement](#Placement)
- Range: `xsd:integer`

The horizontal position of a box, in canvas units.

## view:y {#y}

- Type: `rdf:Property`
- Label: y
- Domain: [view:Placement](#Placement)
- Range: `xsd:integer`

The vertical position of a box, in canvas units.
