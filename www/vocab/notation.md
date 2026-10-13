# Catenary notation vocabulary

The terms of notations (figure shapes and their roles) and of the figures that Catenary derives in memory. SHACL of views, placements and notations: docs/notation/catenary.shapes.ttl in the repository.

Namespace: `https://cristianvasquez.github.io/catenary/vocab/notation#` (prefix `nt:`)

Turtle: [notation.ttl](./notation.ttl){target="_self"}

This page is generated from the Turtle file by `pnpm www:vocab`. Do not edit it.

## nt:Connector {#Connector}

- Type: `rdfs:Class`

A statement between two figures.

## nt:Figure {#Figure}

- Type: `rdfs:Class`
- Subclass of: `rdfs:Class`

A figure shape. It uses sh:target\*, sh:property and sh:path, but it is not a sh:NodeShape. It is the class of its figures: &lt;urn:fig:Person&gt; a cln:Class.

## nt:Kind {#Kind}

- Type: `rdfs:Class`

## nt:Notation {#Notation}

- Type: `rdfs:Class`

An ordered list of figure shapes for one vocabulary.

## nt:Role {#Role}

- Type: `rdfs:Class`

## nt:Row {#Row}

- Type: `rdfs:Class`

A line of text inside a box. A row of a Hub part has sub-rows (nt:row).

## nt:connector {#connector}

