-- | Catenary interaction contract: elements as the user sees them, window state, actions, keys, canvas, panels, appearance.
-- Data and transaction rules: spec/manifest.hs. Unresolved decisions and known gaps: spec/open.md. Design rules: the index at the top of spec/manifest.hs.
-- This file defines the target behavior. It does not certify the implementation. open.md names each known difference.
-- The file is a Haskell module. pnpm check typechecks it with spec/manifest.hs (scripts/check-manifests.mjs).
-- Clauses follow the conventions of spec/manifest.hs: prose states a rule, an equation or a law (law_<name>, True for all
-- arguments) states it formally, and a primitive (a stub at the end) names an observation of the implementation.
--
-- Parts and sections. Code cites a section as "spec/ui-manifest.hs §n" or "§n.m". Keep the numbers stable.
--   Part I    The model as the user sees it   §1 Elements and layers, §2 Views, placements and figures
--   Part II   Window and actions              §3 Window state and selection, §4 Actions and keys
--   Part III  Canvas                          §5 Canvas gestures, §6 Shapes on the canvas, §7 Appearance and layout
--   Part IV   Panels and workspace            §8 Panels, §9 Markdown documents and export, §10 Settings

module Catenary.UiManifest where

import Control.Applicative ((<|>))
import Data.Char (toLower)
import Data.List (isInfixOf, nub, sortOn)
import Data.Maybe (fromMaybe, isJust, isNothing, mapMaybe)
import Catenary.Manifest
  ( EditCommand (..), Id, Iri, NewEnd (..), Point, RelationEnd (..), Side, ViewElementPatch
  , (==>), elementId, firstFree, isTrig, manifestOnly, relationId, sameSet )

--------------------------------------------------------------------------------
-- Part I. The model as the user sees it
--------------------------------------------------------------------------------

-- 1. Elements and layers -----------------------------------------------------

-- | An element is an IRI resource or a triple. Its statements define its content.
-- A layer classifies statements, not elements or files. One element can have statements in several layers.
-- Diagram content never changes Domain statements (law_projectEditsKeepDomain).
data Resource = Node Iri | Triple Iri Iri Iri deriving Eq   -- a triple element is a connector: its object is an IRI
type Element = Resource
type Statement = (Resource, Iri, Resource)
data Layer
  = Domain    -- instances, relations, SKOS concepts, schemes and collections
  | Shapes    -- node shapes, property shapes, logical constraints
  | Project   -- views, placements, marks, entity groups, styles, workspace settings
  deriving Eq
layer :: Statement -> Layer
-- | The element ID that commands and the read models use (spec/manifest.hs §1.3).
idOf :: Element -> Id
idOf (Node i) = elementId i
idOf (Triple s p o) = relationId s p o
statementsOf :: Element -> [Statement]
-- | A command that changes Project statements only (spec/manifest.hs law_viewEditsKeepData) leaves Domain and Shapes as they are.
domainAfter :: EditCommand -> [Statement]          -- the Domain statements after a command
domainBefore :: [Statement]
law_projectEditsKeepDomain :: EditCommand -> Bool
law_projectEditsKeepDomain c = isDiagramEdit c ==> sameSet (domainAfter c) domainBefore
isDiagramEdit :: EditCommand -> Bool
isDiagramEdit c = case c of
  AddToView {} -> True
  PlaceExplorerElements {} -> True
  ShowRelations {} -> True
  ShowAsEdge {} -> True
  RemoveFromView {} -> True
  CutFromView {} -> True
  SetBounds {} -> True
  SetLayout {} -> True
  SetEdgeLayout {} -> True
  HideEdges {} -> True
  SetViewDescription {} -> True
  SetViewElements {} -> True
  CreateGroup {} -> True
  CreateNote {} -> True
  AddViewReference {} -> True
  AddFileReference {} -> True
  CreateArrow {} -> True
  Collect {} -> True
  AddToCollection {} -> True
  Uncollect {} -> True
  _ -> False

-- 2. Views, placements and figures ---------------------------------------------

-- 2.1 Placements ----------------------------------------------------------------

-- | A view is an element. Its canvas shows its placements.
-- A placement relates one element to one view. It supplies position and appearance. A placement has no placement.
-- A view reference is a placement of a view. A placement row in a listing stands for the placement itself.
isView, isPlacement :: Element -> Bool
elementOf, viewOf :: Element -> Element   -- of a placement: the element that it places, and its view
placements :: Element -> [Element]        -- the placements of an element, on all views
everything :: [Element]
law_placementShape :: Element -> Bool
law_placementShape p = isPlacement p ==> (isView (viewOf p) && not (isPlacement (elementOf p)) && null (placements p))
law_placementsOf :: Element -> Element -> Bool
law_placementsOf e p = (p `elem` placements e) == (isPlacement p && elementOf p == e)
law_viewReference :: Element -> Bool       -- a placement of a view on another view is a view reference
law_viewReference p = (isPlacement p && isView (elementOf p)) ==> elementOf p /= viewOf p

-- | An element has at most one own placement per view. A figure can also show it as a part.
-- Several figures can show the same part on one view. Each part belongs to the placement that shows it.
data Part = Part Element Resource deriving Eq   -- the placement that shows it, the resource
atMostOnce :: Element -> Element -> Bool         -- element, view
atMostOnce e v = length [p | p <- placements e, viewOf p == v] <= 1
law_atMostOnce :: Element -> Element -> Bool
law_atMostOnce = atMostOnce
parts :: Element -> [Part]                       -- of a placement
law_partOwner :: Element -> Bool
law_partOwner p = all (\(Part owner _) -> owner == p) (parts p)
shownBy :: Element -> Element -> [Element]       -- element, view: the placements that show it there, own or as a part
shownBy e v = [p | p <- everything, isPlacement p, viewOf p == v, elementOf p == e || Part p e `elem` parts p]

-- 2.2 Marks and arrows ----------------------------------------------------------

-- | A mark exists through its placements. Removing its last placement deletes the mark.
-- A mark can have placements on several views. Its statements stay in the view file where the user made it.
-- Mark classes: Note (Markdown), Frame (label), FileRef (file path), EntityGroup, and a future Drawing.
-- An arrow is a Project triple with predicate view:arrow. It also exists through its placements.
-- A file reference breaks when its target file moves. Files are not elements.
data MarkClass = Note | Frame | FileRef | EntityGroup deriving (Eq, Enum, Bounded)
markClass :: Element -> Maybe MarkClass
isArrow :: Element -> Bool
isArrow (Triple _ p _) = p == "view:arrow"
isArrow (Node _) = False
keptByPlacements :: Element -> Bool
keptByPlacements e = isJust (markClass e) || isArrow e
law_marksHaveLayerProject :: Element -> Bool
law_marksHaveLayerProject e = keptByPlacements e ==> all ((== Project) . layer) (statementsOf e)

-- | Frame membership comes from placement geometry. An element is inside at most one frame per view.
inside :: Element -> [Element]                   -- a frame placement: the placements inside it
law_oneFrame :: Element -> Bool                  -- a placement
law_oneFrame p = length [f | f <- everything, p `elem` inside f] <= 1

-- 2.3 Figures -------------------------------------------------------------------

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
  deriving Eq
data Role = Title | Tag | Text | Min | Max | PartRole | LinkRole | From | To | Anchor | Covers | Styled deriving Eq
data FigureShape = FigureShape { kind :: Kind, roles :: [Role] }
data Fig = Fig { focus :: Element, shape :: FigureShape, figParts :: [Element], links :: [Statement] }
defaultCascade :: [String]
defaultCascade = ["marks", "SHACL", "value sets", "instances"]
notationsOf :: Element -> [[FigureShape]]        -- view: its cascade of notations
targets :: FigureShape -> Element -> Bool
conformsToWhen :: FigureShape -> Element -> Bool  -- nt:when; true without nt:when
makeFig :: FigureShape -> Element -> Fig
figureOf :: Element -> Element -> Maybe Fig      -- view, element
figureOf v e = case [s | s <- concat (notationsOf v), targets s e, conformsToWhen s e] of
  s : _ -> Just (makeFig s e)
  [] -> Nothing
-- | Figures do not depend on placements: the same data gives the same figure, placed or not (figureOf has no placement input).

-- 2.4 Parts and rows ------------------------------------------------------------

-- | Parts and rows. A figure lists all its parts. A part is a row of its owner while the view does not draw the part.
-- A placed Line part draws from its owner. A placed Box part is a part line from its owner.
-- Rows follow sh:order, then text rows, then parts. A row whose end is a list box shows the box inline:
-- "xsd:date | xsd:gYear", "{Civil, Religious}". At most three parts, else two parts and "+N".
-- Without a hub placement, a hub is a row group of its owner: its title, then one sub-row per member.
-- Instance cards gather the property shapes of the model shapes that target the focus: one row per value.
-- A property shape without a value gives no row. The members of a logical constraint are a row group.
-- A gathered row with the path of the title is omitted.
-- An entity-group member is a part of the group (nt:linkEnd). It has no own placement while it is in the group.
data RowKind = TextRow | PartRow deriving (Eq, Ord)
rowOrder :: [(Maybe Double, RowKind)] -> [(Maybe Double, RowKind)]   -- sh:order, kind
rowOrder = sortOn key
  where
    key (Just o, k) = (0 :: Int, o, k)
    key (Nothing, k) = (1, 0, k)
isRow :: Element -> Element -> Bool              -- view, part: a row while the view does not draw it
isRow v e = null (shownOwn e v)
shownOwn :: Element -> Element -> [Element]      -- element, view: its own placements there
shownOwn e v = [p | p <- placements e, viewOf p == v]
partsSummary :: [String] -> [String]             -- the part texts that a row shows
partsSummary ps
  | length ps <= 3 = ps
  | otherwise = take 2 ps ++ ["+" ++ show (length ps - 2)]
listInline :: Bool -> [String] -> String          -- one of (True) or in (False), the member texts
listInline True ms = joinWith " | " ms
listInline False ms = "{" ++ joinWith ", " ms ++ "}"
joinWith :: String -> [String] -> String
joinWith _ [] = ""
joinWith sep (x : xs) = x ++ concatMap (sep ++) xs
-- | One row per value of each gathered property shape. No value: no row. The row with the path of the title goes.
gatheredRows :: [(Iri, [String])] -> Maybe Iri -> [(Iri, String)]   -- (path, values), the title path
gatheredRows props titlePath = [(p, v) | (p, vs) <- props, Just p /= titlePath, v <- vs]
law_groupMemberNotOwn :: Element -> Element -> Bool   -- entity group placement, member
law_groupMemberNotOwn g m = (markClass (elementOf g) == Just EntityGroup && Part g m `elem` parts g) ==> null (shownOwn m (viewOf g))

-- 2.5 Links, lines and hubs -------------------------------------------------------

-- | Links. A link (nt:link) is a statement between two figures. It is a line when the view places the statement.
-- Else nt:unplaced decides: a row (default) or hidden. A hidden link is not part of the view. It draws dashed while an end
-- is selected. A hidden link whose other end is not shown is a row: no information disappears.
data Unplaced = AsRow | Hidden deriving Eq
data LinkDrawing = SolidLine | RowOfOwner | DashedWhileSelected | NotDrawn deriving Eq
linkDrawing :: Bool -> Unplaced -> Bool -> Bool -> LinkDrawing   -- placed, nt:unplaced, other end shown, an end selected
linkDrawing True _ _ _ = SolidLine
linkDrawing False AsRow _ _ = RowOfOwner
linkDrawing False Hidden False _ = RowOfOwner
linkDrawing False Hidden True True = DashedWhileSelected
linkDrawing False Hidden True False = NotDrawn
law_noInformationDisappears :: Unplaced -> Bool -> Bool -> Bool
law_noInformationDisappears u otherShown sel = linkDrawing False u otherShown sel == NotDrawn ==> otherShown

-- | Lines. A Line starts at each value of its first nt:from with values. Without nt:from it starts at each figure that has
-- it as a part, so a shared property shape draws one line from each owner. Several nt:to: the first by sh:order with a value.
-- A private end (nt:private: datatype, node kind) or an open end ("any") is a pill of that line only, beside its start, with no
-- placement and no element. Lines do not share it. Such a line shows only as a member of a shown hub, else the property is a row.
lineStarts :: [[Element]] -> [Element] -> [Element]   -- the values of each nt:from in order, the owners that have it as a part
lineStarts froms owners = fromMaybe owners (firstNonEmpty froms)
lineEnd :: [[Element]] -> Maybe Element               -- the values of each nt:to, by sh:order
lineEnd tos = firstNonEmpty tos >>= \es -> case es of
  e : _ -> Just e
  [] -> Nothing
