-- | Catenary interaction contract: elements as the user sees them, window state, actions, keys, canvas, panels, appearance.
-- Data and transaction rules: spec/manifest.hs. Unresolved decisions and known gaps: spec/open.md. Design rules: the index at the top of spec/manifest.hs.
-- This file defines the target behavior. It does not certify the implementation. open.md names each known difference.
-- The file is a Haskell module. pnpm check typechecks it with spec/manifest.hs (scripts/check-manifests.mjs).
-- Signatures carry the contract. Equations (endsOf, dependsOn, cascade, style) are rules. Other bodies are stubs at the end.
-- Sections go from concepts to details. Code comments cite section numbers (§n): keep them stable.

module Catenary.UiManifest where

import Control.Applicative ((<|>))
import Catenary.Manifest (EditCommand, Iri, Side, manifestOnly)

-- 1. Elements and layers -----------------------------------------------------

-- | An element is an IRI resource or a triple. Its statements define its content.
-- A layer classifies statements, not elements or files. One element can have statements in several layers.
-- Diagram content never changes Domain statements.
data Resource = Node Iri | Triple Iri Iri Iri deriving Eq   -- a triple element is a connector: its object is an IRI
type Element = Resource
type Statement = (Resource, Iri, Resource)
data Layer
  = Domain    -- instances, relations, SKOS concepts, schemes and collections
  | Shapes    -- node shapes, property shapes, logical constraints
  | Project   -- views, placements, marks, entity groups, styles, workspace settings
layer :: Statement -> Layer

-- 2. Views, placements and marks ---------------------------------------------

-- | A view is an element. Its canvas shows its placements.
-- A placement relates one element to one view. It supplies position and appearance. A placement has no placement.
-- A view reference is a placement of a view. A placement row in a listing stands for the placement itself.
isView, isPlacement :: Element -> Bool
elementOf, viewOf :: Element -> Element   -- of a placement: the element that it places, and its view
placements :: Element -> [Element]        -- the placements of an element, on all views

-- | An element has at most one own placement per view. A figure can also show it as a part.
-- Several figures can show the same part on one view. Each part belongs to the placement that shows it.
atMostOnce :: Element -> Element -> Bool
data Part = Part Element Resource
parts :: Element -> [Part]
shownBy :: Element -> Element -> [Element]   -- element, view: the placements that show the element there, own or as a part

-- | A connector is a triple with an IRI object. Its ends are its subject and object, never other connectors.
-- It ends at the figure of each end when the view shows it, else at a shown box that has that end as a nt:linkEnd part
-- (the entity group of a member).
-- Arrival: placing an element (add, drag, paste, expand) also places, until nothing changes, each hub whose ends are then
-- shown, each line with a shown start and end, and each link between two shown figures. Only what touches a figure that
-- this arrival placed. A statement that a shown hub covers is not placed. The user removes what they do not want.
-- Removing a connector placement stores no hidden state.
-- A hidden connector draws dashed while an end is selected (Links below). A click places it. Placed connectors draw solid.
endsOf :: Element -> [Element]
endsOf (Triple s _ o) = [Node s, Node o]
endsOf (Node _) = []
attachments :: Element -> Element -> [Element]   -- connector, view: the figure at each end

-- | A mark exists through its placements. Removing its last placement deletes the mark.
-- A mark can have placements on several views. Its statements stay in the view file where the user made it.
-- Mark classes: Note (Markdown), Frame (label), FileRef (file path), EntityGroup, and a future Drawing.
-- An arrow is a Project triple with predicate view:arrow. It also exists through its placements.
-- A file reference breaks when its target file moves. Files are not elements.
keptByPlacements :: Element -> Bool

-- | Frame membership comes from placement geometry. An element is inside at most one frame per view.
inside :: Element -> [Element]

-- | Figures (ADR 0014). A notation is an ordered list of figure shapes. A view names its notations (nt:notations), else
-- it uses the default cascade: marks, SHACL, value sets, instances. An element gets the figure of the first figure shape
-- that targets it and whose nt:when it conforms to. There is no statement ownership.
-- Figures are derived from the data and the notations. They do not depend on placements. They are never stored.
-- Style keys of the figure shape (shape, pill, valueSet, note, frame, reference, group) select the drawing. They are not kinds.
-- Notations: packages/rdf/notations/. Vocabulary: docs/notation/notation.ttl.
data Kind
  = Box      -- geometry from its placement; view:display "simple" shows the title and the tags only
  | Line     -- a start and an end; no geometry; drawn only when both ends are shown
  | Hub      -- members and an optional end; an optional position