- Type: `rdf:Property`
- Range: [nt:Connector](#Connector)

## nt:end {#end}

- Type: `rdf:Property`

The figure where a line, a connector or a hub ends.

## nt:figure {#figure}

- Type: `rdf:Property`
- Domain: [nt:Row](#Row)

The part figure that this row stands for.

## nt:figures {#figures}

- Type: `rdf:Property`
- Domain: [nt:Notation](#Notation)
- Range: `rdf:List`

## nt:focus {#focus}

- Type: `rdf:Property`

The element that the figure shows.

## nt:gatherWith {#gatherWith}

- Type: `rdf:Property`
- Domain: [nt:Figure](#Figure)

Other shapes whose property shapes add rows to this figure.

## nt:inlineClose {#inlineClose}

- Type: `rdf:Property`

On a Box figure shape: the text after its parts when a row shows the box inline.

## nt:inlineOpen {#inlineOpen}

- Type: `rdf:Property`

On a Box figure shape: the text before its parts when a row shows the box inline.

## nt:inlineSeparator {#inlineSeparator}

- Type: `rdf:Property`

On a Box figure shape: a row whose end is this box shows its parts inline, with this separator. At most three parts; else two parts and "+N".

## nt:keptByLines {#keptByLines}

- Type: `rdf:Property`

On a Box figure shape (true): the box is on the canvas only as the end of lines. It leaves the view when a removal takes its last line that ends at it ("in" and "one of" boxes, class pills). A line that starts at the box (an alternative of "one of") does not keep it. On a placement, view:keptByLines does the same for one box: the box that a line or hub brought (⇥ on a row). A box that the user placed has no flag and stays.

## nt:kind {#kind}

- Type: `rdf:Property`
- Domain: [nt:Figure](#Figure)
- Range: [nt:Kind](#Kind)

## nt:linkEnd {#linkEnd}

- Type: `rdf:Property`

On a part property shape (true): as the end of a link, an unplaced part resolves to the owner box. Example: a member of an entity group.

## nt:member {#member}

- Type: `rdf:Property`

A member figure of a hub.

## nt:notations {#notations}

- Type: `rdf:Property`
- Range: `rdf:List`

The notations of a view, in order. An element gets the figure of the first figure shape that targets it. A placed element shows its figure. An unplaced element shows as a row of each shown figure that has it as a part.

## nt:openEnd {#openEnd}

- Type: `rdf:Property`

On a Line figure shape: a line without an nt:to value ends at a private pill with this text, drawn beside its start (as nt:private). The pill has no placement and no element ("any").

## nt:order {#order}

- Type: `rdf:Property`
- Domain: [nt:Row](#Row)

## nt:private {#private}

- Type: `rdf:Property`

On a property shape with nt:role nt:to (true): the end is private to the line. It is drawn as a pill beside the start, with the label of the value. It has no figure, no placement and no element, and lines do not share it. A Line whose end is private or open (nt:openEnd) shows only as a member of a shown hub: the only reason to draw such a line is a constraint between lines. Otherwise the property is a row.

## nt:role {#role}

- Type: `rdf:Property`
- Range: [nt:Role](#Role)

## nt:row {#row}

- Type: `rdf:Property`
- Range: [nt:Row](#Row)

## nt:select {#select}

- Type: `rdf:Property`
- Range: `rdf:List`

Keep only these values. A filter, not a constraint.

## nt:start {#start}

- Type: `rdf:Property`

The figure where a line or a connector starts.

## nt:statement {#statement}

- Type: `rdf:Property`
- Domain: [nt:Connector](#Connector)

## nt:style {#style}

- Type: `rdf:Property`

A style key. On a property shape with nt:link: the style of its connectors.

## nt:text {#text}

- Type: `rdf:Property`, [nt:Role](#Role)

Each value is a text line: &lt;label of the path&gt;: &lt;label of the value&gt;.

The text of a row or of a connector.

## nt:title {#title}

- Type: `rdf:Property`, [nt:Role](#Role)

The first value is the title.

A title. On a figure shape: fixed for all its figures.

## nt:unplaced {#unplaced}

- Type: `rdf:Property`

A link without a placement: nt:AsRow (default) or nt:Hidden. Hidden: when both ends are shown, the link is not part of the view; the renderer draws it dashed while an end is selected. When the other end is not shown, a hidden link is a row too: no information disappears. On a figure shape: the value for the links that nt:gatherWith adds.

## nt:value {#value}

- Type: `rdf:Property`

A fixed value of the role, used instead of the values of sh:path. Example: the tag «not» of a property shape under sh:not.

## nt:when {#when}

- Type: `rdf:Property`

Real SHACL conformance of the focus. On a figure shape: the figure applies only to a focus that conforms. On a property shape of a figure shape: the role uses its path only when the focus conforms.

## nt:anchor {#anchor}

- Type: [nt:Role](#Role)

A member of a Hub.

## nt:AsRow {#AsRow}

- Type: `rdfs:Resource`

## nt:Box {#Box}

- Type: [nt:Kind](#Kind)

No ends. Its placement gives position and size.

## nt:covers {#covers}

- Type: [nt:Role](#Role)

On a Hub: the predicate from each member to the end of the hub. While the hub is shown, it draws those statements: they are not separate lines, not dashed on selection, and an arrival does not place them.

## nt:default {#default}

- Type: `rdfs:Resource`

Holds the default cascade (nt:notations) of a view without nt:notations.

## nt:from {#from}

- Type: [nt:Role](#Role)

The start of a Line. Several: the first by sh:order with a value. None: the figure it is a part of.

## nt:Hidden {#Hidden}

- Type: `rdfs:Resource`

## nt:Hub {#Hub}

- Type: [nt:Kind](#Kind)

Members (nt:anchor), and optionally an end (nt:to). Its placement gives its position. A hub and its member lines are one unit: the hub placement also shows the member lines, and a member has no placement of its own. Without a hub placement, the hub and its members are rows of their owner.

## nt:Line {#Line}

- Type: [nt:Kind](#Kind)

A start and an end. Its placement has no geometry. It is drawn only when both ends have a shown figure.

## nt:link {#link}

- Type: [nt:Role](#Role)

Each statement is a connector. With a placement of the statement it is a line, else nt:unplaced decides.

## nt:max {#max}

- Type: [nt:Role](#Role)

Upper bound of the multiplicity.

## nt:min {#min}

- Type: [nt:Role](#Role)

Lower bound of the multiplicity.

## nt:ModelShapes {#ModelShapes}

- Type: `rdfs:Resource`

The model node shapes that target the focus. Each of their property shapes with a value is one row. A property shape without a value gives no row. Literal values are text; IRI values are links. The members of a logical constraint with sh:path are a row group (rule 7). A property shape with the path of the title role gives no row.

## nt:part {#part}

- Type: [nt:Role](#Role)

Each value is an element. Without a placement, its figure is a row of this figure. Several part property shapes: rows in sh:order.

## nt:styled {#styled}

- Type: [nt:Role](#Role)

The value is a style key.

## nt:tag {#tag}

- Type: [nt:Role](#Role)

Each value is shown above the title as «label».

## nt:TargetPredicate {#TargetPredicate}

- Type: `rdfs:Resource`

As nt:title of a figure shape: the label of the predicate through which sh:targetObjectsOf reached the focus.

## nt:to {#to}

- Type: [nt:Role](#Role)

The end of a Line or a Hub. Several: the first by sh:order with a value.