firstNonEmpty :: [[a]] -> Maybe [a]
firstNonEmpty xss = case filter (not . null) xss of
  xs : _ -> Just xs
  [] -> Nothing
data LineEnd = SharedEnd Element | PrivateEnd | OpenEnd deriving Eq
lineShows :: LineEnd -> Bool -> Bool                 -- the end, the line is a member of a shown hub
lineShows (SharedEnd _) _ = True
lineShows _ inShownHub = inShownHub

-- | Hubs. A hub and its Line members are one unit. The hub placement shows the member lines.
-- A Line member has no placement of its own. A Box member is an end of the hub: it needs its own placement.
-- A shown hub draws the statements that it covers (nt:covers). They are not separate lines.
hubMembers :: Element -> [(Element, Kind)]           -- a hub element: its members and their kinds
law_hubLineMembersUnplaced :: Element -> Element -> Bool   -- hub, view
law_hubLineMembersUnplaced h v = not (null (shownOwn h v)) ==> all (\(m, _) -> null (shownOwn m v)) [x | x@(_, Line) <- hubMembers h]

-- 2.6 Text --------------------------------------------------------------------------

-- | Text rule. A label is rdfs:label, skos:prefLabel or sh:name, else the local name. A predicate, a datatype and a path
-- show prefix:local. An instance field without sh:name shows the local name of its predicate.
-- Multiplicity: [1], [0..1], [1..*], [0..*]. Code: shapes-doc.ts (compactIri, shortIri, formatPath, cardinalityText,
-- rangeText). Renderer defaults: multiplicity is a clickable chip, an instance card shows its class as a header line,
-- and a link label shows the predicate only.
labelOf :: Maybe String -> Maybe String -> Maybe String -> Iri -> String   -- rdfs:label, skos:prefLabel, sh:name, IRI
labelOf l pl n i = fromMaybe (localName i) (l <|> pl <|> n)
localName :: Iri -> String                       -- the last segment after #, / or : (terms.ts)
compactIri :: [(String, Iri)] -> Iri -> Maybe String   -- prefix:local from the prefix table (shapes-doc.ts, compactParts)
cardinalityText :: Maybe Int -> Maybe Int -> String   -- sh:minCount, sh:maxCount
cardinalityText mn mx = case mx of
  Nothing -> show lo ++ "..*"
  Just hi -> if lo == hi then show lo else show lo ++ ".." ++ show hi
  where lo = fromMaybe 0 mn
multiplicity :: Maybe Int -> Maybe Int -> String
multiplicity mn mx = "[" ++ cardinalityText mn mx ++ "]"

-- 2.7 Badges ------------------------------------------------------------------------

-- | Badges. Validation is not part of the figures. A shown figure, row or line whose element IRI is a sh:focusNode of a
-- result in urn:trellis:validation shows a badge. A row badge uses the IRI of the part of the row, else the badge is on its box.
data BadgePlace = OnRow | OnBox deriving Eq
badge :: [Iri] -> Maybe Iri -> Iri -> Maybe BadgePlace   -- focus nodes, the IRI of the part of a row, the IRI of its box
badge foci rowPart boxIri
  | Just r <- rowPart, r `elem` foci = Just OnRow
  | boxIri `elem` foci = Just OnBox
  | otherwise = Nothing

-- 2.8 Connectors and arrival --------------------------------------------------------

-- | A connector is a triple with an IRI object. Its ends are its subject and object, never other connectors.
-- It ends at the figure of each end when the view shows it, else at a shown box that has that end as a nt:linkEnd part
-- (the entity group of a member).
endsOf :: Element -> [Element]
endsOf (Triple s _ o) = [Node s, Node o]
endsOf (Node _) = []
attachments :: Element -> Element -> [Element]   -- connector, view: the figure at each end
attachments c v = concatMap (\e -> take 1 (shownOwn e v ++ shownBy e v)) (endsOf c)
law_attachmentsAreShown :: Element -> Element -> Bool
law_attachmentsAreShown c v = all (\p -> isPlacement p && viewOf p == v) (attachments c v)

-- | Arrival: placing an element (add, drag, paste, expand) also places, until nothing changes, each hub whose ends are then
-- shown, each line with a shown start and end, and each link between two shown figures. Only what touches a figure that
-- this arrival placed. A statement that a shown hub covers is not placed. The user removes what they do not want.
-- Removing a connector placement stores no hidden state.
-- A hidden connector draws dashed while an end is selected (§2.5). A click places it. Placed connectors draw solid.
-- Data effects of arrival: spec/manifest.hs §7.
candidates :: Element -> [Element]               -- view: the hubs, lines and links that its notations can place there
needsShown :: Element -> [Element]               -- a candidate: the ends that must be shown (hub ends, line start and end, link ends)
coveredBy :: Element -> Element -> Bool          -- statement, hub: the hub covers it (nt:covers)
arrival :: Element -> [Element] -> [Element] -> [Element]   -- view, shown elements, newly placed: all elements placed by the arrival
arrival v shown new = go new
  where
    go placedNow =
      let now = shown ++ placedNow
          next = [ c | c <- candidates v, c `notElem` now
                 , all (`elem` now) (needsShown c), any (`elem` placedNow) (needsShown c)
                 , not (any (coveredBy c) (filter (`elem` now) (candidates v))) ]
      in if null next then placedNow else go (placedNow ++ next)
law_arrivalOnlyAdds :: Element -> [Element] -> [Element] -> Bool
law_arrivalOnlyAdds v shown new = all (`elem` arrival v shown new) new

-- 2.9 Dependencies and removal ------------------------------------------------------

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
cascade :: Element -> [Element]
cascade x = go [x]
  where
    go gone = case [y | y <- everything, y `notElem` gone, any (broken gone) (dependsOn y)] of
      [] -> gone
      new -> go (gone ++ new)
    broken gone (Needs ys) = any (`elem` gone) ys
    broken gone (KeptBy ys) = not (null ys) && all (`elem` gone) ys
-- | Invariant: deleting e leaves no placement of e. Removing a placement can delete its last dependent mark.
law_deleteLeavesNoPlacement :: Element -> Bool
law_deleteLeavesNoPlacement e = all (`elem` cascade e) (placements e)
law_lastPlacementTakesMark :: Element -> Bool       -- a placement of a mark
law_lastPlacementTakesMark p =
  (isPlacement p && keptByPlacements (elementOf p) && placements (elementOf p) == [p]) ==> elementOf p `elem` cascade p
-- | Only placements and elements kept by placements or lines leave in a cascade. Removal changes no Domain data.
law_cascadeScope :: Element -> Element -> Bool
law_cascadeScope x y = (y `elem` cascade x && y /= x) ==> (isPlacement y || keptByPlacements y || keptByLines y)

--------------------------------------------------------------------------------
-- Part II. Window and actions
--------------------------------------------------------------------------------

-- 3. Window state and selection ----------------------------------------------

-- 3.1 Window state ------------------------------------------------------------------

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
data Transient = Menu | Picker | InlineInput | NoteEditor | Dialog deriving Eq
-- | Opening a transient closes the active one (Maybe holds at most one).
openTransient :: Transient -> UiState -> UiState
openTransient t s = s { transient = Just t }
law_activeIsOpen :: UiState -> Bool
law_activeIsOpen s = maybe True (`elem` documents s) (active s)

-- 3.2 Documents ---------------------------------------------------------------------

-- | A file opens as what its content holds that Catenary edits, not by its name: a workspace (the manifest graph) opens the
-- workspace (the open one: its Workspace settings), a view (a view:View) opens its view editor. The navigator opens a file when it
-- is selected (a preview), so browsing the files shows the views. A preview stays in the open workspace: another workspace, or a
-- view of another workspace, opens only by an explicit open (double-click or Enter); the preview shows its text.
-- Reason: browsing must not replace the open workspace. A file with several ways to open asks which.
-- A file with the workspace settings and a view opens as text, with the message "This file mixes workspace settings and a view.
-- Move the view into its own file." Reason: a save of one part must not change the other (open.md D7).
-- Other model RDF files open as Model documents. Other files open as text. "Open With" opens any file as text.
-- Source and Model are available for every model RDF file, including the workspace file.
-- Open as and Open beside offer applicable presentations of the same file.
-- Open beside places a new presentation in a split. Reopening focuses the existing pane in its current position.
-- Model documents use the same tab movement and split controls as Source and Canvas.
-- Reason: one file opener handles all presentations.
-- A view outside the open workspace first opens the workspace that reads its file: the nearest folder above it with one
-- workspace file. A view in no workspace gives a message. A view and the settings can switch to source text.
-- Opening a document makes it active. It does not change the selection. Selection and active document are independent.
-- A browser URL with ?view=<view-id> opens that view after layout restoration, overriding the restored active tab.
-- The view must belong to the current workspace. An unknown ID shows an error and keeps normal startup behavior.
-- The URL does not select a workspace or start a backend.
-- A file with several views is open (open.md D4).
data Document = OpenView Element | OpenWorkspace | AsModel FilePath | AsText FilePath deriving Eq
documentsIn :: FilePath -> [Document]
data FileHolds = FileHolds { holdsWorkspace :: Bool, holdsViews :: [Id], holdsModel :: Bool }
-- | Default documents. Several views: the user picks one canvas.
openChoices :: FilePath -> FileHolds -> [Document]
openChoices p h
  | holdsWorkspace h && not (null (holdsViews h)) = [AsText p]
  | otherwise = case [OpenWorkspace | holdsWorkspace h] ++ [OpenView (Node v) | v <- holdsViews h] of
      [] -> [if holdsModel h then AsModel p else AsText p]
      ds -> ds
law_plainFileOpensAsText :: FilePath -> Bool
law_plainFileOpensAsText p = openChoices p (FileHolds False [] False) == [AsText p]
law_modelFileDefaultsToModel :: FilePath -> Bool
law_modelFileDefaultsToModel p = openChoices p (FileHolds False [] True) == [AsModel p]
-- | Applicable presentations keep Source and Model for workspace and view files.
presentationChoices :: FilePath -> FileHolds -> [Document]
presentationChoices p h
  | holdsWorkspace h && not (null (holdsViews h)) = [AsText p]
  | holdsModel h || holdsWorkspace h || not (null (holdsViews h)) =
      [AsText p, AsModel p] ++ [OpenWorkspace | holdsWorkspace h] ++ [OpenView (Node v) | v <- holdsViews h]
  | otherwise = [AsText p]
law_workspaceHasSourceAndModel :: FilePath -> Bool
law_workspaceHasSourceAndModel p = all (`elem` presentationChoices p (FileHolds True [] True)) [AsText p, AsModel p, OpenWorkspace]
-- | A preview keeps the documents that stay in the open workspace. `inOpen`: the document belongs to the open workspace.
previewChoices :: (Document -> Bool) -> FilePath -> FileHolds -> [Document]
previewChoices inOpen p h = case filter (\d -> d == AsText p || inOpen d) (openChoices p h) of
  [] -> [AsText p]
  ds -> ds
law_previewStaysInWorkspace :: (Document -> Bool) -> FilePath -> FileHolds -> Bool
law_previewStaysInWorkspace inOpen p h = all (\d -> d == AsText p || inOpen d) (previewChoices inOpen p h)
law_mixedFileOpensAsText :: FilePath -> Id -> Bool
law_mixedFileOpensAsText p v = openChoices p (FileHolds True [v] True) == [AsText p]
openDocument :: Document -> UiState -> UiState
openDocument d s = s { documents = nub (documents s ++ [d]), active = Just d }
law_openKeepsSelection :: Document -> UiState -> Bool
law_openKeepsSelection d s = selection (openDocument d s) == selection s
law_reopenKeepsDocuments :: Document -> UiState -> Bool
law_reopenKeepsDocuments d s = documents (openDocument d (openDocument d s)) == documents (openDocument d s)
startupDocument :: Maybe Id -> [Id] -> Maybe Document -> Maybe Document   -- ?view, views of the workspace, restored active tab
startupDocument (Just v) views restored = if v `elem` views then Just (OpenView (Node v)) else restored
startupDocument Nothing _ restored = restored

-- 3.3 Selection and highlights ------------------------------------------------------

-- | Click replaces the selection. Ctrl+click adds, also from another canvas. Selected canvas items are placements or parts.
-- Listings select their row elements. Other panes show highlights, not their own selections.
data UiSelection = UiSelection { items :: [Selected], source :: Pane } deriving Eq
data Selected = SelElement Element | SelPart Part deriving Eq
data Pane = OnCanvas | InListing Listing deriving Eq
data Listing = Tree | Results deriving Eq
click :: Bool -> Pane -> Selected -> UiSelection -> UiSelection   -- Ctrl held, pane, clicked item, selection
click False pane x _ = UiSelection [x] pane
click True pane x s = UiSelection (nub (items s ++ [x])) pane
law_canvasSelectsPlacements :: UiSelection -> Bool
law_canvasSelectsPlacements s = source s == OnCanvas ==> all onCanvas (items s)
  where
    onCanvas (SelElement e) = isPlacement e
    onCanvas (SelPart _) = True