data Role = Title | Tag | Text | Min | Max | PartRole | LinkRole | From | To | Anchor | Covers | Styled
data FigureShape = FigureShape { kind :: Kind, roles :: [Role] }
data Fig = Fig { focus :: Element, shape :: FigureShape, figParts :: [Element], links :: [Statement] }
figureOf :: Element -> Element -> Maybe Fig   -- view, element

-- | Parts and rows. A figure lists all its parts. A part is a row of its owner while the view does not draw the part.
-- A placed Line part draws from its owner. A placed Box part is a part line from its owner.
-- Rows follow sh:order, then text rows, then parts. A row whose end is a list box shows the box inline:
-- "xsd:date | xsd:gYear", "{Civil, Religious}". At most three parts, else two parts and "+N".
-- Without a hub placement, a hub is a row group of its owner: its title, then one sub-row per member.
-- Instance cards gather the property shapes of the model shapes that target the focus: one row per value.
-- A property shape without a value gives no row. The members of a logical constraint are a row group.
-- A gathered row with the path of the title is omitted.
-- An entity-group member is a part of the group (nt:linkEnd). It has no own placement while it is in the group.

-- | Links. A link (nt:link) is a statement between two figures. It is a line when the view places the statement.
-- Else nt:unplaced decides: a row (default) or hidden. A hidden link is not part of the view. It draws dashed while an end
-- is selected. A hidden link whose other end is not shown is a row: no information disappears.

-- | Lines. A Line starts at each value of its first nt:from with values. Without nt:from it starts at each figure that has
-- it as a part, so a shared property shape draws one line from each owner. Several nt:to: the first by sh:order with a value.
-- A private end (nt:private: datatype, node kind) or an open end ("any") is a pill of that line only, beside its start, with no
-- placement and no element. Lines do not share it. Such a line shows only as a member of a shown hub, else the property is a row.

-- | Hubs. A hub and its Line members are one unit. The hub placement shows the member lines.
-- A Line member has no placement of its own. A Box member is an end of the hub: it needs its own placement.
-- A shown hub draws the statements that it covers (nt:covers). They are not separate lines.

-- | Text rule. A label is rdfs:label, skos:prefLabel or sh:name, else the local name. A predicate, a datatype and a path
-- show prefix:local. An instance field without sh:name shows the local name of its predicate.
-- Multiplicity: [1], [0..1], [1..*], [0..*]. Code: shapes-doc.ts (compactIri, shortIri, formatPath, cardinalityText,
-- rangeText). Renderer defaults: multiplicity is a clickable chip, an instance card shows its class as a header line,
-- and a link label shows the predicate only.

-- | Badges. Validation is not part of the figures. A shown figure, row or line whose element IRI is a sh:focusNode of a
-- result in urn:trellis:validation shows a badge. A row badge uses the IRI of the part of the row, else the badge is on its box.

-- | Dependencies. Cascades contain only placements and elements that depend on placements.
-- A placement needs its element and its view. A Line placement also needs a shown figure at each end.
-- A hub placement needs both ends of each Line member and the placement of each Box member.
-- A box kept by lines leaves when a removal takes its last line: "in" and "one of" boxes and class pills (nt:keptByLines on the
-- figure shape), and a box that a line or hub brought (view:keptByLines true on its placement). A box that the user placed stays.
-- A mark disappears with its last placement. The removed elements return as rows of their owners.
-- This model does not define statement deletion. That policy is open (open.md D1).
data Dependency = Needs [Element] | KeptBy [Element]
dependsOn :: Element -> [Dependency]
dependsOn x
  | isPlacement x = Needs [elementOf x, viewOf x] : [KeptBy (shownBy e (viewOf x)) | e <- endsOf (elementOf x)]
  | keptByPlacements x = [KeptBy (placements x)]
  | keptByLines x = [KeptBy (linesTo x)]
  | otherwise = []
keptByLines :: Element -> Bool
linesTo :: Element -> [Element]   -- the shown Line and hub placements that end at the box of the element
everything :: [Element]
cascade :: Element -> [Element]
cascade x = go [x]
  where
    go gone = case [y | y <- everything, y `notElem` gone, any (broken gone) (dependsOn y)] of
      [] -> gone
      new -> go (gone ++ new)
    broken gone (Needs ys) = any (`elem` gone) ys
    broken gone (KeptBy ys) = not (null ys) && all (`elem` gone) ys
-- Invariant: deleting e leaves no placement of e. Removing a placement can delete its last dependent mark.

-- 3. Window state and selection ----------------------------------------------

-- | Each window owns its selection, documents, viewports and transient controls. Graph edits share the backend history.
-- At most one transient is active. Viewport changes and listing expansion are not graph edits.
data UiState = UiState
  { documents :: [Document]
  , active :: Maybe Document
  , selection :: UiSelection
  , viewports :: Document -> Viewport
  , listings :: ListingState
  , transient :: Maybe Transient
  }
data Viewport
data ListingState
data Transient = Menu | Picker | InlineInput | NoteEditor | Dialog

-- | A file opens its view, the Workspace settings or a text editor. A view and the settings can switch to source text.
-- Opening a document makes it active. It does not change the selection. Selection and active document are independent.
-- A browser URL with ?view=<view-id> opens that view after layout restoration, overriding the restored active tab.
-- The view must belong to the current workspace. An unknown ID shows an error and keeps normal startup behavior.
-- The URL does not select a workspace or start a backend.
-- A file with several views is open (open.md D4).
data Document = OpenView Element | OpenWorkspace | AsText FilePath
documentsIn :: FilePath -> [Document]

-- | Click replaces the selection. Ctrl+click adds, also from another canvas. Selected canvas items are placements or parts.
-- Listings select their row elements. Other panes show highlights, not their own selections.
data UiSelection = UiSelection { items :: [Selected], source :: Pane }
data Selected = SelElement Element | SelPart Part
data Pane = OnCanvas | InListing Listing
data Listing = Tree | Results

-- | Tree and Results highlight selected elements, their placements and the elements of selected placements.
-- A closed folder that contains a highlight is marked, not opened. Placements highlight on the active canvas only (open.md D2).
-- A selected part highlights its resource in Tree when Tree contains it.
highlight :: UiSelection -> Pane -> [Highlighted]
data Highlighted = Row Element | ClosedFolder String | OnActiveCanvas Element

-- 4. Actions and keys --------------------------------------------------------

-- | One operation has one definition on every surface. The selected items set its scope.
-- A placement scopes an operation to its view. Any other element scopes it across views.
-- place e v: place e on v, with the connector ends that v does not show. An own placement makes it a no-op.
-- remove accepts placements only. delete on a canvas placement deletes its element.
-- A listing row acts on its own element, also when that element is a placement.
-- Each graph operation is one EditCommand (spec/manifest.hs §5). Go to Source changes no graph.
place :: Element -> Element -> EditCommand
setStyle :: Resource -> Style -> EditCommand
setGeometry :: Element -> Geometry -> EditCommand
remove, delete :: Element -> EditCommand
goToSource :: Element -> IO ()

-- | An action uses the selection. The backend decides applicability from store facts and selected items, never widget focus.
-- Use all types of each selected IRI. A preferred display kind does not hide actions of another type.
-- Applicable actions show in menus, keys and the Properties action toolbar. A disabled action shows its reason.
-- With several items, an action needs all items to apply, or an explicit arity rule. It sends one EditCommand.
-- An empty selection allows surface actions such as New Instance or Apply Layout.
-- Add to Current View takes the active view as a parameter, not as the selection scope.
-- Rules: packages/model/src/actions.ts. Query: selectionActions.

-- | A control acts on its own part, not on the selection. Its label or tooltip states the effect.
-- A control can delete a row that the keys cannot target. Controls do not redefine key meanings.

-- | Keys.
-- Del removes placements from their views. It never falls back to delete from the model.
-- A listing selection of ordinary elements gives Del no action. Placement rows carry their placement scope.
-- A box row is not a key target. Its own control changes it (exception for property rows: open.md G10).
-- Ctrl+Del deletes elements after confirmation.
-- Ctrl+Z and Ctrl+Shift+Z undo and redo graph edits. A focused text input keeps its own text keys.
-- F2 renames, or edits a note. Ctrl+T finds an element. F3 and Shift+F3 go to the next and previous occurrence.
-- F12 is Go to Source.

-- | Text edits. Escape cancels a transient edit. It never commits. Enter accepts a single-line edit.
-- A click outside a text input commits. A click outside a picker, dialog or menu cancels it.
-- Note keys: §5 Notes.