-- | Tree and Results highlight selected elements, their placements and the elements of selected placements.
-- A closed folder that contains a highlight is marked, not opened. Placements highlight on the active canvas only (open.md D2).
-- A selected part highlights its resource in Tree when Tree contains it.
highlight :: UiSelection -> Pane -> [Highlighted]
data Highlighted = Row Element | ClosedFolder String | OnActiveCanvas Element deriving Eq
highlightedElements :: UiSelection -> [Element]
highlightedElements s = nub (concat [selfAndRelated e | SelElement e <- items s] ++ [r | SelPart (Part _ r) <- items s])
  where selfAndRelated e = e : placements e ++ [elementOf e | isPlacement e]
law_highlightRows :: UiSelection -> Listing -> Element -> Bool
law_highlightRows s l e = (Row e `elem` highlight s (InListing l)) ==> e `elem` highlightedElements s

-- 4. Actions and keys --------------------------------------------------------

-- 4.1 Operations --------------------------------------------------------------------

-- | One operation has one definition on every surface. The selected items set its scope.
-- A placement scopes an operation to its view. Any other element scopes it across views.
-- place e v: place e on v, with the connector ends that v does not show. An own placement makes it a no-op.
-- remove accepts placements only. delete on a canvas placement deletes its element.
-- A listing row acts on its own element, also when that element is a placement.
-- Each graph operation is one EditCommand (spec/manifest.hs §6). Open in… changes no graph.
data Scope = InView Element | AcrossViews deriving Eq
scopeOf :: Element -> Scope
scopeOf e = if isPlacement e then InView (viewOf e) else AcrossViews
place :: Element -> Element -> Point -> EditCommand   -- element, view, position
place e v = AddToView (idOf v) [idOf e]
setStyle :: Resource -> Style -> EditCommand
setGeometry :: Element -> Geometry -> EditCommand
remove :: Element -> Maybe EditCommand
remove p
  | isPlacement p = Just (RemoveFromView (idOf (viewOf p)) [idOf p])
  | otherwise = Nothing
delete :: Pane -> Element -> EditCommand
delete OnCanvas x | isPlacement x = Delete [idOf (elementOf x)]
delete _ x = Delete [idOf x]
openInPane :: Element -> IO ()

-- 4.2 Applicability -----------------------------------------------------------------

-- | An action uses the selection. The backend decides applicability from store facts and selected items, never widget focus.
-- Use all types of each selected IRI. A preferred display kind does not hide actions of another type.
-- Applicable actions show in menus, keys and the Properties action toolbar. A disabled action shows its reason.
-- With several items, an action needs all items to apply, or an explicit arity rule. It sends one EditCommand.
-- An empty selection allows surface actions such as New Instance or Apply Layout.
-- Add to Current View takes the active view as a parameter, not as the selection scope.
-- Rules: packages/model/src/actions.ts. Query: selectionActions.
data Action
data Arity = EachItem | ExactlyOne | AtLeast Int | EmptySelection
arity :: Action -> Arity
appliesTo :: Action -> Element -> Bool           -- from store facts, with all types of the element
applicable :: Action -> [Element] -> Bool
applicable a xs = case arity a of
  EachItem -> not (null xs) && all (appliesTo a) xs
  ExactlyOne -> length xs == 1 && all (appliesTo a) xs
  AtLeast n -> length xs >= n && all (appliesTo a) xs
  EmptySelection -> null xs
commandsOf :: Action -> [Element] -> [EditCommand]   -- what one run of an applicable action sends
law_oneCommandPerAction :: Action -> [Element] -> Bool
law_oneCommandPerAction a xs = applicable a xs ==> length (commandsOf a xs) <= 1

-- 4.3 Controls ----------------------------------------------------------------------

-- | A control acts on its own part, not on the selection. Its label or tooltip states the effect.
-- A control can delete a row that the keys cannot target. Controls do not redefine key meanings.
data Control
controlTarget :: Control -> Part
controlCommand :: Control -> UiSelection -> Maybe EditCommand
law_controlIgnoresSelection :: Control -> UiSelection -> UiSelection -> Bool
law_controlIgnoresSelection c s1 s2 = isJust (controlCommand c s1) == isJust (controlCommand c s2)

-- 4.4 Keys --------------------------------------------------------------------------

-- | Keys.
-- Del removes placements from their views. It never falls back to delete from the model.
-- A listing selection of ordinary elements gives Del no action. Placement rows carry their placement scope.
-- A box row is not a key target. Its own control changes it (exception for property rows: open.md G10).
-- Ctrl+Del deletes elements after confirmation.
-- Ctrl+Z and Ctrl+Shift+Z undo and redo graph edits. A focused text input keeps its own text keys.
-- F2 renames, or edits a note. Ctrl+T finds an element. F3 and Shift+F3 go to the next and previous occurrence.
-- F12 is Open in….
data Key = Del | CtrlDel | CtrlZ | CtrlShiftZ | F2 | CtrlT | F3 | ShiftF3 | F12 | CtrlC | CtrlX | CtrlV deriving Eq
data KeyEffect
  = RemovePlacements | DeleteAfterConfirmation | UndoGraphEdit | RedoGraphEdit | RenameOrEditNote | FindElement
  | NextOccurrence | PreviousOccurrence | OpenInPane | CopyClip | CutClip | PasteClip
  deriving Eq
keyEffect :: Key -> KeyEffect
keyEffect k = case k of
  Del -> RemovePlacements
  CtrlDel -> DeleteAfterConfirmation
  CtrlZ -> UndoGraphEdit
  CtrlShiftZ -> RedoGraphEdit
  F2 -> RenameOrEditNote
  CtrlT -> FindElement
  F3 -> NextOccurrence
  ShiftF3 -> PreviousOccurrence
  F12 -> OpenInPane
  CtrlC -> CopyClip
  CtrlX -> CutClip
  CtrlV -> PasteClip
isTextKey :: Key -> Bool                          -- a key that a text input uses for its own text
keyGoesToWindow :: Bool -> Key -> Bool            -- a text input has the focus, the key
keyGoesToWindow inputFocused k = not (inputFocused && isTextKey k)
delCommands :: [Element] -> [EditCommand]         -- Del on the selected items
delCommands = mapMaybe remove
law_delNeverDeletes :: [Element] -> Bool
law_delNeverDeletes xs = all (not . isDelete) (delCommands xs)
  where
    isDelete (Delete _) = True
    isDelete _ = False
law_delNeedsPlacements :: [Element] -> Bool
law_delNeedsPlacements xs = not (any isPlacement xs) ==> null (delCommands xs)

-- 4.5 Text edits --------------------------------------------------------------------

-- | Text edits. Escape cancels a transient edit. It never commits. Enter accepts a single-line edit.
-- A click outside a text input commits. A click outside a picker, dialog or menu cancels it.
-- Note keys: §5.9.
data Input = TextInput Bool | NoteInput | PickerInput | DialogInput | MenuInput   -- TextInput True: single line
data InputEvent = EscapeKey | EnterKey | CtrlEnterKey | ClickOutside deriving Eq
data InputEnd = Commit | Cancel deriving Eq
inputEnd :: Input -> InputEvent -> Maybe InputEnd   -- Nothing: the edit goes on
inputEnd _ EscapeKey = Just Cancel
inputEnd (TextInput True) EnterKey = Just Commit
inputEnd (TextInput _) ClickOutside = Just Commit
inputEnd NoteInput CtrlEnterKey = Just Commit
inputEnd NoteInput ClickOutside = Just Commit
inputEnd PickerInput ClickOutside = Just Cancel
inputEnd DialogInput ClickOutside = Just Cancel
inputEnd MenuInput ClickOutside = Just Cancel
inputEnd _ _ = Nothing
law_escapeNeverCommits :: Input -> Bool
law_escapeNeverCommits i = inputEnd i EscapeKey == Just Cancel
law_enterInNoteIsNewline :: Bool
law_enterInNoteIsNewline = inputEnd NoteInput EnterKey == Nothing

-- 4.6 Creation follow-up ------------------------------------------------------------

-- | Creation follow-up. After creation, select and reveal the new element where the gesture took place.
-- Focus its first editable field with the default value selected: an inline field first, else the Element section.
-- The field is the label, the property path or the note text. Default labels: "unnamed <kind> N". Notes: "Note".
-- Enter accepts. Escape drops the typed value but keeps the new element with its default value.
-- Creation and the accepted text edit are separate undo steps. Undo, not Escape, removes the new element.
-- A new node shape: the accepted name also sets its target class, in the same undo step. The class is the known class with
-- that name, else the name IRI. Reason: a shape usually targets the class of its name.
-- Rename, placement and connection to existing elements start no follow-up.
-- New View first asks for the name of the view file (DialogInput). It proposes a free views/unnamed-view.view.trig (or the selected
-- folder); a name without .trig gets it. Cancel creates nothing. The view gets the default label "unnamed view N" and opens. No
-- follow-up starts: the file dialog is the only dialog. Reason: one question per gesture; the user renames the view later, or never.
-- A later rename does not change the file name. Reason: the read finds a view by the content of its file, not by its name.
-- Duplicate View asks the same way for the file of the copy, proposed next to the source file (<name>-copy). The copy opens as
-- "<label> copy" with no follow-up.
newViewFileInput :: String -> FilePath
newViewFileInput t = if isTrig t then t else t ++ ".trig"
law_newViewFileIsTrig :: String -> Bool
law_newViewFileIsTrig t = isTrig (newViewFileInput t)
data Field = LabelField | PathField | NoteTextField deriving Eq
data FieldPlace = InlineField | ElementSectionField | LabelDialog deriving Eq
followUp :: Element -> Field
followUpPlace :: Bool -> Bool -> FieldPlace       -- the new element has an inline field, the Element section has the field
followUpPlace True _ = InlineField
followUpPlace False True = ElementSectionField
followUpPlace False False = LabelDialog
defaultText :: Maybe MarkClass -> String -> [String] -> String   -- mark class, kind, labels in use
defaultText (Just Note) _ _ = "Note"
defaultText _ k taken = firstFree (\i -> "unnamed " ++ k ++ " " ++ show i) taken
startsFollowUp :: EditCommand -> Bool
startsFollowUp c = case c of
  CreateInstance {} -> True
  CreateView {} -> False
  CreateNodeShape {} -> True
  CreatePropertyShape {} -> True
  CreateValueSet {} -> True
  AddConcept {} -> True
  CreateNote {} -> True
  CreateGroup {} -> True
  CreateRelation from _ to _ -> isNew from || isNew to
  _ -> False
  where
    isNew e = case e of
      ExistingEnd _ -> False
      _ -> True
-- | Escape after creation keeps the element: the follow-up sends no command on Escape.
followUpCommand :: InputEvent -> String -> String -> Maybe String   -- event, default value, typed value: the label to send
followUpCommand EnterKey dflt typed = if typed == dflt then Nothing else Just typed
followUpCommand _ _ _ = Nothing
nodeShapeTargetClass :: [(String, Iri)] -> String -> (String -> Iri) -> Iri   -- known classes by name, accepted name, mint
nodeShapeTargetClass known name mint = fromMaybe (mint name) (lookup name known)

-- 4.7 Open in --------------------------------------------------------------------

-- | Open in… (F12) is the one operation that opens an element in another pane. It accepts one item of any kind.
-- Reason: one operation per intent. Reveal in Explorer, Go to Source, Show in a View and Open View did the same with four names.
-- A canvas placement resolves to its element. A placement row resolves to the placement. A view reference resolves to its view.
-- An empty selection on a canvas resolves to its view.
-- Targets: Source of each file with statements of the element, at its position; Model of each of those files with a row of it;
-- Canvas of each view that places it (a view: its own canvas). The current pane is not a target.
-- One target opens at once. Several targets give a pick: the pane name, then the file and line or the view name.
-- Source opens at the statement: a relation at its object, a property shape at its own block, else at its entry in its node shape.
-- A Turtle file gives the position from its syntax tree. Other formats give the line of a text search. An unknown position opens the file.
-- Model reveals the row; several rows give a pick of paths. Canvas selects and centers the placement.
-- Double-click or Enter on an element row of the Model explorer runs Open in….
data OpenTarget = SourceAt FilePath (Maybe (Int, Int)) | ModelOf FilePath | CanvasOf Id deriving Eq
data Here = HereSource FilePath | HereModel FilePath | HereCanvas Id | Elsewhere deriving Eq
openTarget :: Maybe Element -> Pane -> [Element] -> Maybe Element   -- the view of the canvas, pane, selected items
openTarget (Just v) OnCanvas [] = Just v
openTarget _ OnCanvas [x] = Just (if isPlacement x then elementOf x else x)
openTarget _ (InListing _) [x] = Just x
openTarget _ _ _ = Nothing
data OpenStep = OpenNow OpenTarget | PickTarget [OpenTarget] deriving Eq
openIn :: Here -> [OpenTarget] -> Maybe OpenStep
openIn here ts = case filter (not . isHere) ts of
    [] -> Nothing
    [t] -> Just (OpenNow t)
    rest -> Just (PickTarget rest)
  where
    isHere (ModelOf f) = here == HereModel f
    isHere (CanvasOf v) = here == HereCanvas v
    isHere _ = False