-- | Creation follow-up. After creation, select and reveal the new element where the gesture took place.
-- Focus its first editable field with the default value selected: an inline field first, else the Element section.
-- The field is the label, the property path or the note text. Default labels: "unnamed <kind> N". Notes: "Note".
-- Enter accepts. Escape drops the typed value but keeps the new element with its default value.
-- Creation and the accepted text edit are separate undo steps. Undo, not Escape, removes the new element.
-- A new node shape: the accepted name also sets its target class, in the same undo step. The class is the known class with that name, else the name IRI. Reason: a shape usually targets the class of its name.
-- Rename, placement and connection to existing elements start no follow-up.
data Field
followUp :: Element -> Field

-- | Go to Source accepts one item of any kind. Several items give no action.
-- A canvas placement resolves to its element. A placement row resolves to the placement.
-- An empty selection on a canvas resolves to its view: Go to Source opens the view file.
-- Find the subject statements, or the connector triple. Without subject statements, find statements with the element as object.
-- One file opens directly. Several files give a picker with the first statement line of each file.
-- The file opens as text at that line. An unknown line opens the file without a position.

-- | Delete confirmation names the affected elements and views, and the effects in Domain, Shapes and Project.
-- View deletion also names the target view and counts incoming references, grouped by containing view.
-- Two references from one view count twice. State that Domain data stays unchanged.
-- Offer Cancel and "Delete view and references". With no incoming references, omit that warning and list, but still confirm.
-- Delete the view and its incoming references in one command. Undo restores both and the view content.
-- Removing one view reference does not change its target or other references. Removing a frame keeps its content.
-- A failed deletion leaves the store unchanged. Save and reload keep a successful deletion.

-- 5. Canvas ------------------------------------------------------------------

-- | Palette: Model tools for Shape, Scheme and one tool per class with a target-class shape. View tools: Group and Note.
-- Class tools follow the metamodel after edits, undo and reload.
-- Drag sources: a class folder creates an instance. Element rows place cards, relations or view references.
-- A file from the navigator gives a view reference for a view file, else a file reference. A broken reference shows a warning.

-- | Immediate feedback (ADR 0013). A move or resize shows at once. The canvas keeps the bounds of each box that it moved
-- until a server model has them. An older server model does not move the box back. After 3 s without confirmation the server wins.

-- | Halo. One selected item shows its halo. Several show a shared frame with Collect, Remove and More actions.
-- Card controls: Reveal, Remove, More actions, incoming and outgoing expansion, incoming and outgoing creation (+).
-- The direction of a creation control decides which end is the selected card.
-- Incoming expansion of a node-shape card adds the chosen source shape cards. Their properties to the card become edges (§6).
-- Note halo: Remove, More actions, arrow drag. Frame and reference halo: Remove, More actions. Entity-group halo: also Expand.
-- Halo controls draw above diagram content with opaque backgrounds. Positions and labels: diagram/card-chrome.ts.

-- | Relation creation. Drag a creation control onto a valid card. Several valid predicates give a picker.
-- A click on the control, or a release on empty canvas, opens end choices. Typed text can create a new end.
-- Incoming creates a subject. Outgoing creates an object. Shape controls use property owners and targets.
-- A new end and its relation or property are one command.

-- | Expansion only places existing neighbors. Offer Show all when several remain. Hide zero-count controls.
-- Limit: counts omit unplaced edges between two shown cards. New cards can overlap other cards.

-- | Connect drags. Every connect drag dims invalid targets for the whole drag. Valid targets keep full contrast.
-- Highlight the valid target under the pointer. One predicate decides both feedback and drop acceptance.
-- Empty canvas is valid only when the gesture defines an action there. This applies to placements and parts.

-- | Edges. Select an edge before dragging its end. Dropping on the same card changes the side. Another card reconnects.
-- A property target end changes its range. A source end cannot move a property to another owner.
-- Note arrows: dashed, no label, no end handles, no side controls. Layout does not treat arrows as links.
-- A note can connect to cards, frames, notes, references and entity groups.

-- | Entity groups. Collect combines selected cards or entity groups into one box. A member has no own placement (§2).
-- Its links end at the group. Bundle them by source box, predicate and target box. A bundle label is its relation count.
-- ➟ releases one member beside the group. Expand releases all. × removes a member from the group and from the view.
-- + member adds an existing instance by label or IRI. Del removes the group and its members from the view.
-- Limit: member lists have no paging. A bundle cannot select or style one relation: release the member first.

-- | Clipboard: Ctrl+C, Ctrl+X, Ctrl+V on a canvas. Paste goes to the last pointer position.
-- The clip lives in window memory. The system clipboard holds its ID, not RDF. Another window or application cannot paste it.
-- Browser context menus do not show clipboard commands. Copy and cut effects: spec/manifest.hs §5.

-- | Notes. Double-click, F2 or the Properties edit control opens a non-modal Markdown editor beside the note,
-- in the colors of the note. Ctrl+Enter or a click outside commits and closes. Escape cancels. Enter inserts a newline.
-- The editor keeps a local draft. An unchanged draft sends nothing. A changed draft sends one setViewElements with expectedText.
-- A stale edit keeps the draft open with an error. If the note or model disappears, keep the draft for copying.
-- Local undo and redo edit the draft. Ctrl+S does not apply the draft or start a model undo.
-- After commit, render Markdown without raw HTML, command links or images. Links in canvas notes take no clicks.
-- Clip content to the note bounds. Note text size is a person preference, 8–72 px, default 16. The editor keeps 16 px.
-- Sources: modeler/src/browser/notes/.

-- 6. Shapes on the canvas ----------------------------------------------------

-- | Rows and edges (ADR 0014, SHACL notation; §2 gives the general rules). A property shape is a row of its owner card or
-- a line (edge) to its range. While the edge shows, the row hides. The edge is a placement of the property shape.
-- An element that arrives in a view turns the properties between it and the elements of the view into edges, both directions.
-- A target that Show as Edge or a property edit places does not arrive: only that property becomes an edge.
-- A new property whose owner and target show is an edge. An edge whose owner or target leaves becomes a row.
-- A selected element shows its rows to and from elements of the view as dashed edges. ⇥ on a dashed edge shows it as an edge.
-- A logical constraint (sh:xone, sh:or, sh:and over property shapes) is a hub. Placed, it shows a hub with its member edges.
-- Unplaced, it is a row group of its card: "xone", then one sub-row per member. Hub and members are placed and removed as one unit.
-- Del on the hub, on a member line or on its private pill removes the unit. ⇥ on the row group places the hub and the boxes it needs.
-- An alternative range (sh:or of ranges) is a "one of" box placed by its list. Unplaced, its row shows the box inline.

-- | Pills and list boxes. A target is a card (node shape, value set), a class pill, a list box or a private pill.
-- A datatype or node-kind range is a private pill: one per line, beside its start, no placement. A datatype property is a row,
-- and a line only as a member of a shown hub.
-- A class without a node shape is a class pill, shared by the lines to it (open.md D11). An instance with the same IRI is
-- an instance card.
-- An "in" range is a list box, placed by its sh:in list. Unplaced, the row reads "kind: {Civil, Religious} [1]".
-- A property without a range ends at an "any" pill beside its start: private, as a datatype pill.
-- A list box or class pill leaves with its last line. A value set leaves with its last line only when a line brought it.
-- A property shape under sh:not is a row or a line with the tag «not». It is not a hub: sh:not has no list.
-- A range to a SKOS scheme or collection through a Catenary helper shape (shn:SchemeHelper, shn:CollectionHelper) is one
-- edge to the value-set card.
-- A helper with other statements is an ordinary card, and the edge goes to it (the middle step).
-- Multiplicity stays a clickable chip. "+ attribute", ⇥, ➟ and the cardinality cycle are renderer controls, not notation.

-- | Show as Edge, ⇥ or a row drag places the target as a card or list box when the view does not show it, with view:keptByLines.
-- A row with a private end has no ⇥: it is a line only in a hub. A drop on empty canvas centers the box at the pointer. A drop on a valid card changes the target.
-- Return arrow, Show as Row or Del returns an ordinary property edge to its row. The constraint stays.
-- The return arrow shows on edge hover or selection. ⇥ and ➟ show on row hover. All three use the same circled arrow.
-- A shared property changes display in all its owner cards of that view only. Node-shape targets stay when their edges return.

-- | Property input. + attribute makes xsd:string with cardinality 0..1.
-- Enter makes the row and opens the next input. Tab makes the row and opens its value picker.
-- A property made by a link starts at 0..*. Its default path gets the creation follow-up.
-- Double-click a path or edge label to edit the path. Double-click a pill to edit the target.
-- A click on the cardinality badge cycles 0..* → 0..1 → 1 → 1..*.
-- Inputs accept names, compact IRIs and full IRIs. Known unambiguous class names resolve to existing classes.
-- Reject ambiguous class names and unknown prefixes. Else a typed name uses canonical-md. Alternatives: a | b.