law_severalItemsNoOpen :: Maybe Element -> Pane -> [Element] -> Bool
law_severalItemsNoOpen v p xs = length xs > 1 ==> openTarget v p xs == Nothing
law_openInSkipsCurrent :: FilePath -> [OpenTarget] -> Bool
law_openInSkipsCurrent f ts = case openIn (HereModel f) ts of
    Just (OpenNow t) -> t /= ModelOf f
    Just (PickTarget xs) -> ModelOf f `notElem` xs
    Nothing -> True

-- 4.8 Delete confirmation -----------------------------------------------------------

-- | Delete confirmation names the affected elements and views, and the effects in Domain, Shapes and Project.
-- View deletion also names the target view and counts incoming references, grouped by containing view.
-- Two references from one view count twice. State that Domain data stays unchanged.
-- Offer Cancel and "Delete view and references". With no incoming references, omit that warning and list, but still confirm.
-- Delete the view and its incoming references in one command. Undo restores both and the view content.
-- Removing one view reference does not change its target or other references. Removing a frame keeps its content.
-- A failed deletion leaves the store unchanged. Save and reload keep a successful deletion.
referenceCounts :: [Element] -> [(Element, Int)]   -- the containing view of each incoming reference
referenceCounts vs = [(v, length (filter (== v) vs)) | v <- nub vs]
data Confirmation = Confirmation { warnsReferences :: Bool, buttons :: [String], domainUnchanged :: Bool }
viewDeleteConfirmation :: [Element] -> Confirmation
viewDeleteConfirmation refs = Confirmation
  { warnsReferences = not (null refs), buttons = ["Cancel", "Delete view and references"], domainUnchanged = True }
law_referencesCountTwice :: [Element] -> Bool
law_referencesCountTwice vs = sum (map snd (referenceCounts vs)) == length vs

--------------------------------------------------------------------------------
-- Part III. Canvas
--------------------------------------------------------------------------------

-- 5. Canvas gestures -----------------------------------------------------------

-- 5.1 Palette and drag sources ------------------------------------------------------

-- | Palette: a bar of two rows. Sections, left to right: Shape (a tile over both rows), SKOS (Scheme over Collection),
--   classes (one tool per class with a target-class shape, in two rows, then "+N"), View (Group over Note).
--   Shape is first and largest: shapes drive the classes, the forms and the validation.
-- Class tools follow the metamodel after edits, undo and reload.
-- Drag sources: a class folder creates an instance. Element rows place cards, relations or view references.
-- A file from the navigator gives a view reference for a view file, else a file reference. A broken reference shows a warning.
data PaletteSection = ShapeSection | SkosSection | ClassesSection | ViewSection deriving (Eq, Enum, Bounded)
paletteOrder :: [PaletteSection]
paletteOrder = [minBound .. maxBound]
classToolsShown :: Int -> [Iri] -> [Iri]         -- room, classes with a target-class shape: the classes with a tool
moreCount :: Int -> [Iri] -> Int                  -- the N of "+N"; 0: no "+N" tool
moreCount room cs = length cs - length (classToolsShown room cs)
law_classToolsPrefix :: Int -> [Iri] -> Bool
law_classToolsPrefix room cs = let shown = classToolsShown room cs in shown == take (length shown) cs
data DropSource = ClassFolder Iri | ElementRow Element | NavigatorFile FilePath
data DropResult = NewInstanceAt Iri | PlaceRow Element | ViewReferenceTo FilePath | FileReferenceTo FilePath
dropResult :: DropSource -> DropResult
dropResult (ClassFolder c) = NewInstanceAt c
dropResult (ElementRow e) = PlaceRow e
dropResult (NavigatorFile f) = if isViewFilePath f then ViewReferenceTo f else FileReferenceTo f
isViewFilePath :: FilePath -> Bool               -- spec/manifest.hs isViewFile

-- 5.2 Immediate feedback ------------------------------------------------------------

-- | Immediate feedback (ADR 0013). A move or resize shows at once. The canvas keeps the bounds of each box that it moved
-- until a server model has them. An older server model does not move the box back. After 3 s without confirmation the server wins.
type Bounds = (Double, Double, Double, Double)
confirmTimeoutMs :: Double
confirmTimeoutMs = 3000
shownBounds :: Double -> Maybe Bounds -> Bounds -> Bounds   -- ms since the move, bounds the canvas keeps, bounds of the server model
shownBounds elapsed kept server = case kept of
  Just b | b /= server && elapsed < confirmTimeoutMs -> b
  _ -> server

-- 5.3 Halo --------------------------------------------------------------------------

-- | Halo. One selected item shows its halo. Several show a shared frame with Collect, Remove and More actions.
-- Card controls: Open in, Remove, More actions, incoming and outgoing expansion, applicable-shape expansion, incoming and outgoing creation (+).
-- The direction of a creation control decides which end is the selected card.
-- Applicable-shape expansion uses the shared checked-node relation, including direct targets and positive node constraints.
-- A node-shape card has a checked-instance expansion control. Both controls exclude cards already shown.
-- Incoming expansion of a node-shape card adds the chosen source shape cards. Their properties to the card become edges (§6).
-- Note halo: Remove, More actions, arrow drag. Frame and reference halo: Remove, More actions. Entity-group halo: also Expand.
-- Halo controls draw above diagram content with opaque backgrounds. Positions and labels: diagram/card-chrome.ts.
data HaloItem = HaloCard | HaloNote | HaloFrame | HaloReference | HaloEntityGroup | HaloSeveral
haloControls :: HaloItem -> [String]
haloControls h = case h of
  HaloCard -> ["Open in", "Remove", "More actions", "Expand incoming", "Expand outgoing", "Expand applicable shapes", "Create incoming", "Create outgoing"]
  HaloNote -> ["Remove", "More actions", "Arrow"]
  HaloFrame -> ["Remove", "More actions"]
  HaloReference -> ["Remove", "More actions"]
  HaloEntityGroup -> ["Remove", "More actions", "Expand"]
  HaloSeveral -> ["Collect", "Remove", "More actions"]

-- 5.4 Relation creation and expansion -----------------------------------------------

-- | Relation creation. Drag a creation control onto a valid card. Several valid predicates give a picker.
-- A click on the control, or a release on empty canvas, opens end choices. Typed text can create a new end.
-- Incoming creates a subject. Outgoing creates an object. Shape controls use property owners and targets.
-- A new end and its relation or property are one command.
data Direction = Incoming | Outgoing deriving Eq
data CreationStep = CreateWith Iri | PickPredicate [Iri] | NoValidPredicate deriving Eq
creationStep :: [Iri] -> CreationStep            -- the valid predicates between the two cards
creationStep [p] = CreateWith p
creationStep [] = NoValidPredicate
creationStep ps = PickPredicate ps
relationFor :: Direction -> Iri -> Iri -> Iri -> EditCommand   -- direction, selected card, predicate, other end
relationFor Outgoing sel p other = CreateRelation (ExistingEnd (elementId sel)) p (ExistingEnd (elementId other)) Nothing
relationFor Incoming sel p other = CreateRelation (ExistingEnd (elementId other)) p (ExistingEnd (elementId sel)) Nothing

-- | Expansion only places existing neighbors. Offer Show all when several remain. Hide zero-count controls.
-- Limit: counts omit unplaced edges between two shown cards. New cards can overlap other cards.
expansionControlShown :: Int -> Bool
expansionControlShown n = n > 0
offersShowAll :: Int -> Bool
offersShowAll remaining = remaining > 1

-- 5.5 Connect drags -----------------------------------------------------------------

-- | Connect drags. Every connect drag dims invalid targets for the whole drag. Valid targets keep full contrast.
-- Highlight the valid target under the pointer. One predicate decides both feedback and drop acceptance.
-- Empty canvas is valid only when the gesture defines an action there. This applies to placements and parts.
data Gesture
data DropTarget = OnItem Selected | EmptyCanvas
validTarget :: Gesture -> Selected -> Bool
hasEmptyCanvasAction :: Gesture -> Bool
accepts :: Gesture -> DropTarget -> Bool
accepts g (OnItem x) = validTarget g x
accepts g EmptyCanvas = hasEmptyCanvasAction g
dimmed :: Gesture -> Selected -> Bool
dimmed g x = not (validTarget g x)
law_feedbackIsAcceptance :: Gesture -> Selected -> Bool
law_feedbackIsAcceptance g x = dimmed g x == not (accepts g (OnItem x))

-- 5.6 Edges -------------------------------------------------------------------------

-- | Edges. Select an edge before dragging its end. Dropping on the same card changes the side. Another card reconnects.
-- A property target end changes its range. A source end cannot move a property to another owner.
-- Note arrows: dashed, no label, no end handles, no side controls. Layout does not treat arrows as links.
-- A note can connect to cards, frames, notes, references and entity groups.
data EndDrop = SameCard Side | OtherCard Id
endDropCommand :: Id -> RelationEnd -> Id -> EndDrop -> EditCommand   -- relation, the dragged end, its current card, the drop
endDropCommand r end current (SameCard s) = ReconnectRelation r end current (Just s)
endDropCommand r end _ (OtherCard c) = ReconnectRelation r end c Nothing
propertySourceDrop :: Bool                        -- a source end drop of a property edge sends a command
propertySourceDrop = False
arrowEndKinds :: [MarkClass]                      -- besides cards
arrowEndKinds = [Note, Frame, FileRef, EntityGroup]

-- 5.7 Entity groups -----------------------------------------------------------------

-- | Entity groups. Collect combines selected cards or entity groups into one box. A member has no own placement (§2.4).
-- Its links end at the group. Bundle them by source box, predicate and target box. A bundle label is its relation count.
-- ➟ releases one member beside the group. Expand releases all. × removes a member from the group and from the view.
-- + member adds an existing instance by label or IRI. Del removes the group and its members from the view.
-- Limit: member lists have no paging. A bundle cannot select or style one relation: release the member first.
bundles :: [(Element, Iri, Element)] -> [((Element, Iri, Element), Int)]   -- (source box, predicate, target box) of each relation
bundles rs = [(k, length (filter (== k) rs)) | k <- nub rs]
law_bundlesCountAll :: [(Element, Iri, Element)] -> Bool
law_bundlesCountAll rs = sum (map snd (bundles rs)) == length rs
releaseOne :: Id -> Id -> Id -> EditCommand        -- view, group, member
releaseOne v g m = Uncollect v g (Just [m])
releaseAll :: Id -> Id -> EditCommand               -- view, group
releaseAll v g = Uncollect v g Nothing

-- 5.8 Clipboard ---------------------------------------------------------------------

-- | Clipboard: Ctrl+C, Ctrl+X, Ctrl+V on a canvas. Paste goes to the last pointer position.
-- The clip lives in window memory. The system clipboard holds its ID, not RDF. Another window or application cannot paste it.
-- Browser context menus do not show clipboard commands. Copy and cut effects: spec/manifest.hs §6.4.
-- Copy as RDF appears in Edit and the canvas context menu. It copies readable Turtle without placement metadata.
-- Raw RDF paste shows figures derived by the canvas notations. Default appearance applies to new placements only.
-- Named graphs open a warning: flattening discards graph names. Flatten and paste continues; Cancel changes nothing.
-- Invalid RDF changes nothing. Successful paste selects new placements and reports when no new figures exist.
type ClipId = String
data WindowId = WindowId String deriving Eq
pastable :: WindowId -> WindowId -> ClipId -> [ClipId] -> Bool   -- window of the clip, pasting window, clip ID, clips in memory
pastable from to c held = from == to && c `elem` held
rawRdfPaste :: Id -> String -> Bool -> Maybe Point -> EditCommand
rawRdfPaste = PasteRdf
flattenPasteAllowed :: Bool -> Bool -> Bool          -- has named graphs, consent
flattenPasteAllowed named consent = not named || consent
law_namedGraphPasteNeedsConsent :: Bool -> Bool
law_namedGraphPasteNeedsConsent named = named ==> not (flattenPasteAllowed named False)

-- 5.9 Notes -------------------------------------------------------------------------

-- | Notes. Double-click, F2 or the Properties edit control opens a non-modal Markdown editor beside the note,
-- in the colors of the note. Ctrl+Enter or a click outside commits and closes. Escape cancels. Enter inserts a newline (§4.5).
-- The editor keeps a local draft. An unchanged draft sends nothing. A changed draft sends one setViewElements with expectedText.
-- A stale edit keeps the draft open with an error. If the note or model disappears, keep the draft for copying.
-- Local undo and redo edit the draft. Ctrl+S does not apply the draft or start a model undo.
-- After commit, render Markdown without raw HTML, command links or images. Links in canvas notes take no clicks.
-- Clip content to the note bounds. Note text size is a person preference, 8–72 px, default 16. The editor keeps 16 px.
-- Sources: modeler/src/browser/notes/.
notePatch :: String -> ViewElementPatch
noteCommit :: Id -> Id -> String -> String -> Maybe EditCommand   -- view, note, text when the editor opened, draft
noteCommit v n original draft
  | draft == original = Nothing
  | otherwise = Just (SetViewElements v [n] (notePatch draft) (Just original))
data MarkdownPart = PlainText | Heading | ListItem | Emphasis | CodeSpan | LinkText | RawHtml | CommandLink | Image deriving Eq
rendered :: MarkdownPart -> Bool
rendered p = p `notElem` [RawHtml, CommandLink, Image]
clampSize :: Int -> Int -> Int -> Int
clampSize lo hi = max lo . min hi
noteTextSize :: Maybe Int -> Int
noteTextSize = maybe 16 (clampSize 8 72)
noteEditorTextSize :: Int
noteEditorTextSize = 16

-- 6. Shapes on the canvas ----------------------------------------------------

-- 6.1 Rows and edges ----------------------------------------------------------------

-- | Rows and edges (ADR 0014, SHACL notation; §2 gives the general rules). A property shape is a row of its owner card or
-- a line (edge) to its range. While the edge shows, the row hides. The edge is a placement of the property shape.
-- An element that arrives in a view turns the properties between it and the elements of the view into edges, both directions.
-- A target that Show as Edge or a property edit places does not arrive: only that property becomes an edge.
-- A new property whose owner and target show is an edge. An edge whose owner or target leaves becomes a row.
-- A selected element shows its rows to and from elements of the view as dashed edges. ⇥ on a dashed edge shows it as an edge.
-- A shown property shape has a dashed targeting edge to a shown node shape when its simple path equals that shape's sh:targetSubjectsOf predicate.
-- Object-target connectors start at a represented object-end shape when available.
-- Without an object-end shape, the connector starts at the property owner and says "objects of".
-- A node-level constraint connects its source shape to its referenced shape and says "sh:node".
-- A shown instance and its checked shape have a connector labeled with the applicability reasons.
-- Targeting edges are derived. They have arrowheads and no edit controls or persisted placements.
-- A logical constraint (sh:xone, sh:or, sh:and over property shapes) is a hub. Placed, it shows a hub with its member edges.
-- Unplaced, it is a row group of its card: "xone", then one sub-row per member. Hub and members are placed and removed as one unit.
-- Del on the hub, on a member line or on its private pill removes the unit. ⇥ on the row group places the hub and the boxes it needs.
-- An alternative range (sh:or of ranges) is a "one of" box placed by its list. Unplaced, its row shows the box inline.
targetingConnector :: Iri -> [Iri] -> Bool
-- | A property path forms a targeting connector when it matches any subject-target predicate.
targetingConnector path targetPredicates = path `elem` targetPredicates
-- | Shape cards show all subject-target predicates. The Properties field accepts one predicate per line.
subjectTargetText :: [Iri] -> String
subjectTargetText = unlines

data PropertyDisplay = AsPropertyRow | AsEdge | AsDashedEdge deriving Eq
propertyDisplay :: Bool -> Bool -> Bool -> PropertyDisplay   -- edge placed, owner and target shown, an end selected
propertyDisplay True True _ = AsEdge
propertyDisplay _ True True = AsDashedEdge
propertyDisplay _ _ _ = AsPropertyRow
law_rowXorEdge :: Bool -> Bool -> Bool -> Bool
law_rowXorEdge placed bothShown sel = (propertyDisplay placed bothShown sel == AsEdge) == (placed && bothShown)
constraintRowGroup :: String -> [String] -> [String]   -- operator, member rows
constraintRowGroup op members = op : map ("  " ++) members

-- 6.2 Pills and list boxes ----------------------------------------------------------

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
data RangeTarget = NodeShapeCard | ValueSetCard | ClassPill | ListBox | DatatypePill | NodeKindPill | AnyPill | InstanceCard
  deriving Eq
data RangeSpec
  = ClassRange Bool Bool     -- the class has a node shape, an instance has the class IRI
  | NodeShapeRange
  | DatatypeRange
  | NodeKindRange
  | InRange                  -- sh:in
  | OneOfRange               -- sh:or of ranges
  | HelperRange Bool         -- a SKOS helper shape; True: it has no other statements
  | NoRangeGiven
rangeTarget :: RangeSpec -> RangeTarget
rangeTarget r = case r of
  ClassRange True _ -> NodeShapeCard
  ClassRange False True -> InstanceCard
  ClassRange False False -> ClassPill
  NodeShapeRange -> NodeShapeCard
  DatatypeRange -> DatatypePill
  NodeKindRange -> NodeKindPill
  InRange -> ListBox
  OneOfRange -> ListBox
  HelperRange True -> ValueSetCard
  HelperRange False -> NodeShapeCard
  NoRangeGiven -> AnyPill
isPrivate :: RangeTarget -> Bool
isPrivate t = t `elem` [DatatypePill, NodeKindPill, AnyPill]
leavesWithLastLine :: RangeTarget -> Bool -> Bool    -- target, a line brought it (view:keptByLines)
leavesWithLastLine t brought = t `elem` [ClassPill, ListBox] || brought
inRow :: String -> [String] -> Maybe Int -> Maybe Int -> String   -- path, members, sh:minCount, sh:maxCount
inRow path ms mn mx = path ++ ": " ++ listInline False ms ++ " " ++ multiplicity mn mx

-- 6.3 Show as Edge ------------------------------------------------------------------

-- | Show as Edge, ⇥ or a row drag places the target as a card or list box when the view does not show it, with view:keptByLines.
-- A row with a private end has no ⇥: it is a line only in a hub. A drop on empty canvas centers the box at the pointer.
-- A drop on a valid card changes the target.
-- Return arrow, Show as Row or Del returns an ordinary property edge to its row. The constraint stays.
-- The return arrow shows on edge hover or selection. ⇥ and ➟ show on row hover. All three use the same circled arrow.
-- A shared property changes display in all its owner cards of that view only. Node-shape targets stay when their edges return.
hasShowAsEdge :: RangeTarget -> Bool
hasShowAsEdge = not . isPrivate
centeredAt :: (Double, Double) -> (Double, Double) -> Bounds   -- pointer, size
centeredAt (px, py) (w, h) = (px - w / 2, py - h / 2, w, h)

-- 6.4 Property input ----------------------------------------------------------------

-- | Property input. + attribute makes xsd:string with cardinality 0..1.
-- Enter makes the row and opens the next input. Tab makes the row and opens its value picker.
-- A property made by a link starts at 0..*. Its default path gets the creation follow-up.
-- Double-click a path or edge label to edit the path. Double-click a pill to edit the target.
-- A click on the cardinality badge cycles 0..* → 0..1 → 1 → 1..*, then 0..* again. Other values go to 0..*.
-- Inputs accept names, compact IRIs and full IRIs. Known unambiguous class names resolve to existing classes.
-- Reject ambiguous class names and unknown prefixes. Else a typed name uses canonical-md. Alternatives: a | b.
type Cardinality = (Maybe Int, Maybe Int)          -- sh:minCount (Nothing: 0), sh:maxCount (Nothing: unbounded)
newAttribute :: (Iri, Cardinality)
newAttribute = ("xsd:string", (Nothing, Just 1))
linkPropertyCardinality :: Cardinality
linkPropertyCardinality = (Nothing, Nothing)
nextCardinality :: Cardinality -> Cardinality
nextCardinality (mn, mx) = case cardinalityText mn mx of
  "0..*" -> (Nothing, Just 1)
  "0..1" -> (Just 1, Just 1)
  "1" -> (Just 1, Nothing)
  _ -> (Nothing, Nothing)
law_cardinalityCycle :: Bool
law_cardinalityCycle = map text (take 5 (iterate nextCardinality (Nothing, Nothing))) == ["0..*", "0..1", "1", "1..*", "0..*"]
  where text = uncurry cardinalityText
data NameInput = TypedName String [Iri] | CompactIri String String | FullIri Iri   -- a name and the known classes with it
data NameResult = Resolved Iri | Rejected String | Minted String deriving Eq   -- Minted: canonical-md makes the IRI
resolveName :: [(String, Iri)] -> NameInput -> NameResult
resolveName _ (TypedName _ [c]) = Resolved c
resolveName _ (TypedName n []) = Minted n
resolveName _ (TypedName _ _) = Rejected "The class name is ambiguous."
resolveName table (CompactIri p l) = maybe (Rejected ("Unknown prefix " ++ p ++ ".")) (\ns -> Resolved (ns ++ l)) (lookup p table)
resolveName _ (FullIri i) = Resolved i
alternativesInput :: String -> [String]
alternativesInput = filter (not . null) . map trimSpaces . splitOn '|'
  where trimSpaces = reverse . dropWhile (== ' ') . reverse . dropWhile (== ' ')
splitOn :: Char -> String -> [String]
splitOn c s = case break (== c) s of
  (a, []) -> [a]
  (a, _ : rest) -> a : splitOn c rest

-- 6.5 Alternatives ------------------------------------------------------------------

-- | Three forms of alternatives. Keep them distinct.
data OneOf
  = LogicalConstraint  -- sh:or, sh:xone, sh:and or sh:not on a node shape; members describe required properties
  | OneOfTarget        -- sh:or on a property shape; members describe permitted ranges
  | ValueList          -- permitted values, also sh:in checks from SKOS schemes or collections
  deriving Eq
-- The logic handle of a free property edge joins another free property of the same shape into an Or constraint.
-- A drop on the constraint ring of that shape adds the property. Other drops do nothing.
-- Constraint members have no logic handle.
-- A property target handle adds a range. One remaining alternative reduces to a plain range.
-- A one-of target box lists targets without cards and draws edges to targets with cards.
-- Its + target control opens a picker. ➟ places a target card. × removes an alternative. The picker does not make new sets.
data Ranges = PlainRange Iri | OneOfRanges [Iri] | NoRange deriving Eq
rangesOf :: [Iri] -> Ranges
rangesOf [] = NoRange
rangesOf [r] = PlainRange r
rangesOf rs = OneOfRanges rs
logicDrop :: Bool -> Bool -> Bool -> Maybe LogicalOperatorDrop   -- same shape, target free, target is the constraint ring
logicDrop True True False = Just JoinIntoOr
logicDrop True _ True = Just AddToConstraint
logicDrop _ _ _ = Nothing
data LogicalOperatorDrop = JoinIntoOr | AddToConstraint deriving Eq
oneOfBoxLists :: [(Iri, Bool)] -> ([Iri], [Iri])   -- each target and whether it has a card: listed, edges
oneOfBoxLists ts = ([t | (t, False) <- ts], [t | (t, True) <- ts])
-- | Containers: a node shape card, an entity group, a value set and a one-of target box. Reason: one behavior for every container.
-- All four select, move, resize with eight handles, take Del and hover the same way.
-- One rule gives the rows of each: a part is a row unless the view draws it, as its own box or as a line from the container.
-- Each kind declares only its row buttons and their effects: ➟ (take out), × (remove) and the add row.
-- ➟ shows the member in its own box beside its row, with a line from the container. Removing that box or line returns the row.
-- Entity group: ➟ takes the member out of the group (a view grouping), so no line is drawn and no row returns.
-- A one-of alternative with sh:node and no own property shapes is a line of its box, never a node shape card of its own.
data Container = ShapeCardBox | CollectionBox | ValueSetBox | OneOfBox deriving (Eq, Enum, Bounded)
containerHandles :: Container -> Int
containerHandles _ = resizeHandles
partIsRow :: Bool -> Bool                           -- the view draws the part (its own box or a line from the container)
partIsRow drawn = not drawn
memberShownAs :: Container -> Bool -> String        -- the member has its own box or line in the view
memberShownAs CollectionBox ownBox = if ownBox then "card outside the collection" else "row"
memberShownAs _ ownBox = if ownBox then "line from the container" else "row"
law_memberRowOrLine :: Container -> Bool -> Bool
law_memberRowOrLine k drawn = (memberShownAs k drawn == "row") == partIsRow drawn