-- | Three forms of alternatives. Keep them distinct.
data OneOf
  = LogicalConstraint  -- sh:or, sh:xone, sh:and or sh:not on a node shape; members describe required properties
  | OneOfTarget        -- sh:or on a property shape; members describe permitted ranges
  | ValueList          -- permitted values, also sh:in checks from SKOS schemes or collections
-- The logic handle of a free property edge joins another free property of the same shape into an Or constraint.
-- A drop on the constraint ring of that shape adds the property. Other drops do nothing.
-- Constraint members have no logic handle.
-- A property target handle adds a range. One remaining alternative reduces to a plain range.
-- A one-of target box lists targets without cards and draws edges to targets with cards.
-- Its + target control opens a picker. ➟ places a target card. × removes an alternative. The picker does not make new sets.

-- | Value sets. Scheme + concept and collection + member inputs: Enter for another entry, Escape to close.
-- The new row shows at once as a pending row. A server model with that label replaces it.
-- A failed command, or 5 s without such a model, removes the pending row (ADR 0013).
-- Collection inputs select existing concepts by label or compact IRI. Double-click a concept row to rename it.
-- ➟ shows a concept card. Removing that card returns its row. A concept without own statements cannot become a card this way.
-- Drag a concept row onto another to add a broader parent. Its tooltip lists the parents. There is no remove-parent control.

-- | Shape proposal. Propose Node Shapes from Data applies to a class without a shape, or an instance whose type has no shape.
-- It is disabled on a class that a shape targets. Model → Propose Missing Shapes does the same for all such classes.
-- After both, a new view "proposed shapes" shows the new shapes with the Layered layout, focused, the shapes selected.

-- 7. Panels ------------------------------------------------------------------

-- | Side panel width: the stored width, the default width (new layout), or the width of the last sash drag.
-- A window resize widens a narrower open side panel to that width. Reason: a tiling window manager resizes the window after the restore.
-- Default width: left min(280 px, 20 % of the window), right min(320 px, 24 % of the window).

-- | Right area: sections derive their content from the same selection. Mixed selections show mixed values.
-- Element: outgoing statements, fields of all applicable shapes grouped by shape, uncovered statements, errors beside fields.
-- Visuals: figure, style and geometry, and whether each style value comes from the placement or the element.
-- Links: incoming statements by layer, placements across views, applicable shapes and source files.
-- A canvas placement gives Element and Links its element, and Visuals the placement. A placement row gives all sections the placement.
-- The user shows any combination of sections (person setting).
data Section = ElementSection | VisualsSection | LinksSection

-- | Applicable shapes. Targeting and conformance are different relations. The user does not choose one shape lens.
-- Overlapping shapes can repeat a property. A first implementation can show the type's shape plus uncovered statements.
data Shape
applies :: Element -> [Shape]
uncovered :: Element -> [Statement]

-- | Properties layout. The head shows kind and name, then an action toolbar.
-- Toolbar icons: navigation, then explorer, source and name actions. A "More actions" menu lists all applicable actions and keys.
-- Delete from Model is the last menu item. Violations show in a box below the toolbar.
-- A field label shows its RDF term at the right. Long help is a tooltip on a "?" icon.
-- Node shape: shape fields, then properties (path, target, cardinality, required ones marked), then Reads as (closed by default).
-- Property shape: Reads as first, then the fields. Cardinality has buttons for 0..1, 1, 0..* and 1..*, and a text field.
-- Literal constraints and statements not in shapes are closed by default. Their headings show a summary.

-- | Files navigator: filesystem entries, not elements. File selection does not change the element selection.
-- Each file shows what its triples contain (views, shapes, instances). A view row opens its view.
-- Opening a file selects its own editor when there is one, else source text.

-- | Model explorer (ADR 0006): each folder is a SPARQL query, run when the user opens it.
-- A closed folder shows a count. An open folder sorts rows by label and reads pages of 100. A last "N more" row reads the next page.
-- Roots: the shared thing and shape types, then Relations and Concepts. Configured hidden types have no folder.
-- Class folders show direct subclasses and written members. An element with several types has a row under each.
-- Labeled subjects without a type go under rdfs:Resource. Target shapes go under sh:NodeShape, not under their target class.
-- Relation folders show data statements between things, without the shared excluded predicates.
-- Concepts follow schemes and broader/narrower links. Reveal opens a chosen path. Ordinary selection opens no folder.
-- Delete Elements Not Placed in a View walks the instances and relations of a folder at all depths.
-- It tests own placements, not parts. It confirms before deletion.
-- Limit: logical constraints have no rows. Concept cycles can expand without end.
pageSize :: Int
pageSize = 100

-- | Search: a faceted search on the store. Things: subjects with a type, subjects with a label and no type (rdfs:Resource),
-- property shapes (subjects of sh:path) and predicates in use. View internals, RDF structure and the report graph are not things.
-- Facets: text, type, Linked to. All set facets must match. Text matches every word in the local name or in a literal.
-- Linked to gives the other ends of the statements of an element, optionally by predicate and direction. Statements are not results.
-- Each facet value shows its count with the other facets applied. At most 200 results, sorted by label.
-- Double-click shows the element. A drag of a property result places its owner shape. Find Element (Ctrl+T) uses the same search.

-- | Show: prefer the active view when it shows the element, else the first matching view by label.
-- No matching view: select the element for the panels. F3 and Shift+F3 move between occurrences.

-- | Links: views, and outgoing and incoming statements of model and shapes. Omit rdf:type and literals.
-- An RDF list is one predicate step. A self-link shows as outgoing only. Mixed selections show ownership counts.
-- A row without a navigable element is inactive. A statement-row action targets its relation, else the other end.
-- A view row targets the matching placements. Limit: no arrows and no entity-group membership from view graphs (open.md G4).

-- | Outline follows the active document. A canvas Outline lists frames, cards and placed relations.
-- A group row selects its frames and cards, not relation rows. Ctrl+click adds rows.
-- Outline actions exclude canvas-only creation and layout controls.

-- | Problems. A click on a row selects its focus instance and reveals Properties with its violations. Focus stays in Problems.
-- Double-click or Enter also shows the instance in a view. An instance row has the context menu of a Model explorer row
-- and drags its instance to a view. Problems and Properties share one report reader. Report statements are never data.
-- Limit: markers use line 1, column 1. Validation gives no text positions.

-- | Panel data rules. Labels use the shared label query. Data reads exclude the report graph and give subjects no home graph.
-- Link and form candidates use the shared thing query. Link cardinality counts distinct values across data graphs.
-- SHACL form candidates include written members of sh:class ranges and their declared subclasses.
-- The link picker shows placed candidates first, 50 rows per section. Forms keep 200 candidates per class.
-- Relation and shape-link labels prefer configured prefix:local names. Instance predicates then use sh:name or the local name.
-- Links uses the same predicate-label rule.
-- A model change does not empty a panel. Properties shows its last data and actions until the new answer arrives.
-- A new SHACL form builds hidden and replaces the shown form when it is ready.

-- | Source editors (Turtle, TriG): highlight directives, IRIs, names, literals, comments, punctuation.
-- Comment toggle and bracket pairs. Limit: no language server, completion or source validation.

-- 8. Appearance and layout ---------------------------------------------------

-- | Style means the same on every view. Geometry belongs to a placement only.
-- The most specific value wins: placement, then element. Both levels are Project statements.
-- Class-level style is outside this contract. Geometry has no element-level fallback.
data Style = Style { color :: Maybe String }
data Geometry = Geometry { box :: (Double, Double, Double, Double), sides :: (Maybe Side, Maybe Side) }
styleOf :: Resource -> Maybe Style   -- the style statements of one level
style :: Element -> Style            -- the effective style of a placement
style p = Style { color = (styleOf p >>= color) <|> (styleOf (elementOf p) >>= color) }

-- | Appearance edits color, size, display and edge sides. Mixed values show empty. Each accepted change is one command.
-- The panel has three sections. Each heading names its scope.
-- Style (saved in the view): color swatches and a custom color, display, size, edge sides, edge visibility.
-- View (current view editor): Apply Layout with its algorithm and spacing, the hidden edges, Show Hidden Edges.
-- Preferences (all views, not in the model): text sizes and edge style. The section is closed by default.
-- Mixed values mark no option. A width or height below 40 shows a message and changes nothing.
-- Stored colors: absent (default), none (transparent), presets 1–6, white, or a CSS color.
-- Instance and node-shape cards: detailed or simple. Simple keeps the box and shows class and name only.
-- The context menu of a canvas or Outline selection has Appearance: Show Details, then Color. Cards have no display control.
-- Show Details acts on the selected cards and the cards in selected frames. It is checked when all are detailed.
-- A click makes all simple when checked, else all detailed.
-- Resize: eight handles on one selected box. Content sets the minimum heights of shape and value-set cards.
-- Frames have their own minimum size. A frame move updates its cards after release, without live feedback.