-- 6.6 Value sets --------------------------------------------------------------------

-- | Value sets. Scheme + concept and collection + member inputs: Enter for another entry, Escape to close.
-- The new row shows at once as a pending row. A server model with that label replaces it.
-- A failed command, or 5 s without such a model, removes the pending row (ADR 0013).
-- Collection inputs select existing concepts by label or compact IRI. Double-click a concept row to rename it.
-- ➟ shows a concept card. Removing that card returns its row. A concept without own statements cannot become a card this way.
-- Drag a concept row onto another to add a broader parent. Its tooltip lists the parents. There is no remove-parent control.
pendingTimeoutMs :: Double
pendingTimeoutMs = 5000
pendingRowShown :: Double -> Bool -> Bool -> Bool   -- ms since the input, the command failed, a server model has the label
pendingRowShown elapsed failedCmd confirmed = not failedCmd && not confirmed && elapsed < pendingTimeoutMs
conceptDrop :: Iri -> Iri -> EditCommand            -- dragged concept, concept under the pointer
conceptDrop = SetConceptBroader

-- 6.7 Shape proposal ----------------------------------------------------------------

-- | Shape proposal. Propose Node Shapes from Data applies to a class without a shape, or an instance whose type has no shape.
-- It is disabled on a class that a shape targets. Model → Propose Missing Shapes does the same for all such classes.
-- After both, a new view "proposed shapes" shows the new shapes with the Layered layout, focused, the shapes selected.
data ProposalSubject = AClass Bool | AnInstance [Bool]   -- a class and whether a shape targets it; an instance, the same for each type
proposeApplies :: ProposalSubject -> Bool
proposeApplies (AClass hasShape) = not hasShape
proposeApplies (AnInstance typesHaveShapes) = not (and typesHaveShapes)
proposalViewLabel :: String
proposalViewLabel = "proposed shapes"

-- 7. Appearance and layout ---------------------------------------------------

-- 7.1 Style -------------------------------------------------------------------------

-- | Style means the same on every view. Geometry belongs to a placement only.
-- The most specific value wins: placement, then element. Both levels are Project statements.
-- Class-level style is outside this contract. Geometry has no element-level fallback.
data Style = Style { color :: Maybe String }
data Geometry = Geometry { box :: (Double, Double, Double, Double), sides :: (Maybe Side, Maybe Side) }
styleOf :: Resource -> Maybe Style   -- the style statements of one level
style :: Element -> Style            -- the effective style of a placement
style p = Style { color = (styleOf p >>= color) <|> (styleOf (elementOf p) >>= color) }
geometryOf :: Element -> Maybe Geometry   -- a placement: its geometry; any other element: Nothing
law_noElementGeometry :: Element -> Bool
law_noElementGeometry e = not (isPlacement e) ==> isNothing (geometryOf e)

-- 7.2 Appearance panel --------------------------------------------------------------

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
-- Resize: eight handles on one selected box. Content sets the minimum heights of containers (§6.5).
-- Frames have their own minimum size. A frame move updates its cards after release, without live feedback.
data AppearanceSection = StyleSection | ViewSettingsSection | PreferencesSection deriving (Eq, Enum, Bounded)
mixed :: Eq a => [a] -> Maybe a                   -- the shown value: Nothing when the values differ
mixed (x : xs) | all (== x) xs = Just x
mixed _ = Nothing
minimumSize :: Double
minimumSize = 40
sizeAccepted :: Double -> Double -> Bool
sizeAccepted w h = w >= minimumSize && h >= minimumSize
data StoredColor = DefaultColor | NoColor | Preset Int | White | CssColor String deriving Eq
validColor :: StoredColor -> Bool
validColor (Preset n) = n >= 1 && n <= 6
validColor _ = True
data Display = Detailed | Simple deriving Eq
showDetailsChecked :: [Display] -> Bool
showDetailsChecked = all (== Detailed)
showDetailsClick :: [Display] -> Display          -- the display that a click gives to all cards
showDetailsClick ds = if showDetailsChecked ds then Simple else Detailed
resizeHandles :: Int
resizeHandles = 8

-- 7.3 Preferences -------------------------------------------------------------------

-- | Person preferences, on all views: theme, Card text (8–72 px, default 22), Note text, Group text, edge style, layout spacing.
-- Minimum content heights follow the card scale. Some widths and labels do not yet (open.md FONT1).
-- Rightward shape-link cardinality goes below the line, labels above it.
cardTextSize :: Maybe Int -> Int
cardTextSize = maybe 22 (clampSize 8 72)

-- 7.4 Edge routing ------------------------------------------------------------------

-- | Edge styles: orthogonal, polyline, curved, direct (default).
-- Except direct, route around boxes and pills, not frames. Keep explicit sides. Put labels on the longest horizontal segment.
-- Route again after geometry changes. Self-links keep their loop.
-- Limit: dense routes and labels can overlap. Direct routes cross boxes.
data EdgeStyle = Orthogonal | Polyline | Curved | Direct deriving (Eq, Enum, Bounded)
defaultEdgeStyle :: EdgeStyle
defaultEdgeStyle = Direct
routesAroundBoxes :: EdgeStyle -> Bool
routesAroundBoxes s = s /= Direct
labelSegment :: [((Double, Double), (Double, Double))] -> Maybe ((Double, Double), (Double, Double))
labelSegment segs = case sortOn (negate . len) [s | s@((_, y1), (_, y2)) <- segs, y1 == y2] of
  s : _ -> Just s
  [] -> Nothing
  where len ((x1, _), (x2, _)) = abs (x2 - x1)

-- | Center each label on its chosen segment, or at the curve midpoint, to reduce overlap with target cards.
edgeLabelFraction :: Double
edgeLabelFraction = 0.5

-- | Direct parallel edges reserve screen-space lanes so zoom does not collapse labels and badges.
-- Vertical lanes also reserve estimated label width. Clamp attachment points inside each card side.
directLanePitch :: Double -> Double -> Double
directLanePitch zoom font = max (48 / max 0.001 zoom) (2.5 * font)

-- | Self-links have a horizontal label run and separate loop heights so their labels remain readable.
selfLoopClearance :: Double -> Double
selfLoopClearance zoom = max 80 (64 / max 0.001 zoom)

-- 7.5 Layout ------------------------------------------------------------------------

-- | Paste packs only new placements near the pointer. Existing placements remain fixed obstacles.
-- Copied frames move with their contents. Dimensions, appearance and copied edge sides stay unchanged.
-- Packing uses drawn sizes at the current card text scale and reserves space for private pills.
-- After paste, fit the new placements into the viewport, with padding 40 and zoom at most 1.
pasteFitPadding, pasteMaxZoom :: Double
pasteFitPadding = 40
pasteMaxZoom = 1
pastePositions :: [(Id, (Double, Double))] -> [(Id, (Double, Double))] -> Bool
pastePositions old new = all (`elem` new) old
law_pasteKeepsOldPositions :: [(Id, (Double, Double))] -> [(Id, (Double, Double))] -> Bool
law_pasteKeepsOldPositions old added = pastePositions old (old ++ added)

-- | Apply Layout runs only on request. Layered uses ELK left-to-right. Force uses cola.js and overlap removal.
-- Both replace the arrangement. Routing stays a rendering task, not ELK output. Layout clears edge sides.
-- After the new positions show, the view fits its content (padding 40, zoom at most 1). Zoom range: 0.001 to 20.
-- Spacing: 20–400 px, default 120. Layered uses twice that between columns.
-- Frames move as blocks and keep their size. A card goes inside its smallest containing frame.
-- Try reduced spacing inside a full frame. If the minimum spacing cannot fit, keep those cards in place.
-- Outer layout treats an edge to a contained card as an edge to its frame.
-- Layout uses drawn card sizes at the current text scale. A card box includes its private pills (§6.2).
-- A list box and a class pill are layout boxes. A member of an entity group is not: the group is.
-- A hub is a layout node. A hub placement without a position gets one from the layout (open.md LAYOUT1).
-- Each connected component is laid out alone. Components pack near width/height 1.6, or the free area of a frame.
-- If an ELK algorithm fails, use ELK box packing for those boxes.
-- Limit: Force link length ignores card size. Frame title padding does not measure text.
-- Limit: Layered reserves no room for edge labels.
data LayoutAlgorithm = Layered | Force deriving Eq
layoutSpacing :: Maybe Double -> Double
layoutSpacing = maybe 120 (max 20 . min 400)
columnSpacing :: LayoutAlgorithm -> Double -> Double
columnSpacing Layered s = 2 * s
columnSpacing Force s = s
fitPadding, maxFitZoom, minZoom, maxZoom, packingAspect :: Double
fitPadding = 40
maxFitZoom = 1
minZoom = 0.001
maxZoom = 20
packingAspect = 1.6
fitZoom :: (Double, Double) -> (Double, Double) -> Double   -- viewport size, content size
fitZoom (vw, vh) (cw, ch) = max minZoom (minimum [maxFitZoom, vw / (cw + 2 * fitPadding), vh / (ch + 2 * fitPadding)])
layoutClearsSides :: [Id] -> EditCommand -> Bool
layoutClearsSides connectors c = case c of
  SetLayout _ _ cleared -> sameSet cleared connectors
  _ -> False
smallestFrame :: [(Element, Double)] -> Maybe Element   -- containing frames and their areas
smallestFrame fs = case sortOn snd fs of
  (f, _) : _ -> Just f
  [] -> Nothing
isLayoutBox :: RangeTarget -> Bool
isLayoutBox t = not (isPrivate t)

--------------------------------------------------------------------------------
-- Part IV. Panels and workspace
--------------------------------------------------------------------------------

-- 8. Panels ------------------------------------------------------------------

-- 8.1 Side panels -------------------------------------------------------------------

-- | Side panel width: the stored width, the default width (new layout), or the width of the last sash drag.
-- A window resize widens a narrower open side panel to that width. Reason: a tiling window manager resizes the window after the restore.
-- Default width: left min(280 px, 20 % of the window), right min(320 px, 24 % of the window).
data PanelSide = LeftPanel | RightPanel deriving Eq
defaultPanelWidth :: PanelSide -> Double -> Double  -- side, window width
defaultPanelWidth LeftPanel w = fromIntegral (round (min 280 (w * 0.2)) :: Int)
defaultPanelWidth RightPanel w = fromIntegral (round (min 320 (w * 0.24)) :: Int)
widthAfterResize :: Double -> Double -> Double      -- wanted width (stored, default or last drag), current width
widthAfterResize wanted current = max wanted current

-- 8.2 Right area and applicable shapes ------------------------------------------------

-- | Right area: sections derive their content from the same selection. Mixed selections show mixed values.
-- Element: outgoing statements, fields of all applicable shapes grouped by shape, uncovered statements, errors beside fields.
-- Shape links, forms and canvas expansion use the same checked-node relation.
-- Visuals: figure, style and geometry, and whether each style value comes from the placement or the element.
-- Links: incoming statements by layer, placements across views, applicable shapes and source files.
-- A canvas placement gives Element and Links its element, and Visuals the placement. A placement row gives all sections the placement.
-- The user shows any combination of sections (person setting).
data Section = ElementSection | VisualsSection | LinksSection deriving (Eq, Enum, Bounded)
sectionSubject :: Pane -> Section -> Element -> Element   -- the pane of the selection, the section, the selected item
sectionSubject OnCanvas s x | isPlacement x && s /= VisualsSection = elementOf x
sectionSubject _ _ x = x

-- | Applicable shapes. Targeting and conformance are different relations. The user does not choose one shape lens.
-- Overlapping shapes can repeat a property. A first implementation can show the type's shape plus uncovered statements.
data Shape
applies :: Element -> [Shape]
uncovered :: Element -> [Statement]
covers :: Shape -> Statement -> Bool
law_uncovered :: Element -> Bool
law_uncovered e = all (\st -> not (any (`covers` st) (applies e))) (uncovered e)

-- 8.3 Properties layout -------------------------------------------------------------

-- | Properties layout. The head shows kind and name, then an action toolbar.
-- Toolbar icons: Open in and the next and previous view, then name actions. A "More actions" menu lists all applicable actions and keys.
-- Delete from Model is the last menu item. Violations show in a box below the toolbar.
-- A field label shows its RDF term at the right. Long help is a tooltip on a "?" icon.
-- Node shape: shape fields, then properties (path, target, cardinality, required ones marked), then Reads as (closed by default).
-- Property shape: Reads as first, then the fields. Cardinality has buttons for 0..1, 1, 0..* and 1..*, and a text field.
-- Literal constraints and statements not in shapes are closed by default. Their headings show a summary.
moreActionsMenu :: [String] -> [String]            -- the other applicable actions
moreActionsMenu as = filter (/= "Delete from Model") as ++ ["Delete from Model" | "Delete from Model" `elem` as]
cardinalityButtons :: [Cardinality]
cardinalityButtons = [(Nothing, Just 1), (Just 1, Just 1), (Nothing, Nothing), (Just 1, Nothing)]