-- | Person preferences, on all views: theme, Card text (8–72 px, default 22), Note text, Group text, edge style, layout spacing.
-- Minimum content heights follow the card scale. Some widths and labels do not yet (open.md FONT1).
-- Rightward shape-link cardinality goes below the line, labels above it.

-- | Edge styles: orthogonal (default), polyline, curved, direct.
-- Except direct, route around boxes and pills, not frames. Keep explicit sides. Put labels on the longest horizontal segment.
-- Route again after geometry changes. Self-links keep their loop.
-- Limit: dense routes and labels can overlap. Direct routes cross boxes.

-- | Apply Layout runs only on request. Layered uses ELK left-to-right. Force uses cola.js and overlap removal.
-- Both replace the arrangement. Routing stays a rendering task, not ELK output. Layout clears edge sides.
-- After the new positions show, the view fits its content (padding 40, zoom at most 1). Zoom range: 0.001 to 20.
-- Spacing: 20–400 px, default 120. Layered uses twice that between columns.
-- Frames move as blocks and keep their size. A card goes inside its smallest containing frame.
-- Try reduced spacing inside a full frame. If the minimum spacing cannot fit, keep those cards in place.
-- Outer layout treats an edge to a contained card as an edge to its frame.
-- Layout uses drawn card sizes at the current text scale. A card box includes its private pills (§6).
-- A list box and a class pill are layout boxes. A member of an entity group is not: the group is.
-- A hub is a layout node. A hub placement without a position gets one from the layout (open.md LAYOUT1).
-- Each connected component is laid out alone. Components pack near width/height 1.6, or the free area of a frame.
-- If an ELK algorithm fails, use ELK box packing for those boxes.
-- Limit: Force link length ignores card size. Frame title padding does not measure text.
-- Limit: Layered reserves no room for edge labels.

-- 9. View export -------------------------------------------------------------

-- | Export Views as HTML lists checked views in export order, then unchecked views. All/None changes the checks.
-- A newly checked view goes to the end. Drag, arrow controls or Alt+Up/Alt+Down reorder checked views.
-- The same list shows in Workspace settings. There each change stores the list, and Export exports it without the dialog.
-- Start with the previous export list, else the selected views, else the active view.
-- The workspace file stores changed choices, without an undo step. CLI view IDs do not change the stored list.
-- Output: one self-contained HTML file with title, linked contents and numbered SVG sections, in the current theme.
-- Render at zoom 1 without selection, halos, handles or edit controls. Close editors opened only for the export.
-- Limit: no icon font, so codicon glyphs can be blank. No scripts or external files.
-- CLI: catenary run catenary.exportViewsHtml '["<view id>"]' '"/abs/out.html"'. Without arguments it asks.

-- 10. Settings ---------------------------------------------------------------

-- | Project settings live in the workspace file: prefixes, default file, placement of new subjects, exclusions, export order.
-- Person settings stay outside the workspace: fonts, theme, visible right-area sections.
-- Workspace settings open as a main-area document, independent of the element selection (open.md D6).
-- Each kind of new subject (Shapes, SKOS / Collections, Everything else) is Auto or a file. Auto stores "near".
-- Everything else also sets the default file, the file of a subject that Auto cannot place. Its Auto stores no default file.
-- Browse selects an existing file in the workspace folder. A typed path that does not exist makes a new file at the first write.
-- A rejected change shows its message below its row, not as a notification.
data SettingOwner = ProjectSetting | PersonSetting

-- Compile-only stubs ----------------------------------------------------------

-- | GHC requires a binding for each signature. Add a stub here for each new signature. Do not give a stub behavior.

layer = manifestOnly
isView = manifestOnly
isPlacement = manifestOnly
elementOf = manifestOnly
viewOf = manifestOnly
placements = manifestOnly
atMostOnce = manifestOnly
parts = manifestOnly
shownBy = manifestOnly
attachments = manifestOnly
keptByPlacements = manifestOnly
inside = manifestOnly
figureOf = manifestOnly
keptByLines = manifestOnly
linesTo = manifestOnly
everything = manifestOnly
documentsIn = manifestOnly
highlight = manifestOnly
place = manifestOnly
setStyle = manifestOnly
setGeometry = manifestOnly
remove = manifestOnly
delete = manifestOnly
goToSource = manifestOnly
followUp = manifestOnly
applies = manifestOnly
uncovered = manifestOnly
styleOf = manifestOnly