-- | An instance with statements in imported files (spec/manifest.hs §2.6) shows an Imported row with those files.
-- An imported label, IRI or value outside the SHACL form shows as text, without an edit or remove control.
-- The SHACL form edits all its values. A change of an imported value fails, and the window asks to mark the files as own.
-- Edits, undo and redo ask in the same way (spec/manifest.hs §2.6). Cancel keeps the files imported, and the form shows the model.
data ValueControl = EditControl | TextOnly deriving Eq
valueControl :: Bool -> ValueControl                -- the value is in an imported file
valueControl locked = if locked then TextOnly else EditControl
data MarkOwnAnswer = MarkOwnAndRun | KeepImported deriving Eq
afterRefusal :: MarkOwnAnswer -> [String]            -- what the window does after a change failed on imported files
afterRefusal MarkOwnAndRun = ["mark the files as own", "run the change again"]
afterRefusal KeepImported = []

-- | A view exposes Markdown Notes in Properties. Its external-link icon moves editing into a native Theia Markdown editor beside the diagram.
-- Opening the editor saves the Properties field first and removes that text area. One editing surface prevents competing local drafts.
-- Closing the editor restores the Properties text area. The diagram stays open.
data ViewNotesSurface = NotesProperties | NotesMarkdown deriving Eq
notesPropertiesVisible, notesMarkdownVisible :: ViewNotesSurface -> Bool
notesPropertiesVisible surface = surface == NotesProperties
notesMarkdownVisible surface = surface == NotesMarkdown
law_notesSingleEditor :: ViewNotesSurface -> Bool
law_notesSingleEditor surface = notesPropertiesVisible surface /= notesMarkdownVisible surface

-- | Properties saves Notes on blur, like Label. Monaco saves after 300 ms without input and flushes pending text on close.
-- Neither surface has Save or Revert buttons. A successful close needs no save prompt. A failed save keeps the editor and text.
-- Each save uses one guarded command. The storage command and predicate retain their existing description names for compatibility.
viewNotesEdit :: Id -> String -> String -> EditCommand
viewNotesEdit v original text = SetViewDescription v text (Just original)
law_notesGuarded :: Id -> String -> String -> Bool
law_notesGuarded v original text = case viewNotesEdit v original text of
  SetViewDescription v' text' expected -> v' == v && text' == text && expected == Just original
  _ -> False

-- 8.4 Files navigator ---------------------------------------------------------------

-- | Files navigator: filesystem entries, not elements. File selection does not change the element selection.
-- Each file shows what its triples contain (views, shapes, instances). A view row opens its view.
-- Opening a file selects its own editor when there is one, else source text.
-- Each file tail shows one letter per kind: W workspace, V view, D default file, S shapes, C concepts, I instances,
-- R imported (read only), ! not read. The context menu of a model file or view file has Mark as Imported, or Mark as Own
-- when it is imported.
data FileContent = HasViews | HasShapes | HasInstances deriving Eq
data FileMark = MarkWorkspace | MarkView | MarkDefault | MarkShapes | MarkConcepts | MarkInstances | MarkImported | MarkNotRead
  deriving (Eq, Enum, Bounded)
markLetter :: FileMark -> Char
markLetter m = "WVDSCIR!" !! fromEnum m
importMenuItem :: Bool -> String                   -- the file is imported
importMenuItem imported = if imported then "Mark as Own" else "Mark as Imported"
editorFor :: FilePath -> Maybe Element -> Document   -- a file, its view
editorFor _ (Just v) = OpenView v
editorFor f Nothing = AsText f

-- 8.5 Model explorer ----------------------------------------------------------------

-- | Model explorer (ADR 0006): the sections come from explorer plugins (@catenary/explorer). The core has no section rules.
-- Reason: a new vocabulary (SKOS) adds a plugin, not a special case in the explorer.
-- A plugin query runs only when a folder opens. A folder shows its child count and reads pages of 100. A last "Show more" row reads the next page.
-- Sections: Classes (@catenary/rdfs), then Shapes (@catenary/shacl). A section with no rows in scope is not shown.
-- Classes: each object of rdf:type in scope, nested by written rdfs:subClassOf, then its direct instances. No inference, no hidden types.
-- Shapes: each node shape (typed sh:NodeShape, or a subject of sh:property), then its property shapes in sh:order, then by name.
-- A property shape row needs the node shape and the property shape in scope. Their statements can be in different files.
-- Reason: a property shape that another file states is a reference in this file (the scope rule below).
-- Classes include the vocabulary of view files (view:Placement). A data file has none: only its own subjects are in scope.
-- An IRI has a row in each section that has it (a node shape is also an instance of sh:NodeShape). Reason: the data shows as written.
-- A class row and a node shape row are also elements: their selection is the class or the shape.
-- Rows have no view state and no violation counts. Properties shows the violations of the selected element.
-- Open in → Model reveals a chosen path. Ordinary selection opens no folder. A repeated ancestor key stops expansion.
-- Delete Elements Not Placed in a View walks the elements of a folder at all depths. It tests own placements and confirms first.
pageSize :: Int
pageSize = 100
folderPage :: Int -> [String] -> ([String], Maybe Int)   -- pages read, row labels: shown rows and the "more" count
folderPage pages rows =
  let sorted = sortOn id rows
      shown = take (pages * pageSize) sorted
      rest = length sorted - length shown
  in (shown, if rest > 0 then Just rest else Nothing)
folderOf :: [Iri] -> [Iri]                          -- written types of a subject: the class folders with a row for it
folderOf ts = ts
notPlaced :: Element -> Bool                        -- Delete Elements Not Placed in a View: own placements only
notPlaced e = null (placements e)

-- | Model opens a document tree for a file. Reopening that presentation focuses the same tree.
-- No global Model explorer appears in the default layout. Search remains workspace-wide.
-- Open in… goes between the Model document, the Source and the Canvas of an element (§4.7).
-- Workspace metadata stays outside the model index. Its Model document uses the existing explorer query.
-- Reason: presentation navigation must not change storage or explorer contents in this phase.
-- The scope uses source statements, not namespaces or named graphs. Referenced-only resources do not belong to the scope.
-- The filter shows one flat list of the element rows in scope whose name matches, best first, at most one page.
-- Each row says where it is (its classes, its node shape). Reason: a filtered tree must read every folder of the file.
-- Fuzzy matching takes characters in order, ranks word starts and consecutive matches, and highlights matching characters.
-- Clearing the filter restores the tree and its expansion state. The filter does not change drag membership.
-- Typing on a focused row uses the same filter input. Escape clears the input and restores the tree.
-- Reason: a second highlight-only search leaves nonmatching rows visible and gives conflicting results.
data ExplorerFilterInput = RowTyping String | FilterTyping String
explorerFilterText :: ExplorerFilterInput -> String
explorerFilterText (RowTyping text) = text
explorerFilterText (FilterTyping text) = text
law_typeToFilter :: String -> Bool
law_typeToFilter text = explorerFilterText (RowTyping text) == explorerFilterText (FilterTyping text)

-- A folder drag carries all descendant elements, including hidden rows, with duplicates removed.
-- A canvas drop places existing elements in one undo step. A folder drag never creates an instance.
-- A file-tree drop confirms the total count and destination, then moves source statements in one undo step (§2.4).
-- A same-file drop does nothing. File transfers require a file-scoped source tree.
folderDrag :: [Id] -> [[Id]] -> [Id]
folderDrag selected descendants = nub (selected ++ concat descendants)
law_folderDragAll :: [Id] -> [[Id]] -> [Id] -> Bool
law_folderDragAll selected descendants hidden =
  sameSet (folderDrag selected descendants) (nub (selected ++ concat descendants))
  && all (\i -> i `notElem` concat descendants || i `elem` folderDrag selected descendants) hidden

-- 8.6 Search ------------------------------------------------------------------------

-- | Search: a faceted search on the store. Things: subjects with a type, subjects with a label and no type (rdfs:Resource),
-- property shapes (subjects of sh:path) and predicates in use. View internals, RDF structure and the report graph are not things.
-- Facets: text, type, Linked to. All set facets must match. Text matches every word in the local name or in a literal.
-- Linked to gives the other ends of the statements of an element, optionally by predicate and direction. Statements are not results.
-- Each facet value shows its count with the other facets applied. At most 200 results, sorted by label.
-- Double-click runs Open in… (§4.7). A drag of a property result places its owner shape. Find Element (Ctrl+T) uses the same search.
data Thing = Thing { thingLabel :: String, thingTexts :: [String], thingTypes :: [Iri], thingLinked :: [Iri] }
data Facets = Facets { textFacet :: Maybe String, typeFacet :: Maybe Iri, linkedFacet :: Maybe Iri }
matches :: Facets -> Thing -> Bool
matches f t =
  maybe True (\q -> all (\w -> any (containsWord w) (thingTexts t)) (words q)) (textFacet f)
    && maybe True (`elem` thingTypes t) (typeFacet f)
    && maybe True (`elem` thingLinked t) (linkedFacet f)
  where containsWord w s = lowerCase w `isInfixOf` lowerCase s
lowerCase :: String -> String
lowerCase = map toLower
searchLimit :: Int
searchLimit = 200
search :: Facets -> [Thing] -> [Thing]
search f ts = take searchLimit (sortOn thingLabel (filter (matches f) ts))
law_facetsConjoin :: Facets -> Thing -> Bool
law_facetsConjoin f t =
  matches f t == and [ matches f { typeFacet = Nothing, linkedFacet = Nothing } t
                     , matches f { textFacet = Nothing, linkedFacet = Nothing } t
                     , matches f { textFacet = Nothing, typeFacet = Nothing } t ]

-- 8.7 Show --------------------------------------------------------------------------

-- | Show: prefer the active view when it shows the element, else the first matching view by label.
-- No matching view: select the element for the panels. F3 and Shift+F3 move between occurrences.
data ShowTarget = ShowIn Element | SelectForPanels deriving Eq
showTarget :: Maybe Element -> [(String, Element)] -> ShowTarget   -- active view, (label, view) of the views that show it
showTarget (Just a) vs | a `elem` map snd vs = ShowIn a
showTarget _ vs = case sortOn fst vs of
  (_, v) : _ -> ShowIn v
  [] -> SelectForPanels

-- 8.8 Links -------------------------------------------------------------------------

-- | Links: views, and outgoing and incoming statements of model and shapes. Omit rdf:type and literals.
-- An RDF list is one predicate step. A self-link shows as outgoing only. Mixed selections show ownership counts.
-- A row without a navigable element is inactive. A statement-row action targets its relation, else the other end.
-- A view row targets the matching placements. Limit: no arrows and no entity-group membership from view graphs (open.md G4).
data LinkRow = OutgoingRow Statement | IncomingRow Statement deriving Eq
linkRows :: Iri -> [Statement] -> [LinkRow]          -- element, statements of model and shapes with IRI objects
linkRows e sts =
  [OutgoingRow st | st@(Node s, p, _) <- sts, s == e, p /= "rdf:type"]
    ++ [IncomingRow st | st@(Node s, p, Node o) <- sts, o == e, s /= e, p /= "rdf:type"]
law_selfLinkOutgoingOnly :: Iri -> Iri -> Bool
law_selfLinkOutgoingOnly e p = p /= "rdf:type" ==> linkRows e [(Node e, p, Node e)] == [OutgoingRow (Node e, p, Node e)]

-- | Selected node shapes show an Instances folder, including targets outside the current view.
-- Use SHACL class, node, subject and object targets. Include declared subclasses and implicit class targets.
-- Deduplicate instances across selected shapes. Sort rows by display label. Enter and double-click navigate to the instance.
shapeInstances :: Eq a => [[a]] -> [a]
shapeInstances = nub . concat
law_shapeInstances :: Eq a => [a] -> Bool
law_shapeInstances xs = shapeInstances [xs, xs] == nub xs

-- 8.9 Outline -----------------------------------------------------------------------

-- | Outline follows the active document. A canvas Outline lists frames, cards and placed relations.
-- A group row selects its frames and cards, not relation rows. Ctrl+click adds rows.
-- Outline actions exclude canvas-only creation and layout controls.
data OutlineRow = FrameRow Element | CardRow Element | RelationRow Element | GroupRow [OutlineRow] deriving Eq
groupRowSelects :: OutlineRow -> [Element]
groupRowSelects r = case r of
  FrameRow e -> [e]
  CardRow e -> [e]
  RelationRow _ -> []
  GroupRow rs -> concatMap groupRowSelects rs

-- 8.10 Problems ---------------------------------------------------------------------

-- | Problems. A click on a row selects its focus instance and reveals Properties with its violations. Focus stays in Problems.
-- Double-click or Enter runs Open in… (§4.7). An instance row has the context menu of a Model explorer row
-- and drags its instance to a view. Problems and Properties share one report reader. Report statements are never data.
-- Limit: markers use line 1, column 1. Validation gives no text positions.
markerPosition :: (Int, Int)
markerPosition = (1, 1)

-- 8.11 Panel data rules -------------------------------------------------------------

-- | Panel data rules. Labels use the shared label query. Data reads exclude the report graph and give subjects no home graph.
-- Link and form candidates use the shared thing query. Link cardinality counts distinct values across data graphs.
-- SHACL form candidates include written members of sh:class ranges and their declared subclasses.
-- The link picker shows placed candidates first, 50 rows per section. Forms keep 200 candidates per class.
-- Relation and shape-link labels prefer configured prefix:local names. Instance predicates then use sh:name or the local name.
-- Links uses the same predicate-label rule.
-- A model change does not empty a panel. Properties shows its last data and actions until the new answer arrives.
-- A new SHACL form builds hidden and replaces the shown form when it is ready.
linkPickerSectionRows, formCandidatesPerClass :: Int
linkPickerSectionRows = 50
formCandidatesPerClass = 200
linkPicker :: [(Element, Bool)] -> ([Element], [Element])   -- candidates and whether the view places them: the two sections
linkPicker cs = (take linkPickerSectionRows [c | (c, True) <- cs], take linkPickerSectionRows [c | (c, False) <- cs])
linkCardinality :: [Iri] -> Int                     -- values across data graphs
linkCardinality = length . nub
predicateLabel :: [(String, Iri)] -> Maybe String -> Iri -> String   -- prefix table, sh:name, predicate
predicateLabel table name p = fromMaybe (fromMaybe (localName p) name) (compactIri table p)
panelShows :: Maybe a -> Maybe a -> Maybe a          -- new answer, last answer: a change never empties a panel
panelShows new lastAnswer = new <|> lastAnswer

-- 8.12 Source editors ---------------------------------------------------------------

-- | Source editors (Turtle, TriG): highlight directives, IRIs, names, literals, comments, punctuation.
-- Comment toggle and bracket pairs. Limit: no language server, completion or source validation.
data Token = Directive | IriToken | NameToken | LiteralToken | CommentToken | Punctuation deriving (Eq, Enum, Bounded)

-- 9. Markdown documents and export -------------------------------------------

-- 9.1 View embeds -------------------------------------------------------------

-- | A Markdown file of the workspace is a document. A document can embed views between its paragraphs.
-- An embed is a standard Markdown image with the complete view IRI as destination: ![Label](urn:name:Main).
-- The IRI is the identity of the view. Reason: it is the defined identity; a label changes, and an element id is a transport encoding.
-- The label is only the image text. An embed never stores an element id.
-- An image or a link definition is an embed when its destination is a view IRI or a URI with a scheme that is not a document scheme.
-- A link [text](iri) is never an embed: it stays a hyperlink. Code spans, fenced code and HTML comments hold no embeds.
-- Limit: an http or https image that names no view is an ordinary image, not an unresolved embed. Indented code is read as text.
data RefKind = ImageRef | LinkRef | DefinitionRef deriving Eq
documentSchemes :: [String]
documentSchemes = ["http", "https", "data", "file", "mailto", "ftp", "ftps", "tel", "blob"]
isViewEmbed :: [Iri] -> RefKind -> String -> Bool    -- view IRIs, kind, destination
isViewEmbed views kind dest
  | kind == LinkRef = False
  | dest `elem` views = True
  | otherwise = maybe False (`notElem` documentSchemes) (uriScheme dest)
uriScheme :: String -> Maybe String                   -- the scheme of an absolute URI (two letters or more), lower case
law_linkIsNoEmbed :: [Iri] -> String -> Bool
law_linkIsNoEmbed views dest = not (isViewEmbed views LinkRef dest)

-- | Insert View is in the context menu and the command palette of a text editor of a Markdown file. It needs an open workspace.
-- A picker lists the views by label, with the folder of the view file and the IRI. The embed replaces the selection at the cursor.
-- CLI: catenary run catenary.insertView '"<view IRI>"' inserts without the picker.
viewEmbedText :: String -> Iri -> String              -- label, view IRI
viewEmbedText label iri = "![" ++ altText label ++ "](" ++ markdownDestination iri ++ ")"
altText :: String -> String                           -- brackets and backslashes escaped, line breaks as spaces
markdownDestination :: String -> String               -- in angle brackets when empty or with spaces, parentheses or angle brackets
embedDestination :: String -> Maybe String            -- the destination of the first image of a text, without brackets and escapes
law_embedKeepsIri :: String -> Iri -> Bool
law_embedKeepsIri label iri = embedDestination (viewEmbedText label iri) == Just iri

-- | An embed resolves by IRI against the views of the open model. A label change keeps the embed.
-- A changed or removed view IRI makes the embed unresolved. Catenary reports it and does not repair it.
resolveEmbed :: [(Iri, Id)] -> Iri -> Maybe Id       -- views by IRI, embed
resolveEmbed views iri = lookup iri views

-- 9.2 Export ------------------------------------------------------------------

-- | Export Markdown… is in the context menu of a folder in the file navigator. The folder is the source.
-- Subfolders are included and keep their paths. Hidden folders (a name that starts with ".") and linked folders are not read.
-- Hidden files in other folders are documents.
-- A folder dialog asks for the destination. It starts at the last destination of the same source folder (window storage).
-- CLI: catenary run catenary.exportMarkdown '"/abs/source"' '"/abs/destination"'. Without arguments it uses the navigator selection and asks.
-- The export reads and checks everything, renders each embedded view once, and then writes. A check error writes nothing.
-- Check errors: an unresolved embed (with its file, line and IRI), a destination that is the source folder or is in it
-- (real paths, so a link does not hide it), a destination that is a file, and a conflict (§9.3).
-- Each document goes to its relative path. Each embed becomes a relative image link to _resources/<svgName>.
-- The text outside embeds and changed links does not change. Image text: the embed text, else the view label.
-- The SVG is the view editor export at exportZoom, without selection, halos, handles or edit controls. One SVG per view serves all embeds.
-- The export changes no source document, model file or view.
-- Not in this version: export sets or pages, Related sections, canvas references as navigation, embeds of other elements.
exportZoom :: Double
exportZoom = 1
svgName :: Iri -> FilePath                           -- the last name of the IRI and a hash of the whole IRI: a label does not change it
svgName iri = slug (lastName iri) ++ "-" ++ take 12 (sha256Hex iri) ++ ".svg"
slug, lastName, sha256Hex :: String -> String
law_svgNamesDistinct :: Iri -> Iri -> Bool            -- up to SHA-256 collisions
law_svgNamesDistinct a b = a /= b ==> svgName a /= svgName b
renderedOnce :: [Iri] -> [Iri]                        -- the embeds of all documents, in order: the views to render
renderedOnce = nub

-- | Local links. A Markdown document of the source folder: the link does not change. A file in the source folder: a copy at its path.
-- A file outside the source folder: a copy in _resources/ (its name and a hash of its path), and the link changes to the copy.
-- Reported, with the link unchanged: a missing target, a folder, an absolute path, a document outside the folder or in a hidden folder.
data LinkTarget = DocumentIn | FileIn FilePath | FileOutside FilePath | Missing | Unsupported String
linkChanges :: LinkTarget -> Bool
linkChanges (FileOutside _) = True
linkChanges _ = False

-- 9.3 Destination files -------------------------------------------------------

-- | _resources/.catenary-export.json records each file that an export wrote, with the SHA-256 of its content.
-- An export writes a file that does not exist, a file with the output content, or a recorded file without later changes.
-- Any other file at an output path is a conflict, and the export writes nothing. Two outputs at one path are a conflict.
-- A record file that Catenary did not write (no generator "Catenary") is a conflict. A link, a folder or a folder link out of the
-- destination at an output path is also a conflict. Reason: never overwrite a file that the export does not own.
-- A recorded file that the export no longer writes is removed when it did not change. Else it is kept, reported and no longer recorded.
-- The export does not write or remove other files. Each write goes to a temporary file and then a rename.
-- A failed write stops the export. The result names the failed file and the files written before it. The record keeps them.
type Hash = String
mayWrite :: Maybe Hash -> Hash -> Maybe Hash -> Bool   -- recorded hash, output hash, current hash (Nothing: no file)
mayWrite _ _ Nothing = True
mayWrite recorded out (Just now) = now == out || recorded == Just now
mayRemove :: Hash -> Hash -> Bool                      -- recorded hash, current hash
mayRemove recorded now = recorded == now
law_unownedNeverOverwritten :: Hash -> Hash -> Bool
law_unownedNeverOverwritten out now = mayWrite Nothing out (Just now) == (now == out)

-- 10. Settings ---------------------------------------------------------------

-- | Project settings live in the workspace file: prefixes, default file, placement of new subjects, exclusions, imported files.
-- Person settings stay outside the workspace: fonts, theme, visible right-area sections.
-- Workspace settings open as a main-area document, independent of the element selection (open.md D6).
-- Each kind of new subject (Shapes, SKOS / Collections, Everything else) is Auto or a file. Auto stores "near".
-- Everything else also sets the default file, the file of a subject that Auto cannot place. Its Auto stores no default file.
-- Browse selects an existing file in the workspace folder. A typed path that does not exist makes a new file at the first write.
-- An imported file is not a file of new subjects: the change is rejected with its message.
-- Imported lists the ws:imported globs, with Add and Remove, and Import Files. Import Files is also in the File menu.
-- Import Files asks for one or more RDF files, then shows the paths of the copies and the prefixes that the import added.
-- A rejected change shows its message below its row, not as a notification.
data SettingOwner = ProjectSetting | PersonSetting deriving Eq
data Setting = Prefixes | DefaultFile | PlacementSetting | Exclusions | ImportedFiles | Fonts | Theme | VisibleSections
  deriving (Eq, Enum, Bounded)
ownerOfSetting :: Setting -> SettingOwner
ownerOfSetting s = if s `elem` [Fonts, Theme, VisibleSections] then PersonSetting else ProjectSetting
data PlaceChoice = Auto | InFile FilePath deriving Eq
storedPlace :: PlaceChoice -> String               -- the value of ws:placeShapes, ws:placeConcepts or ws:placeInstances
storedPlace Auto = "near"
storedPlace (InFile f) = f
everythingElseDefaultFile :: PlaceChoice -> Maybe FilePath   -- the ws:defaultFile that the Everything else row stores
everythingElseDefaultFile Auto = Nothing
everythingElseDefaultFile (InFile f) = Just f
data RejectionPlace = BelowRow | AsNotification deriving Eq
rejectionPlace :: RejectionPlace
rejectionPlace = BelowRow

-- Compile-only stubs ----------------------------------------------------------

-- | GHC requires a binding for each primitive. Add a stub here for each new primitive. Do not give a stub behavior.

layer = manifestOnly
statementsOf = manifestOnly
domainAfter = manifestOnly
domainBefore = manifestOnly
isView = manifestOnly
isPlacement = manifestOnly
elementOf = manifestOnly
viewOf = manifestOnly
placements = manifestOnly
everything = manifestOnly
parts = manifestOnly
markClass = manifestOnly
inside = manifestOnly
notationsOf = manifestOnly
targets = manifestOnly
conformsToWhen = manifestOnly
makeFig = manifestOnly
hubMembers = manifestOnly
candidates = manifestOnly
needsShown = manifestOnly
coveredBy = manifestOnly
keptByLines = manifestOnly
linesTo = manifestOnly
documentsIn = manifestOnly
highlight = manifestOnly
setStyle = manifestOnly
setGeometry = manifestOnly
openInPane = manifestOnly
arity = manifestOnly
appliesTo = manifestOnly
commandsOf = manifestOnly
controlTarget = manifestOnly
controlCommand = manifestOnly
isTextKey = manifestOnly
followUp = manifestOnly
isViewFilePath = manifestOnly
classToolsShown = manifestOnly
localName = manifestOnly
compactIri = manifestOnly
validTarget = manifestOnly
hasEmptyCanvasAction = manifestOnly
notePatch = manifestOnly
styleOf = manifestOnly
geometryOf = manifestOnly
applies = manifestOnly
uncovered = manifestOnly
covers = manifestOnly
uriScheme = manifestOnly
altText = manifestOnly
markdownDestination = manifestOnly
embedDestination = manifestOnly
slug = manifestOnly
lastName = manifestOnly
sha256Hex = manifestOnly
