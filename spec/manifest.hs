-- | Catenary data contract: files, RDF, commands, transactions, persistence, read interface and CLI.
-- Interaction rules: spec/ui-manifest.hs. Unresolved decisions and known gaps: spec/open.md.
-- The file is a Haskell module. pnpm check typechecks it with GHC (scripts/check-manifests.mjs), so names and types stay consistent.
--
-- How to read a clause:
--   * A comment states a rule in prose. A clause below it states the same rule formally. Prose without a clause is a gap.
--   * An equation defines behavior from other clauses. It is the rule: the code must compute the same result.
--   * A primitive is a signature with a stub body (last section, "Compile-only stubs"). It names an observation of the
--     implementation that the contract does not define further. The comment beside it says where the code is.
--   * A law is a function named law_<name> that returns Bool. It must be True for all arguments. A test that checks a law
--     cites its name. a ==> b reads "if a, then b".
-- Signatures describe effects, not a wire schema. TypeScript defines exact fields (paths named in each section).
-- IO is an external effect. Tx is a synchronous store transaction. Backend is the state of one backend (§5.1).
--
-- Parts and sections. Code cites a section as "spec/manifest.hs §n" or "§n.m". Keep the numbers stable.
--   Part I    The model          §1 Terms and identity, §2 Workspace and files, §3 Store, §4 Views in RDF
--   Part II   Edits              §5 Transactions and history, §6 Edit commands, §7 Arrival and removal,
--                                §8 Shapes, SKOS and migrations, §9 Validation
--   Part III  Persistence        §10 Writes, Git and the watcher
--   Part IV   Interfaces         §11 Read interface, §12 CLI

module Catenary.Manifest where

import Prelude hiding (Left, Right)   -- Side uses these names. The contract never matches on Either.
import Control.Applicative ((<|>))
import Data.Char (isAsciiLower, isAsciiUpper, isDigit, toLower)
import Data.List (isPrefixOf, isSuffixOf, nub, sort, sortOn)
import Data.Maybe (fromMaybe, isJust, isNothing, listToMaybe)

-- | Design rules. Code comments cite them as "ADR <n>". Each line gives the rule, its reason, and where the contract states it.
-- ADR 0001  One operation per action for all element kinds (rename, setUri, delete, copy, setStatements, one view-box model);
--           kind-specific code only where the meaning differs (paths, ranges, sh:or lists, migrations). One read-model record
--           per kind, shared accessors. Reason: a fix applies to all kinds. §6.
-- ADR 0003  The files are the model; the store is an index. An edit writes a text patch at once and makes a Git commit. §2, §10.
-- ADR 0004  Files have no roles: what a file contains comes from its triples. §2.
-- ADR 0005  Electron app next to the browser app. One process, one profile, one ModelStore per workspace; a second window
--           starts a new process (scripts/desktop.sh, electron-main-module.ts). Headless Electron gives no working window.
-- ADR 0006  The Model explorer shows the sections of explorer plugins; a plugin query runs when a folder opens. spec/ui-manifest.hs §8.5.
-- ADR 0007  The frontend holds UI state only; panels read from backend queries. §11.
-- ADR 0011  View files are TriG; placement IRIs derive from what they place. §2.3, §4.
-- ADR 0012  No read model of the whole dataset; request-scoped read models from shared SPARQL rules. §3.3, §11.
-- ADR 0013  Client feedback until the server confirms (3 s moves, 5 s pending rows); scoped refresh; SHACL in a worker.
--           spec/ui-manifest.hs §5.2, §6.6, and §9 here.
-- ADR 0014  Notations draw views: figures are derived, views store only placements. §4, §7, spec/ui-manifest.hs §2.

-- | Helpers of the formal clauses. They are not part of the implementation.
infixr 1 ==>
(==>) :: Bool -> Bool -> Bool
a ==> b = not a || b

sameSet :: Eq a => [a] -> [a] -> Bool
sameSet xs ys = all (`elem` ys) xs && all (`elem` xs) ys

unique :: Eq a => [a] -> Bool
unique xs = length (nub xs) == length xs

-- | The first i >= 1 whose candidate is not taken.
firstFree :: (Int -> String) -> [String] -> String
firstFree candidate taken = candidate (until (\i -> candidate i `notElem` taken) (+ 1) 1)

--------------------------------------------------------------------------------
-- Part I. The model
--------------------------------------------------------------------------------

-- 1. Terms and identity ------------------------------------------------------

-- 1.1 Terms -------------------------------------------------------------------

type Iri = String
type Id = String
type Error = String
data Term = NamedNode Iri | Literal String Iri (Maybe String) (Maybe Direction) | TripleTerm Term Iri Term deriving Eq
data Direction = Ltr | Rtl deriving Eq
data Quad = Quad Term Iri Term Iri deriving Eq   -- subject, predicate, object, graph
data Side = Top | Right | Bottom | Left deriving Eq

subjectOf, objectOf :: Quad -> Term
subjectOf (Quad s _ _ _) = s
objectOf (Quad _ _ o _) = o
predicateOf, graphOf :: Quad -> Iri
predicateOf (Quad _ p _ _) = p
graphOf (Quad _ _ _ g) = g

-- 1.2 No blank nodes ------------------------------------------------------------

-- | A read replaces each blank node by urn:skolem:<uuid> (skolem.ts). After the read every node is an IRI.
-- Do not add code that keeps, handles or writes back blank nodes. Term has no blank-node constructor for this reason.
-- A file with blank nodes gets the IRIs at its next write. A file that Catenary does not write stays as it is.
-- SHACL paths are decided by structure (path operators, lists), not by term type (patches/shacl-engine@1.1.2.patch).
-- fresh: a new urn:skolem:<uuid> for each blank-node label of one read. One label gives one IRI in the whole read.
data ParsedTerm = Ground Term | Blank String
data ParsedQuad = ParsedQuad ParsedTerm Iri ParsedTerm Iri
skolemPrefix :: Iri
skolemPrefix = "urn:skolem:"
skolemize :: (String -> Iri) -> [ParsedQuad] -> [Quad]
skolemize fresh = map quad
  where
    quad (ParsedQuad s p o g) = Quad (term s) p (term o) g
    term (Ground t) = t
    term (Blank label) = NamedNode (fresh label)

-- | Owned nested resource: a skolem IRI, or a shape part <owner>-…, with no other referrer. It joins copy and deletion of
-- its owner. Three rules disagree in the code (open.md OWN1), so this stays a primitive.
ownedBy :: Iri -> Tx [Iri]

-- 1.3 Element IDs ---------------------------------------------------------------

-- | Element IDs encode terms, not labels. Characters other than [A-Za-z0-9] are escaped as _xx: the UTF-8 bytes in lowercase hex.
-- An IRI ID is n-<escaped IRI>. A relation ID encodes its triple. Exact code: packages/model/src/ids.ts, packages/rdf/src/ids.ts.
-- An IRI change changes the ID. The snapshot field movedIds lets selection and editors follow the change (§11.2).
-- Property-shape IRIs stay stable through path and range edits. Renaming an owner does not rename nested resource IRIs.
escapeId :: String -> String
escapeId = concatMap escapeChar
  where
    escapeChar c
      | isAsciiLower c || isAsciiUpper c || isDigit c = [c]
      | otherwise = concatMap (('_' :) . hex2) (utf8 c)
    hex2 n = [hexDigit (n `div` 16), hexDigit (n `mod` 16)]
    hexDigit i = "0123456789abcdef" !! i
utf8 :: Char -> [Int]                -- the UTF-8 bytes of a character
unescapeId :: String -> Maybe String -- the inverse of escapeId; Nothing for a malformed text

elementId :: Iri -> Id
elementId i = "n-" ++ escapeId i
relationId :: Iri -> Iri -> Iri -> Id
relationId s p o = "r-" ++ escapeId s ++ "-" ++ escapeId p ++ "-" ++ escapeId o
-- | A property shape: its node shape, its path (SPARQL path text, full IRIs) and its range key. n > 1: the n-th with that key.
propertyShapeId :: Iri -> String -> String -> Int -> Id
propertyShapeId s path range n = "p-" ++ escapeId s ++ "-" ++ escapeId path ++ "-" ++ escapeId range ++ suffix
  where suffix = if n > 1 then "-" ++ show n else ""
-- | A logical constraint: the n-th constraint of that operator (or, xone, and, not) on node shape s.
constraintId :: String -> Iri -> Int -> Id
constraintId op s n = "c-" ++ op ++ "-" ++ escapeId s ++ "-" ++ show n
idIri :: Id -> Maybe Iri
idIri ('n' : '-' : rest) = unescapeId rest
idIri _ = Nothing

law_escapeRoundTrip :: String -> Bool
law_escapeRoundTrip s = unescapeId (escapeId s) == Just s
law_elementIdRoundTrip :: Iri -> Bool
law_elementIdRoundTrip i = not (null i) ==> idIri (elementId i) == Just i
law_elementIdInjective :: Iri -> Iri -> Bool
law_elementIdInjective a b = (elementId a == elementId b) == (a == b)
-- | IDs are safe as DOM IDs and in URI paths. "-" separates the parts of a relation ID: escapeId never writes it.
law_idAlphabet :: Iri -> Bool
law_idAlphabet i = all (\c -> isAsciiLower c || isAsciiUpper c || isDigit c || c == '_') (escapeId i)

-- 2. Workspace and files -----------------------------------------------------

-- 2.1 Workspace file ------------------------------------------------------------

-- | Code (packages/rdf/src): settings.ts holds the manifest, file membership and the imported globs; loader.ts reads files into
-- their graphs; placement.ts gives new statements their file. None imports another; ModelStore creates the store and wires them.
-- | A workspace is a folder of RDF files. The files are the source of truth (ADR 0003). Files have no roles (ADR 0004).
-- The optional TriG workspace file holds one graph, urn:name:workspace, in namespace osg://vocab/workspace#.
-- A workspace file with other graphs does not open.
-- Relative paths resolve against the folder of the workspace file. Writers use / separators on all platforms.
data WorkspaceFile = WorkspaceFile
  { settings :: WorkspaceSettings
  , prefixes :: [(String, Iri)]                  -- sh:declare / sh:prefix / sh:namespace; setPrefixes
  }
-- | The settings that setSettings replaces. TypeScript: WorkspaceSettings in modeler/src/common/protocol.ts.
data WorkspaceSettings = WorkspaceSettings
  { defaultFile :: Maybe FilePath                -- ws:defaultFile
  , placement :: Placement
  , exclude :: [String]                          -- ws:exclude globs
  , imported :: [String]                         -- ws:imported globs (§2.6)
  , validation :: ValidationMode                 -- ws:validation (§9)
  }
workspaceGraph, workspaceNamespace :: Iri
workspaceGraph = "urn:name:workspace"
workspaceNamespace = "osg://vocab/workspace#"
workspaceFileOpens :: [Iri] -> Bool             -- the graph names of the workspace file
workspaceFileOpens graphs = all (== workspaceGraph) graphs
law_writerSeparators :: FilePath -> Bool        -- a path that a writer stores
law_writerSeparators p = '\\' `notElem` storedPath p
storedPath :: FilePath -> FilePath              -- the relative path that a writer puts into the workspace file

-- 2.2 Open and create -----------------------------------------------------------

-- | Open a folder: use workspace.trig, else its only workspace file. Several candidates require an explicit choice.
-- No workspace file: use default settings. The window asks the placement once. Create writes workspace.trig.
-- Otherwise the first settings change writes the workspace file.
-- Reject a view file (*.view.trig): it is part of a workspace. The window opens it in its view editor.
data OpenChoice = UseWorkspaceFile FilePath | UseDefaults | AskWhichFile [FilePath] | RejectViewFile deriving Eq
openChoice :: FilePath -> [FilePath] -> OpenChoice   -- the opened path, the workspace-file names in its folder
openChoice opened candidates
  | isViewFile opened = RejectViewFile
  | "workspace.trig" `elem` candidates = UseWorkspaceFile "workspace.trig"
  | [only] <- candidates = UseWorkspaceFile only
  | null candidates = UseDefaults
  | otherwise = AskWhichFile candidates

-- | Create: ask the placement, then write the workspace file, an empty file for each file of the placement,
-- and views/main.view.trig with the view Main. Existing file content stays.
-- Proposed placement: <name>.shapes.ttl, <name>.skos.ttl, all other subjects near.
proposedPlacement :: String -> Placement
proposedPlacement name = Placement
  { shapes = Just (File (name ++ ".shapes.ttl")), concepts = Just (File (name ++ ".skos.ttl")), instances = Just Near }
createdFiles :: Placement -> [FilePath]
createdFiles p = "workspace.trig" : "views/main.view.trig" : [f | Just (File f) <- [shapes p, concepts p, instances p]]
open :: FilePath -> IO CommandResult
open path = runOp (Open path)
create :: FilePath -> Maybe Placement -> IO CommandResult
create path p = runOp (Create path p)

-- 2.3 Membership and formats ----------------------------------------------------

-- | Membership: supported RDF files of the folder and its subfolders. Not: hidden entries, *.bak, node_modules,
-- other workspace files, ws:exclude matches. A subfolder with its own workspace file is a nested workspace, outside this one.
-- A .json file needs @context. Automatic discovery excludes .xml.
-- Read and write: Turtle, TriG, N-Triples, N-Quads, JSON-LD. Read only: N3, RDF/XML.
-- Exact extensions and media types: packages/rdf-files/src/formats.ts, RDF_FORMATS.
-- Relative IRIs resolve against the URI of each source file. An unreadable file gives a warning, not invented content.
data Format = Turtle | TriG | NTriples | NQuads | JsonLd | N3 | RdfXml deriving (Eq, Enum, Bounded)
formatOf :: FilePath -> Maybe Format            -- by extension, RDF_FORMATS
writable :: Format -> Bool
writable f = f `notElem` [N3, RdfXml]
data Entry = Entry
  { entryPath :: FilePath                        -- relative to the workspace folder, / separators
  , isOtherWorkspaceFile :: Bool
  , inNestedWorkspace :: Bool                    -- below a subfolder with its own workspace file
  , hasJsonContext :: Bool                       -- the JSON text has @context
  }
segments :: FilePath -> [String]                -- the path split at /
globMatches :: String -> FilePath -> Bool
isMember :: [String] -> Entry -> Bool            -- ws:exclude, a folder entry
isMember excludes e =
  isJust (formatOf p) && not (".xml" `isSuffixOf` lower p)
    && not (any ("." `isPrefixOf`) (segments p)) && not (".bak" `isSuffixOf` lower p) && "node_modules" `notElem` segments p
    && not (isOtherWorkspaceFile e) && not (inNestedWorkspace e) && not (any (`globMatches` p) excludes)
    && (".json" `isSuffixOf` lower p ==> hasJsonContext e)
  where p = entryPath e
lower :: String -> String
lower = map toLower
modelFiles :: FilePath -> IO [FilePath]
-- modelFiles folder = the paths of the entries e below folder with isMember (exclude settings) e, except view files.

-- | A view file is a TriG file in any folder, with any name, that declares a view:View; a *.view.trig file is one too (ADR 0011).
-- The read finds the views of a file with a SPARQL query on its quads: the file name does not decide, the content does.
-- It has one named graph G and no statements outside G. G is the view IRI and the only view:View of the file.
-- Reject other view files, a view:View in a file that is not TriG, and duplicate view IRIs.
-- There is no read of the old *.view.ttl format.
-- A new view uses its createView file: a new TriG path inside the workspace that the user types (any name). duplicateView too.
-- Without a file: a free views/<label>.view.trig path (-2, -3, … when taken), or the createView folder inside the workspace.
-- A rename or IRI change keeps the file path. Deleting a view removes its file at the next write.
fileNameOf :: String -> String                  -- a file name from a label
isViewFile :: FilePath -> Bool                  -- the default name of a view file
isViewFile p = ".view.trig" `isSuffixOf` lower p
isTrig :: FilePath -> Bool
isTrig p = ".trig" `isSuffixOf` lower p
data ViewFileContent = ViewFileContent
  { viewGraphs :: [Iri]                          -- named graphs that hold statements
  , hasDefaultGraphStatements :: Bool
  , viewsDeclared :: [Iri]                       -- subjects with rdf:type view:View (SPARQL, any graph)
  }
-- | The read takes a file as a view file by its content, or by the default name.
readAsView :: FilePath -> ViewFileContent -> Bool
readAsView p c = isViewFile p || not (null (viewsDeclared c))
viewFileValid :: ViewFileContent -> Bool
viewFileValid c = case viewGraphs c of
  [g] -> not (hasDefaultGraphStatements c) && viewsDeclared c == [g]
  _ -> False
-- | A view file that the read accepts is TriG and valid; its name does not matter.
viewFileAccepted :: FilePath -> ViewFileContent -> Bool
viewFileAccepted p c = readAsView p c && isTrig p && viewFileValid c
-- | Across the workspace: a view:View only in its own view file, and each view IRI in one view file only.
law_viewIrisUnique :: [ViewFileContent] -> Bool
law_viewIrisUnique cs = all viewFileValid cs ==> unique (concatMap viewGraphs cs)
-- | A file of a new view: TriG, inside the workspace folder, not a file that exists or that the workspace knows.
newViewFileOk :: FilePath -> [FilePath] -> Bool  -- the file (relative to the workspace folder), taken paths
newViewFileOk f taken = isTrig f && not ("/" `isPrefixOf` f) && ".." `notElem` segments f && f `notElem` taken
newViewPath :: String -> Maybe FilePath -> Maybe FilePath -> [FilePath] -> FilePath   -- label, createView folder, createView file, taken
newViewPath label folder file taken = fromMaybe (firstFree candidate taken) file
  where
    dir = fromMaybe "views" folder
    candidate i = dir ++ "/" ++ fileNameOf label ++ (if i == 1 then "" else "-" ++ show i) ++ ".view.trig"
-- | The given file wins over the folder and the label.
law_newViewFileWins :: String -> Maybe FilePath -> FilePath -> [FilePath] -> Bool
law_newViewFileWins label folder f taken = newViewFileOk f taken ==> newViewPath label folder (Just f) taken == f

-- 2.4 Placement of new subjects -------------------------------------------------

-- | Placement of new subjects, by kind: shapes, SKOS resources, all other subjects (instances).
-- The workspace file stores "near" or a relative path for each kind (ws:placeShapes, ws:placeConcepts, ws:placeInstances).
-- Writers store every kind explicitly.
-- A kind without a value: with ws:defaultFile, shapes use that file and the other kinds are near. Without it, all are near.
-- The legacy value "default" means ws:defaultFile, or near without one.
data Place = File FilePath | Near | LegacyDefault deriving Eq
data Placement = Placement { shapes, concepts, instances :: Maybe Place }
data SubjectKind = ShapeSubject | ConceptSubject | InstanceSubject deriving Eq
placeOf :: SubjectKind -> Placement -> Maybe Place
placeOf ShapeSubject = shapes
placeOf ConceptSubject = concepts
placeOf InstanceSubject = instances
effectivePlace :: WorkspaceSettings -> SubjectKind -> Place
effectivePlace ws k = case placeOf k (placement ws) of
  Just LegacyDefault -> maybe Near File (defaultFile ws)
  Just p -> p
  Nothing -> case (k, defaultFile ws) of
    (ShapeSubject, Just f) -> File f
    _ -> Near
law_writersStoreEveryKind :: Placement -> Bool   -- a placement that a writer stores
law_writersStoreEveryKind p = all (\k -> maybe False (/= LegacyDefault) (placeOf k p)) [ShapeSubject, ConceptSubject, InstanceSubject]

-- | Near shapes: the writable file with most node shapes. Near concepts: the file of their scheme or collection.
-- Near instances: the file with most subjects of their classes. Otherwise: the default file.
-- Default file: ws:defaultFile when set. Else a nonempty writable model file that is not the shapes or SKOS file,
-- Turtle first, then path order. Else <workspace name>.ttl. The settings view shows it but does not edit ws:defaultFile.
subjectKind :: Iri -> Tx SubjectKind
nearFile :: SubjectKind -> Iri -> Tx (Maybe FilePath)
fileForNew :: WorkspaceSettings -> Iri -> Tx FilePath
fileForNew ws s = do
  k <- subjectKind s
  case effectivePlace ws k of
    File f -> pure f
    _ -> nearFile k s >>= maybe (defaultFileTx ws) pure
data FileFacts = FileFacts { factPath :: FilePath, factFormat :: Format, factEmpty :: Bool, factShapesOrSkos :: Bool }
defaultFileChoice :: WorkspaceSettings -> String -> [FileFacts] -> FilePath   -- settings, workspace name, model files
defaultFileChoice ws name fs = fromMaybe (name ++ ".ttl") (defaultFile ws <|> listToMaybe (map factPath (sortOn rank candidates)))
  where
    candidates = [f | f <- fs, writable (factFormat f), not (factEmpty f), not (factShapesOrSkos f)]
    rank f = (factFormat f /= Turtle, factPath f)
defaultFileTx :: WorkspaceSettings -> Tx FilePath   -- defaultFileChoice on the current files

-- | A file transfer moves only selected statements supplied by its source file. Other origins and IRIs stay unchanged.
-- Reason: dragging from one file must not change another file's definitions.
-- Transfers require two writable model data files. A same-file transfer changes nothing.
-- Structural shape nodes move with their parent. Reject a transfer that leaves a structural parent in the source file.
transferOrigins :: FilePath -> FilePath -> [FilePath] -> [FilePath]
transferOrigins source destination origins
  | source == destination || source `notElem` origins = origins
  | otherwise = nub (destination : filter (/= source) origins)
law_fileTransferOrigins :: FilePath -> FilePath -> [FilePath] -> Bool
law_fileTransferOrigins source destination origins =
  all (\f -> f == source || f == destination || (f `elem` origins) == (f `elem` after)) (origins ++ after)
  where after = transferOrigins source destination origins

-- 2.5 Settings and prefixes -------------------------------------------------------

-- | Prefixes: one table per backend, from the workspace file. Prefix declarations in model files do not fill it.
-- No declarations: use defaults without a rewrite of the workspace file. Reject two prefixes for one namespace.
-- Settings, prefixes and migration dismissal are not undo steps (law_settingsNoUndo, §5.2).
-- A change of exclusions reloads membership. Person preferences are not part of this contract.
validPrefixes :: [(String, Iri)] -> Bool
validPrefixes = unique . map snd
setSettings :: WorkspaceSettings -> IO CommandResult
setSettings s = runOp (SetSettings s)
setPrefixes :: [(String, Iri)] -> IO CommandResult
setPrefixes ps = runOp (SetPrefixes ps)
law_prefixesRejected :: Backend -> [(String, Iri)] -> Bool
law_prefixesRejected b ps = failed (fst (step b (SetPrefixes ps))) == not (validPrefixes ps)

-- 2.6 Imported files and import ------------------------------------------------------

-- | A ws:imported glob marks the model files and view files that it matches as imported. An imported file is read only:
-- Catenary reads it and does not change it. Files that no glob matches are own files.
-- Reason: an official file stays as published, and own additions stay in own files.
-- A command, an undo or a redo that changes an imported file fails as a whole. The failure names the files.
-- A new statement about an imported subject goes to the default file (§3.2: an imported file is a read-only file).
-- An imported file is not a file of new subjects. Marking such a file sets its kind to near and clears ws:defaultFile.
-- Validation reads only the part of imported files that own statements need (§9).
-- Mark as Imported writes the pending changes first. It refuses a file that keeps blank nodes on disk: their IRIs change at each read.
-- Mark as Own removes the globs equal to the path. A file that another glob matches stays imported, and the error names the glob.
-- When a change fails on imported files, the window asks to mark them as own. After Mark as Own, it runs the change again.
isImported :: [String] -> FilePath -> Bool        -- ws:imported globs, a path relative to the workspace folder
isImported globs p = any (`globMatches` p) globs
-- | The legacy name ws:protect reads as ws:imported. Writers store ws:imported only.
importedGlobsRead :: [String] -> [String] -> [String]   -- the values of ws:imported, the values of ws:protect
importedGlobsRead imported legacy = sort (nub (imported ++ legacy))
importedFiles :: Backend -> [FilePath]
fileStatements :: Backend -> FilePath -> [Quad]   -- the statements of one file in the store (Workspace.filesOfQuad)
law_importedUnchanged :: Backend -> Op -> Bool
law_importedUnchanged b op =
  let (r, b') = step b op
  in (changesStatements op && not (failed r)) ==> all (\f -> sameSet (fileStatements b' f) (fileStatements b f)) (importedFiles b)
  where
    changesStatements (Execute _) = True
    changesStatements Undo = True
    changesStatements Redo = True
    changesStatements _ = False
setImported :: FilePath -> Bool -> IO CommandResult   -- True: Mark as Imported; False: Mark as Own
setImported p on = runOp (SetImported p on)

-- | Import marks a model file or view file of the workspace as imported where it is (no copy): the intent is to import that file.
-- It copies another RDF file to imported/<name>.ttl (-2, -3, … when taken) and marks the copy as imported.
-- One import takes one or more files, all or none: a file that cannot be read imports nothing. With copies, the workspace is read again once.
data ImportAction = MarkInPlace FilePath | CopyTo FilePath deriving Eq
importAction :: [FilePath] -> [FilePath] -> String -> FilePath -> ImportAction   -- workspace files, taken paths, name, source
importAction workspaceFiles taken name source
  | source `elem` workspaceFiles = MarkInPlace source
  | otherwise = CopyTo (importPath name taken)
-- The copy is Turtle in the default graph, with an IRI for each blank node (§1, skolemize). A file without statements is refused.
-- A prefix of the source joins the workspace table when the table has neither its name nor its namespace with another value.
-- The other prefixes stay out, with a warning. Then the workspace is read again, so the history is empty (§10.4).
importPath :: String -> [FilePath] -> FilePath    -- the source name without extension, the taken paths
importPath name taken = firstFree candidate taken
  where candidate i = "imported/" ++ name ++ (if i == 1 then "" else "-" ++ show i) ++ ".ttl"
importPrefixes :: [(String, Iri)] -> [(String, Iri)] -> ([(String, Iri)], [String])   -- table, declared: new table, skipped
importPrefixes table = foldl add (table, [])
  where
    add (t, skipped) (p, ns)
      | lookup p t == Just ns = (t, skipped)
      | null p || isJust (lookup p t) || ns `elem` map snd t = (t, skipped ++ [p])
      | otherwise = (t ++ [(p, ns)], skipped)
law_importPrefixesValid :: [(String, Iri)] -> [(String, Iri)] -> Bool
law_importPrefixesValid t declared = validPrefixes t ==> validPrefixes (fst (importPrefixes t declared))
importFiles :: [FilePath] -> IO CommandResult
importFiles ps = runOp (ImportFiles ps)

-- 3. Store -------------------------------------------------------------------

-- 3.1 Graphs --------------------------------------------------------------------

-- | One backend ModelStore indexes one workspace in an in-memory Oxigraph store. All windows share it and its history.
-- No lock or merge protocol protects simultaneous clients.
-- The store is local and synchronous: an edit reads its own writes before its transaction ends.
-- Graphs, from Loader.mount (loader.ts). The workspace file stays in workspace metadata, outside the read models.
-- Preserve legacy Trellis IRIs because saved view placements use urn:trellis:list:*, and existing files use osg://vocab/trellis-* terms.
-- Model-file reads preserve SPO statements and source-file provenance, not source graph names (SPOG).
-- Source graphs merge because Catenary assigns graphs by file and statement kind. View files retain their required view graph IRI.
-- A write need not restore source graph names. Do not claim graph-preserving TriG or N-Quads round trips.
sourceTriples :: [(s, p, o, g)] -> [(s, p, o)]
sourceTriples = map (\(s, p, o, _) -> (s, p, o))
law_sourceTriplesPreserved :: (Eq s, Eq p, Eq o) => [(s, p, o, g)] -> Bool
law_sourceTriplesPreserved qs = all (\(s, p, o, _) -> (s, p, o) `elem` sourceTriples qs) qs
data GraphName
  = ViewGraph Iri          -- the statements of one view file
  | FileGraph FilePath     -- shape subjects and their nested nodes, per source file
  | DataGraph FilePath     -- other statements, per source file
  | ModelGraph             -- the logical union of data graphs, never a stored workspace graph
  | ValidationGraph        -- the SHACL report (§9)
  deriving Eq
graphIri :: GraphName -> Iri
graphIri (ViewGraph v) = v
graphIri (FileGraph f) = "urn:shapes:" ++ encodePath f
graphIri (DataGraph f) = "urn:data:" ++ encodePath f
graphIri ModelGraph = "urn:name:model"
graphIri ValidationGraph = "urn:trellis:validation"
encodePath :: FilePath -> String
data SourceStatement = InViewFile Iri | ShapeStatement | OtherStatement   -- what a read finds in a file
mountGraph :: FilePath -> SourceStatement -> GraphName
mountGraph _ (InViewFile v) = ViewGraph v
mountGraph f ShapeStatement = FileGraph f
mountGraph f OtherStatement = DataGraph f
law_readOwnWrites :: Backend -> Quad -> Bool
law_readOwnWrites b q = q `elem` storeQuads (snd (runTx b (addQuad q >> pure ())))
addQuad :: Quad -> Tx ()

-- | Data reads use the union of file data graphs with duplicate triples removed. Views keep their saved IRIs.
-- Reason: the graph records each file copy while readers see one statement.
law_fileRoleGraphs :: FilePath -> Bool
law_fileRoleGraphs f = graphIri (DataGraph f) /= graphIri (FileGraph f)
dataGraphNames :: Backend -> [Iri]
modelStatements :: Backend -> [Quad]
modelStatements b = nub [Quad s p o (graphIri ModelGraph) | Quad s p o g <- storeQuads b, g `elem` dataGraphNames b]

-- 3.2 Statement origin ------------------------------------------------------------

-- | Statement origin: existing triples keep their files. An addition prefers its prior origin, then the file of its subject,
-- then the file of a referring statement. A preferred read-only file gives the default file. Imported files are read only (§2.6).
-- A deletion from a read-only file cannot persist. IRI replacement and undo keep statement origins.
-- Placement assigns final file graphs inside the transaction. Transfers and replay need only quad patches.
-- The store has no separate origin map. A statement held by two files has one quad in each file data graph.
-- Reason: file graph patches preserve ownership through undo without a separate history.
origin :: Quad -> Tx [FilePath]
priorOrigin, subjectFile, referrerFile :: Quad -> Tx (Maybe FilePath)
readOnlyFile :: FilePath -> Tx Bool
currentSettings :: Tx WorkspaceSettings
fileForAdd :: Quad -> Tx FilePath
fileForAdd q = do
  prior <- priorOrigin q
  subj <- subjectFile q
  ref <- referrerFile q
  ws <- currentSettings
  case prior <|> subj <|> ref of
    Just f -> readOnlyFile f >>= \ro -> if ro then defaultFileTx ws else pure f
    Nothing -> defaultFileTx ws
law_originKept :: Backend -> EditCommand -> Quad -> Bool   -- a statement present before and after keeps its files
law_originKept b c q =
  let b' = snd (step b (Execute c))
  in (q `elem` storeQuads b && q `elem` storeQuads b') ==> sameSet (originIn b q) (originIn b' q)
law_undoKeepsOrigin :: Backend -> EditCommand -> Quad -> Bool
law_undoKeepsOrigin b c q =
  let b'' = snd (step (snd (step b (Execute c))) Undo)
  in q `elem` storeQuads b ==> sameSet (originIn b q) (originIn b'' q)
originIn :: Backend -> Quad -> [FilePath]
originIn b q = fst (runTx b (origin q))

-- 3.3 Read models -----------------------------------------------------------------

-- | A view placement does not change SHACL target data. Cache focus-node RDF datasets under a source-data revision, not the figure input revision.
-- A model or shapes statement changes that revision. A view declaration changes graph classification and must also invalidate the graph scope.
-- Reason: a layout or membership edit must not repeat the checked-node walk for an unchanged instance.
targetDataRevision :: GraphName -> Bool
targetDataRevision (DataGraph _) = True
targetDataRevision ModelGraph = True
targetDataRevision (FileGraph _) = True
targetDataRevision _ = False
law_viewPlacementKeepsTargetData :: Iri -> Bool
law_viewPlacementKeepsTargetData v = not (targetDataRevision (ViewGraph v))

-- | Read models (ADR 0012). There is no Doc of the whole dataset. Panels and editors build request-local display models.
-- A request-scoped Doc holds the elements of one request, their neighbors when asked, and the views that can show them.
-- The other views of a scoped Doc have their label only. A scoped Doc is not kept after its request.
-- A selected-element request reads only its selected elements and required dependencies. Placement IDs do not require a full view read.
-- Reason: unrelated card statements block selection requests on the backend event loop.
law_selectedReadScope :: [Id] -> [Id] -> Bool       -- required elements, read elements
law_selectedReadScope required readElements = all (`elem` required) readElements

-- | The figures of a view start from its placed terms (and the terms that an edit removes or pastes): the placed figures, the lines
-- and hubs whose role paths reach them or reach such a line, their role values, and the role values of those (an end's title, an
-- inline list's parts), no further. A placed list term finds its list head (rule 12), kept between derivations. A placement of a
-- term that is not an IRI or a statement between IRIs has no figure. They read the store around these terms only. For what the view shows, and for removal, arrival and data arrival,
-- they equal the figures of the whole workspace (notation-engine.test.ts). The order of the figures is the cascade, then the focus.
-- Reason: figures of the whole workspace made each edit and each canvas read cost seconds in a large workspace.
law_scopedFiguresPreservePlacementRules :: [Id] -> [Id] -> Bool
law_scopedFiguresPreservePlacementRules full scoped = sameSet full scoped
-- Unmapped RDF statements stay in the store and the files.
-- ViewCard.id is the placement. ViewCard.element is its element. EdgeLayout.id is a connector placement when present.
-- Marks, references and arrows use placement IDs. Arrow ends are box IDs, not element IDs.
-- Exceptions with element IDs: unplaced links, property lines, private pills, list boxes and logical constraints.
-- Diagram IDs of SHACL and value-set figures: packages/model/src/notation-schema.ts.
-- The cascade order decides the figure of an element. The default cascade puts SHACL before instances,
-- so a node-shape card wins display over an instance with the same IRI. Action facts use all types.
-- Exact schemas: packages/model/src/doc.ts, snapshot.ts, terms.ts, shapes-doc.ts.
data Doc
docElements :: Doc -> [Id]                       -- the instances of a Doc
docViews :: Doc -> [Id]                          -- the views of a Doc, also those with a label only
-- | One view read takes its view graph and the relevant model statements by SPARQL (view-read.ts), not a cloned store.
-- A GLSP session refreshes only when the change scope touches its view (refreshes, §11.2).
-- A class target resolves to the first visible matching node shape by ID. Rendering and layout share this rule.
-- Parallel-edge lanes count unordered end pairs and allocate in drawing order.
-- A new field goes through RDF operations, read model, JSON schema and client model together. GLSP field copy has no type check.
viewDoc :: Iri -> IO Doc
classTarget :: [Id] -> Maybe Id   -- the visible node shapes that target the class
classTarget ids = listToMaybe (sort ids)
law_readsChangeNothing :: Backend -> Iri -> Bool
law_readsChangeNothing b v = storeQuads (snd (runRead b (viewDoc v))) == storeQuads b
runRead :: Backend -> IO a -> (a, Backend)

-- 4. Views in RDF ------------------------------------------------------------

-- 4.1 Notations and placements ----------------------------------------------------

-- | A view stores its Markdown Notes as one view:description literal in its own graph.
-- Absence means empty text. An empty edit removes the literal. Keeping the predicate preserves existing notes.
viewDescriptionQuads :: Iri -> String -> [Quad]
viewDescriptionQuads v text = [Quad (NamedNode v) "view:description" (Literal text "xsd:string" Nothing Nothing) v | not (null text)]
law_viewDescriptionStorage :: Iri -> String -> Bool
law_viewDescriptionStorage v text = all (\q -> subjectOf q == NamedNode v && graphOf q == v) (viewDescriptionQuads v text)

-- | A view places elements and statements. Its notations give their figures (ADR 0014, spec/ui-manifest.hs §2.3).
--   v nt:notations ( n1 n2 … )                           the cascade of the view; absent: the default cascade (nt:default)
-- Notations are built into Catenary (packages/rdf/notations/). A workspace file does not define a notation.
-- A view names notations by IRI. Vocabulary and SHACL of the notation model: docs/notation/.
-- A placement holds geometry, color and display. A mark holds its own content. A view reference places the target view.
--   p view:element e ; view:view v                       an element: a box, a line (a property shape) or a hub (an RDF list)
--   p rdf:reifies <<( s p o )>> ; view:view v            a link (a triple); it does not assert the triple in the view graph
-- A Box placement has view:x, view:y, view:width, view:height and optional view:color and view:display "simple".
-- view:keptByLines true: a line or hub brought the box (⇥); the box leaves with its last line. Absent: the user placed it.
-- A datatype, node-kind or "any" pill has no placement: it is private to its line (ADR 0014).
-- A Line placement has no geometry: a read ignores it. view:fromSide and view:toSide are routing hints.
-- A Hub placement has an optional position. Without it, the layout computes one.
cascadeOf :: Maybe [Iri] -> [Iri]                -- nt:notations of a view
cascadeOf = fromMaybe ["nt:default"]
data PlacedKind = BoxPlacement | LinePlacement | HubPlacement deriving Eq
data PlacementRecord = PlacementRecord
  { placementId :: Iri
  , placementView :: Iri
  , placed :: Term                               -- view:element e, or rdf:reifies <<( s p o )>>
  , placedKind :: PlacedKind
  , bounds :: Maybe (Double, Double, Double, Double)   -- view:x, view:y, view:width, view:height
  , display :: Maybe String                      -- view:display; only "simple" is written
  , keptByLinesFlag :: Bool                      -- view:keptByLines true
  }
law_boxHasBounds :: PlacementRecord -> Bool      -- a placement that a write produces
law_boxHasBounds p = placedKind p == BoxPlacement ==> isJust (bounds p)
law_displayValues :: PlacementRecord -> Bool
law_displayValues p = maybe True (== "simple") (display p)
-- | Catenary code checks the rules that SHACL Core cannot: one placement per term, no geometry on a line placement,
-- and a placement without a figure (a project warning in Problems, open.md NOTATION2).
law_onePlacementPerTerm :: [PlacementRecord] -> Bool   -- the placements of one view
law_onePlacementPerTerm ps = unique (map placed ps)
law_noLineGeometry :: PlacementRecord -> Bool
law_noLineGeometry p = placedKind p == LinePlacement ==> isNothing (bounds p)
-- | Figures are derived in memory for each view read, like urn:trellis:validation. They are never written.
-- A placement never names a list cell: commands rewrite list cells.

-- 4.2 Derived IRIs ----------------------------------------------------------------

-- | A view places an element or a triple at most once. Placement IRI: <view>/p/<12 hex of SHA-256 of the placed term>.
-- Mark IRI: <view>/m/<6 random base-36 characters>.
-- A hub, a "one of" box and an "in" box are placed by urn:trellis:list:<12 hex of SHA-256 of "<holder> <predicate> <n>">.
-- n: the position of the list among the lists of that holder and predicate, sorted by member text.
-- These are the inputs of the constraint id c-<operator>-<shape>-<n> (constraintId, §1.3).
-- An IRI change of a view, an element or a triple end renames the placements and marks that derive from it.
sha256Hex :: String -> String
termKey :: Term -> String                        -- the canonical text of a term (terms.ts)
placementIri :: Iri -> Term -> Iri
placementIri v t = v ++ "/p/" ++ take 12 (sha256Hex (termKey t))
markIri :: Iri -> IO Iri
markIri v = fmap (\s -> v ++ "/m/" ++ s) (randomBase36 6)
randomBase36 :: Int -> IO String
listIri :: Iri -> Iri -> Int -> Iri               -- holder, predicate, n
listIri holder p n = "urn:trellis:list:" ++ take 12 (sha256Hex (holder ++ " " ++ p ++ " " ++ show n))
law_placementIriDerived :: PlacementRecord -> Bool
law_placementIriDerived p = placementId p == placementIri (placementView p) (placed p)
-- | The placements and marks of a view IRI v are below v: an IRI change of v renames them.
law_viewPartsBelowView :: Iri -> Term -> Bool
law_viewPartsBelowView v t = (v ++ "/p/") `isPrefixOf` placementIri v t

-- 4.3 Links and arrows ------------------------------------------------------------

-- | Links: relations and arrows. Arrival and data arrival place links (§7).
-- Removing a link placement keeps the Domain triple. An arrival places it again only when the link touches an arriving figure.
-- A link to an entity-group member ends at the group (nt:linkEnd). The group draws the relations of its members as bundles,
-- without statement placements: a member relation is never hidden.
-- Arrows: view:arrow statements in Project data. At least one end is a note. Duplicate arrows are invalid.
-- An arrow placement goes when the view no longer shows an end, as a box or as a member of a shown entity group (pruneArrows).
data Arrow = Arrow { arrowFrom, arrowTo :: Iri } deriving Eq
isNote :: Iri -> Bool
law_arrowsValid :: [Arrow] -> Bool
law_arrowsValid arrows = unique arrows && all (\a -> isNote (arrowFrom a) || isNote (arrowTo a)) arrows
law_removeLinkKeepsTriple :: Backend -> Iri -> Iri -> Quad -> Bool   -- view, link placement, the linked triple
law_removeLinkKeepsTriple b v p q =
  q `elem` storeQuads b ==> q `elem` storeQuads (snd (step b (Execute (RemoveFromView (elementId v) [elementId p]))))

--------------------------------------------------------------------------------
-- Part II. Edits
--------------------------------------------------------------------------------

-- 5. Transactions and history ------------------------------------------------

-- 5.1 Operations and results ------------------------------------------------------

-- | The backend is a state machine. Each RPC write is one Op. step gives its result and the next state.
-- Variants and fields: packages/model/src/commands.ts. Dispatch and effects: packages/rdf/src/commands.ts.
data Change = Add Quad | Remove Quad deriving Eq
type Patch = [Change]
data Tx a
data Backend
data CommandResult = Success (Maybe Id) [Id] | Failure Error
data Op
  = Open FilePath | Create FilePath (Maybe Placement) | Execute EditCommand | Undo | Redo | Save
  | SetSettings WorkspaceSettings | SetPrefixes [(String, Iri)] | DismissMigration Id
  | SetImported FilePath Bool | ImportFiles [FilePath]
  | DiskChange [FilePath]                         -- the watcher (§10.4), not an RPC
step :: Backend -> Op -> (CommandResult, Backend)
runOp :: Op -> IO CommandResult                    -- step on the backend of this process
runTx :: Backend -> Tx a -> (a, Backend)
transact :: Tx (Either Error a) -> IO (Either Error a, Patch)
execute :: EditCommand -> IO CommandResult
execute c = runOp (Execute c)
undo, redo :: IO ()
undo = () <$ runOp Undo
redo = () <$ runOp Redo
failed :: CommandResult -> Bool
failed (Failure _) = True
failed (Success _ _) = False
storeQuads :: Backend -> [Quad]                    -- all graphs
historyOf :: Backend -> History
filesOf :: Backend -> [FilePath]                   -- the model and view files of the workspace
lastPatch :: Backend -> Patch                      -- the patch of the last Op

-- 5.2 One command, one patch, one undo step ------------------------------------------

-- | Each committed nonempty patch gives one change event with its graphs and elements. Rejected transactions give no event.
-- Loads, unloads, edits, replay and reports use this patch path. Only edit patches enter history and file tracking.
-- Reason: one event gives each cache the same change scope. Report patches remain outside undo, dirty state and writes.
patchQuad :: Change -> Quad
patchQuad (Add q) = q
patchQuad (Remove q) = q
patchGraphs :: Patch -> [Iri]
patchGraphs p = nub [graphOf (patchQuad c) | c <- p]
patchElements :: Patch -> [Iri]
patchElements p = nub [i | c <- p, t <- [subjectOf (patchQuad c), objectOf (patchQuad c)], NamedNode i <- [t]]
law_patchEventScope :: Patch -> [Iri] -> [Iri] -> Bool
law_patchEventScope p graphs elements = sameSet graphs (patchGraphs p) && sameSet elements (patchElements p)

-- | One successful nonempty EditCommand gives one patch and one undo step. A no-op gives no history entry.
-- A rejection or an exception rolls back the store transaction. The store transaction is separate from the async file write.
-- A new edit clears redo. History keeps at most 200 steps. Undo and redo restore the migration queue of their step.
-- A command that names a view rejects a missing view. View commands accept element or placement IDs.
applyChange :: [Quad] -> Change -> [Quad]
applyChange qs (Add q) = if q `elem` qs then qs else qs ++ [q]
applyChange qs (Remove q) = filter (/= q) qs
applyPatch :: Patch -> [Quad] -> [Quad]
applyPatch p qs = foldl applyChange qs p
invert :: Patch -> Patch
invert = reverse . map flipChange
  where
    flipChange (Add q) = Remove q
    flipChange (Remove q) = Add q
-- | A stored patch is effective: each Add adds an absent quad, each Remove removes a present one. So invert undoes it.
effective :: [Quad] -> Patch -> Bool
effective _ [] = True
effective qs (c : cs) = ok c && effective (applyChange qs c) cs
  where
    ok (Add q) = q `notElem` qs
    ok (Remove q) = q `elem` qs
law_invertUndoes :: [Quad] -> Patch -> Bool
law_invertUndoes qs p = effective qs p ==> sameSet (applyPatch (invert p) (applyPatch p qs)) qs

law_rejectionRollsBack :: Backend -> EditCommand -> Bool
law_rejectionRollsBack b c =
  let (r, b') = step b (Execute c) in failed r ==> (storeQuads b' == storeQuads b && historyOf b' == historyOf b)
law_patchIsTheChange :: Backend -> EditCommand -> Bool
law_patchIsTheChange b c =
  let (r, b') = step b (Execute c)
  in not (failed r) ==> (effective (storeQuads b) (lastPatch b') && sameSet (storeQuads b') (applyPatch (lastPatch b') (storeQuads b)))
law_oneUndoStep :: Backend -> EditCommand -> Bool
law_oneUndoStep b c =
  let (r, b') = step b (Execute c)
      h = historyOf b
      h' = historyOf b'
  in not (failed r) ==>
       if null (lastPatch b')
         then undoStack h' == undoStack h
         else map stepPatch (take 1 (undoStack h')) == [lastPatch b'] && null (redoStack h')
               && length (undoStack h') == min historyLimit (length (undoStack h) + 1)
law_undoRestores :: Backend -> EditCommand -> Bool
law_undoRestores b c =
  let (r, b') = step b (Execute c)
  in (not (failed r) && not (null (lastPatch b'))) ==> sameSet (storeQuads (snd (step b' Undo))) (storeQuads b)
law_redoRestores :: Backend -> EditCommand -> Bool
law_redoRestores b c =
  let b' = snd (step b (Execute c))
  in sameSet (storeQuads (snd (step (snd (step b' Undo)) Redo))) (storeQuads b')
-- | Settings, prefixes and migration dismissal are not undo steps.
law_settingsNoUndo :: Backend -> Op -> Bool
law_settingsNoUndo b op = notUndoable op ==> undoStack (historyOf (snd (step b op))) == undoStack (historyOf b)
  where
    notUndoable (SetSettings _) = True
    notUndoable (SetImported _ _) = True
    notUndoable (SetPrefixes _) = True
    notUndoable (DismissMigration _) = True
    notUndoable Save = True
    notUndoable _ = False

-- 5.3 History ---------------------------------------------------------------------------

-- | The history model (packages/rdf/src/history.ts). The head of a stack is its top.
-- A command records its patch, the entry of the migration queue that it applied and the entries that it proposed.
-- A command without a quad patch changes nothing. Undo and redo restore its file graphs and migration queue.
-- A read from disk (open, reload, a watcher change) clears the history (§10.4).
data Migration = Migration { migrationId :: Id, migrationReason :: String } deriving Eq
data Step = Step { stepPatch :: Patch, transferFiles :: [FilePath], queueBefore, queueAfter :: [Migration] } deriving Eq
data History = History { undoStack, redoStack :: [Step], queue :: [Migration] } deriving Eq
historyLimit :: Int
historyLimit = 200
record :: Patch -> Maybe Id -> [Migration] -> History -> History
record p = recordWithFiles p []
recordWithFiles :: Patch -> [FilePath] -> Maybe Id -> [Migration] -> History -> History
recordWithFiles p files applied proposed h
  | null p = h
  | otherwise = h { undoStack = take historyLimit (s : undoStack h), redoStack = [], queue = q }
  where
    q = filter (\m -> Just (migrationId m) /= applied) (queue h) ++ proposed
    s = Step p files (queue h) q
takeUndo, takeRedo :: History -> Maybe (Step, History)
takeUndo h = case undoStack h of
  [] -> Nothing
  s : rest -> Just (s, h { undoStack = rest, redoStack = s : redoStack h, queue = queueBefore s })
takeRedo h = case redoStack h of
  [] -> Nothing
  s : rest -> Just (s, h { redoStack = rest, undoStack = s : undoStack h, queue = queueAfter s })
dismiss :: Id -> History -> Maybe History           -- Nothing: no such entry
dismiss i h
  | any ((== i) . migrationId) (queue h) = Just h { queue = filter ((/= i) . migrationId) (queue h) }
  | otherwise = Nothing
clearHistory :: History
clearHistory = History [] [] []
law_undoThenRedo :: History -> Bool
law_undoThenRedo h = maybe True (\(_, h') -> fmap snd (takeRedo h') == Just h) (takeUndo h)
law_historyBounded :: Patch -> Maybe Id -> [Migration] -> History -> Bool
law_historyBounded p a ms h = length (undoStack h) <= historyLimit ==> length (undoStack (record p a ms h)) <= historyLimit
lastTransferFiles :: Backend -> [FilePath]
law_backendUsesHistory :: Backend -> EditCommand -> Bool
law_backendUsesHistory b c =
  let (r, b') = step b (Execute c)
  in not (failed r) ==> undoStack (historyOf b') == undoStack (recordWithFiles (lastPatch b') (lastTransferFiles b') Nothing [] (historyOf b))

-- 6. Edit commands -----------------------------------------------------------

-- 6.1 Variants --------------------------------------------------------------------------

-- | Every EditCommand kind of packages/model/src/commands.ts, one constructor each. Fields are simplified: Id is an element or
-- placement ID, Point and Rect are canvas coordinates, other field types are named after their TypeScript types.
data Point
data Rect
data NodeShapePatch
data PropertyShapePatch
data PathJSON
data Range
data ViewElementPatch
data EdgeLayoutPatch
data ViewClip
data MigrationChange
data NewEnd = ExistingEnd Id | NewInstanceEnd Iri String   -- an existing element, or a new instance (class, label)
data LogicalOperator = Or | Xone | And | Not deriving Eq
data ValueSetKind = Scheme | Collection deriving Eq
data RelationEnd = SourceEnd | TargetEnd deriving Eq
data EditCommand
  -- resources (§6.2)
  = CreateInstance Iri String (Maybe Id) (Maybe Point)       -- class, label, view, at
  | Rename Id String
  | SetUri Id (Maybe Iri)                                    -- Nothing: mint from the label
  | SetStatements Id [(Iri, [Term])]
  | MoveElementsToFile FilePath FilePath [Id]                -- source, destination, elements
  | Delete [Id]
  | CreateRelation NewEnd Iri NewEnd (Maybe Id)              -- subject, predicate, object, view
  | ReconnectRelation Id RelationEnd Id (Maybe Side)
  -- views (§6.3)
  | CreateView String (Maybe FilePath) (Maybe FilePath)   -- label, folder, file
  | DuplicateView Id (Maybe FilePath)                      -- view, file of the copy (as createView)
  | AddToView Id [Id] Point
  | PlaceExplorerElements Id [Id] Point                     -- mixed cards, properties, relations and views
  | ShowRelations Id [Id] Point
  | ShowAsEdge Id Id Point
  | RemoveFromView Id [Id]
  | CutFromView Id [Id]
  | SetBounds Id [(Id, Rect)]
  | SetLayout Id [(Id, Rect)] [Id]                           -- bounds, connectors whose sides it clears
  | SetEdgeLayout Id Id EdgeLayoutPatch
  | HideEdges Id [Id] Bool
  | SetViewDescription Id String (Maybe String)
  | SetViewElements Id [Id] ViewElementPatch (Maybe String)  -- expectedText of a note edit
  -- marks and entity groups (§6.3)
  | CreateGroup Id String (Maybe [Id]) (Maybe Rect)
  | CreateNote Id String Point
  | AddViewReference Id Id Point
  | AddFileReference Id FilePath Point
  | CreateArrow Id Id Id
  | Collect Id [Id]
  | AddToCollection Id Id [Id]
  | Uncollect Id Id (Maybe [Id])
  | PasteIntoView Id ViewClip (Maybe Point)
  | PasteRdf Id String Bool (Maybe Point)                   -- parsed N-Quads, flatten consent, paste position
  -- shapes and SKOS (§8)
  | CreateNodeShape String (Maybe Iri) (Maybe Id) (Maybe Point)
  | ProposeShapes (Maybe [Iri])
  | SetNodeShape Id NodeShapePatch
  | CreatePropertyShape Id PathJSON Range (Maybe Int) (Maybe Int) (Maybe Id)
  | SetPropertyShape Id PropertyShapePatch (Maybe Id)
  | GroupProperties [Id] (Maybe LogicalOperator)
  | SetConstraint Id LogicalOperator
  | Ungroup Id
  | TakeOutOfConstraint Id
  | CreateValueSet ValueSetKind String (Maybe Id) (Maybe Point)
  | AddConcept Id (Maybe String) (Maybe Iri)
  | SetConceptBroader Iri Iri
  | RemoveConcept Id Iri
  | MigrateData MigrationChange (Maybe Id)
-- | The view that a command names. A command that names a view rejects a missing view.
viewNamed :: EditCommand -> Maybe Id
viewNamed c = case c of
  AddToView v _ _ -> Just v
  PlaceExplorerElements v _ _ -> Just v
  ShowRelations v _ _ -> Just v
  ShowAsEdge v _ _ -> Just v
  RemoveFromView v _ -> Just v
  CutFromView v _ -> Just v
  SetBounds v _ -> Just v
  SetLayout v _ _ -> Just v
  SetEdgeLayout v _ _ -> Just v
  HideEdges v _ _ -> Just v
  SetViewDescription v _ _ -> Just v
  SetViewElements v _ _ _ -> Just v
  CreateGroup v _ _ _ -> Just v
  CreateNote v _ _ -> Just v
  AddViewReference v _ _ -> Just v
  AddFileReference v _ _ -> Just v
  CreateArrow v _ _ -> Just v
  Collect v _ -> Just v
  AddToCollection v _ _ -> Just v
  Uncollect v _ _ -> Just v
  PasteIntoView v _ _ -> Just v
  PasteRdf v _ _ _ -> Just v
  _ -> Nothing
viewExists :: Backend -> Id -> Bool
law_missingViewRejected :: Backend -> EditCommand -> Bool
law_missingViewRejected b c = maybe False (not . viewExists b) (viewNamed c) ==> failed (fst (step b (Execute c)))

-- 6.2 Resource edits ------------------------------------------------------------------

-- | Resource edits: createInstance, rename, setUri, setStatements, delete, createRelation, reconnectRelation.
-- Labels are not identity. Reject empty labels and surrounding spaces. A copy label uses the next free numeric suffix.
-- New IRIs come from canonical-md and are free. An explicit IRI keeps its spelling. An empty Set IRI input mints from the label.
-- rename updates the applicable label predicate (rdfs:label, skos:prefLabel, sh:name).
labelProblem :: String -> Maybe Error
labelProblem l
  | null l = Just "The label is empty."
  | l /= trim l = Just "The label has spaces at the start or the end."
  | otherwise = Nothing
  where trim = reverse . dropWhile (== ' ') . reverse . dropWhile (== ' ')
-- | A trailing number counts up and keeps its width ("Agent 1" -> "Agent 2", "agent-01" -> "agent-02").
-- A label without one gets " 2", " 3", …
nextLabel :: String -> [String] -> String
nextLabel l = firstFree candidate
  where
    digitsRev = takeWhile isDigit (reverse l)
    stem = reverse (drop (length digitsRev) (reverse l))
    digits = reverse digitsRev
    candidate i
      | null digits = l ++ " " ++ show (i + 1)
      | otherwise = stem ++ padLeft (length digits) (show ((read digits :: Int) + i))
    padLeft n s = replicate (n - length s) '0' ++ s
-- | "unnamed <kind> N": the first N >= 1 not taken by an element of that kind.
unnamedLabel :: String -> [String] -> String
unnamedLabel kind = firstFree (\i -> "unnamed " ++ lower kind ++ " " ++ show i)
labelPredicates :: [Iri]
labelPredicates = ["rdfs:label", "skos:prefLabel", "sh:name"]
mintIri :: String -> [Iri] -> Iri                 -- canonical-md: a free IRI from a label, given the IRIs in use
law_mintFree :: String -> [Iri] -> Bool
law_mintFree l used = mintIri l used `notElem` used
law_labelRejected :: Backend -> Id -> String -> Bool
law_labelRejected b i l = isJust (labelProblem l) ==> failed (fst (step b (Execute (Rename i l))))
law_nextLabelFree :: String -> [String] -> Bool
law_nextLabelFree l used = nextLabel l used `notElem` used

-- | setStatements replaces values only for the predicates it supplies.
objectsOf :: Backend -> Iri -> Iri -> [Term]       -- subject, predicate
law_setStatementsScope :: Backend -> Id -> [(Iri, [Term])] -> Iri -> Bool
law_setStatementsScope b i vs p =
  let b' = snd (step b (Execute (SetStatements i vs)))
  in case idIri i of
       Just s -> case lookup p vs of
         Nothing -> objectsOf b' s p == objectsOf b s p
         Just ts -> failed (fst (step b (Execute (SetStatements i vs)))) || sameSet (objectsOf b' s p) ts
       Nothing -> True

-- | A relation must satisfy the metamodel (the links of the vocabulary plugins of §8.5), must not duplicate a triple and must not link an
-- instance to itself.
-- reconnectRelation keeps the predicate, changes the relation ID and keeps layouts only where both new ends show.
-- A reconnect to the same end changes only its side.
-- setUri follows references across graphs, including triple terms. A shape IRI change excludes data rdf:type uses
-- and can propose a class migration. delete by kind is provisional (open.md D1).
permitted :: Backend -> Iri -> Iri -> Iri -> Bool    -- a link of the metamodel permits predicate p from s to o
relationProblem :: Backend -> Iri -> Iri -> Iri -> Maybe Error
relationProblem b s p o
  | s == o = Just "A relation from an element to itself is not supported."
  | Quad (NamedNode s) p (NamedNode o) (graphIri ModelGraph) `elem` modelStatements b = Just "The relation exists already."
  | not (permitted b s p o) = Just "No shape or RDFS rule permits this relation."
  | otherwise = Nothing
law_relationRejected :: Backend -> Iri -> Iri -> Iri -> Bool
law_relationRejected b s p o =
  isJust (relationProblem b s p o)
    ==> failed (fst (step b (Execute (CreateRelation (ExistingEnd (elementId s)) p (ExistingEnd (elementId o)) Nothing))))
-- | After setUri, no statement of any graph mentions the old IRI, as a term or inside a triple term.
mentions :: Iri -> Term -> Bool
mentions i (NamedNode n) = n == i
mentions _ Literal {} = False
mentions i (TripleTerm s p o) = mentions i s || p == i || mentions i o
law_setUriFollowsReferences :: Backend -> Iri -> Iri -> Bool
law_setUriFollowsReferences b old new =
  let (r, b') = step b (Execute (SetUri (elementId old) (Just new)))
      mentionsOld (Quad s p o g) = mentions old s || p == old || mentions old o || g == old
  in not (failed r) ==> not (any mentionsOld (storeQuads b'))

-- 6.3 View edits, marks and entity groups ----------------------------------------------

-- | View edits: createView, duplicateView, addToView, showRelations, showAsEdge, removeFromView, cutFromView.
-- Geometry edits: setBounds, setLayout, setEdgeLayout, hideEdges, setViewElements.
-- Mark edits: createGroup, createNote, addViewReference, addFileReference, createArrow.
-- Entity groups: collect, addToCollection, uncollect. Clipboard: pasteIntoView.
-- View edits change Project statements only: no statement outside view graphs changes (law_viewEditsKeepData).
-- collect and addToCollection remove the own placement of each member and the placements of its relations.
-- An arrow placement stays: it ends at the group. uncollect gives each released member a placement beside the group.
-- Moving a frame at the same size moves its contained boxes. setLayout clears requested edge sides.
-- duplicateView makes new Project IRIs and rewrites internal references. Domain elements stay shared.
-- A file reference stores its path relative to the view file. setViewElements ignores fields that the target kind lacks.
-- A note edit carries expectedText. A stale edit is rejected.
-- addViewReference refuses a second reference to the same view. Paste skips it.
isViewEdit :: EditCommand -> Bool
isViewEdit c = isJust (viewNamed c) || case c of
  CreateView _ _ _ -> True
  DuplicateView _ _ -> True
  _ -> False
isViewGraph :: Backend -> Iri -> Bool
law_viewEditsKeepData :: Backend -> EditCommand -> Bool
law_viewEditsKeepData b c =
  let outside = filter (not . isViewGraph b . graphOf)
  in isViewEdit c ==> sameSet (outside (storeQuads (snd (step b (Execute c))))) (outside (storeQuads b))
-- | Description edits accept an expected value. A stale draft cannot replace a newer description.
viewDescriptionText :: Backend -> Id -> String
law_staleViewDescriptionRejected :: Backend -> Id -> String -> String -> Bool
law_staleViewDescriptionRejected b v text expected =
  viewDescriptionText b v /= expected ==> failed (fst (step b (Execute (SetViewDescription v text (Just expected)))))
noteText :: Backend -> Id -> Maybe String
law_staleNoteRejected :: Backend -> Id -> Id -> ViewElementPatch -> String -> Bool
law_staleNoteRejected b v n patch expected =
  noteText b n /= Just expected ==> failed (fst (step b (Execute (SetViewElements v [n] patch (Just expected)))))
viewReferences :: Backend -> Id -> [Id]             -- the views that view v references
law_oneReferencePerView :: Backend -> Id -> Id -> Point -> Bool
law_oneReferencePerView b v target at =
  target `elem` viewReferences b v ==> failed (fst (step b (Execute (AddViewReference v target at))))
ownPlacementIn :: Backend -> Id -> Id -> Bool       -- view, element: the view has an own placement of it
law_collectRemovesOwnPlacements :: Backend -> Id -> [Id] -> Bool
law_collectRemovesOwnPlacements b v ms =
  let (r, b') = step b (Execute (Collect v ms)) in not (failed r) ==> not (any (ownPlacementIn b' v) ms)

-- 6.4 Copy, cut and paste ---------------------------------------------------------------

-- | Copy makes new instances with their types, fields, owned values and the relations between copied instances.
-- It keeps box dimensions, color, display and copied relation layouts. Paste packs new placements near the requested point.
-- Cut removes the source placements at once. Paste after cut reuses the same IRIs and skips cards the target view has.
-- Copy reads source content at paste time. Deleted source instances do not return. A clip from another model matches same IRIs only.
-- Frames include their contained boxes. Entity groups copy as member cards. Groups and notes copy their content.
-- Limit: clips omit arrows and file references.
clipElements :: ViewClip -> [Iri]
clipIsCut :: ViewClip -> Bool
elementsOf :: Backend -> [Iri]                      -- subjects with statements outside view graphs
law_pasteCopyMintsNew :: Backend -> Id -> ViewClip -> Bool
law_pasteCopyMintsNew b v clip =
  let (r, b') = step b (Execute (PasteIntoView v clip Nothing))
      new = filter (`notElem` elementsOf b) (elementsOf b')
  in (not (failed r) && not (clipIsCut clip)) ==> all (`notElem` clipElements clip) new
law_pasteCutReusesIris :: Backend -> Id -> ViewClip -> Bool
law_pasteCutReusesIris b v clip =
  let b' = snd (step b (Execute (PasteIntoView v clip Nothing)))
  in clipIsCut clip ==> all (`elem` elementsOf b) (elementsOf b')

-- | Raw RDF paste adds missing statements without replacing values or changing explicit resource IRIs.
-- Existing statements keep their origins. New statements use the normal subject and file routing rules (§2.4).
-- Parsing replaces blank nodes with skolem IRIs (§1). Named graphs require consent before flattening and triple deduplication.
-- Notations derive figures from the pasted subjects and statements. Arrival places their connectors, hubs and required endpoints.
-- Data, placements and layout form one transaction and one undo step. Unsupported figures do not prevent data insertion.
modelRdf :: Backend -> [Quad]                       -- domain triples, graph normalized for comparison
clipboardHasNamedGraphs :: String -> Bool           -- parsed clipboard N-Quads
law_pasteRdfAdditive :: Backend -> Id -> String -> Bool -> Bool
law_pasteRdfAdditive b v text flatten =
  let (r, b') = step b (Execute (PasteRdf v text flatten Nothing))
  in not (failed r) ==> all (`elem` modelRdf b') (modelRdf b)
law_namedGraphConsent :: Backend -> Id -> String -> Bool
law_namedGraphConsent b v text =
  clipboardHasNamedGraphs text ==> failed (fst (step b (Execute (PasteRdf v text False Nothing))))

-- | Copy as RDF returns readable Turtle of selected resources, selected triples and owned nested values.
-- Referenced descriptions require selection or ownership. Export excludes placement metadata and merges duplicate triples.
copiedDomainRdf :: Backend -> Id -> [Id] -> [Quad]
isPlacementQuad :: Quad -> Bool
law_rdfCopyWithoutPlacement :: Backend -> Id -> [Id] -> Bool
law_rdfCopyWithoutPlacement b v ids = not (any isPlacementQuad (copiedDomainRdf b v ids))

-- 7. Arrival and removal -----------------------------------------------------

-- | Arrival and removal (ADR 0014, spec/ui-manifest.hs §2.8, §2.9) run in the command that places or removes, in the same patch.
-- Arrival: a command that places an element (addToView, drag, pasteIntoView, expand) also places, until nothing changes,
-- each hub whose ends are then shown, each line with a shown start and end, and each link between two shown figures.
-- Only what touches a figure that this arrival placed. A statement that a shown hub covers (nt:covers) is not placed.
-- The fixpoint is spec/ui-manifest.hs arrival. Removal is spec/ui-manifest.hs cascade.
-- Removal: removeFromView also removes the placements that need a removed figure, and each box kept by lines whose
-- last line it took. The removed elements return as rows. No data changes (law_viewEditsKeepData).
-- A placement whose element gets a new IRI is not an arrival.
-- showAsEdge, createPropertyShape and setPropertyShape run with arrivals off.
arrivalsOn :: EditCommand -> Bool
arrivalsOn c = case c of
  ShowAsEdge {} -> False
  CreatePropertyShape {} -> False
  SetPropertyShape {} -> False
  _ -> True
-- | Data arrival: a command that adds a statement or a property shape places it in each view that shows its start and its
-- end. A line with a private or open end and a hub member do not arrive alone. A new constraint over lines that a view
-- places gets its hub there; the members lose their own placements. A list placement of an ungrouped constraint goes.
-- A command that changes the lists of a holder moves each list placement to the term of its new position n.
-- Code: executeCommand (packages/rdf/src/commands.ts) runs placeConnectors (links), syncFigures (figure-edits.ts: lines,
-- hubs, boxes) and pruneArrows after each command.
viewShows :: Backend -> Id -> Iri -> Bool               -- view, element: the view shows a figure of it, own or as a part
placedIn :: Backend -> Id -> Term -> Bool           -- view, term: the view has a placement of it
law_dataArrival :: Backend -> EditCommand -> Id -> Quad -> Bool
law_dataArrival b c v q@(Quad s _ o _) =
  let (r, b') = step b (Execute c)
      added = Add q `elem` lastPatch b'
      ends = [x | NamedNode x <- [s, o]]
  in (not (failed r) && added && length ends == 2 && all (viewShows b' v) ends && linkFigure b' q)
       ==> placedIn b' v (TripleTerm s (predicateOf q) o)
linkFigure :: Backend -> Quad -> Bool               -- a notation makes the statement a link (nt:link) between two figures

-- 8. Shapes, SKOS and migrations ---------------------------------------------

-- 8.1 Shape edits -----------------------------------------------------------------------

-- | Shape edits: createNodeShape, proposeShapes, setNodeShape, createPropertyShape, setPropertyShape,
-- groupProperties, setConstraint, ungroup, takeOutOfConstraint. They share the data transaction and undo history.
-- A new property owner or target can join the same creation command.
-- Writes support simple predicate paths only. Loaded complex paths stay readable. Unmapped constraints stay intact.
-- Ranges: class, node shape, datatype, node kind, value list, SKOS set, alternatives.
-- A property-level sh:or is alternatives only when each member has one range statement.
-- groupProperties removes the sh:property links and adds the logical list. A member without sh:minCount gets 1.
-- ungroup restores the sh:property links. sh:not takes one member. New list cells get store IRIs.
-- A node-shape target uses its target class when present, else sh:node. Scheme and collection targets keep helper shapes.
-- Limit: a property shape cannot move to another owner.
data RangeKind = ClassRange | NodeShapeRange | DatatypeRange | NodeKindRange | ValueListRange | SkosSetRange | Alternatives
  deriving (Eq, Enum, Bounded)
isAlternatives :: [Int] -> Bool                     -- the number of range statements of each sh:or member
isAlternatives counts = not (null counts) && all (== 1) counts
minCountInGroup :: Maybe Int -> Int
minCountInGroup = fromMaybe 1
groupArity :: LogicalOperator -> Int -> Bool        -- operator, number of members
groupArity Not n = n == 1
groupArity _ n = n >= 1
propertyLinks :: Backend -> Id -> [Id]               -- node shape: its sh:property members
law_groupUngroup :: Backend -> Id -> [Id] -> Bool    -- ungroup restores the sh:property links
law_groupUngroup b s ps = case step b (Execute (GroupProperties ps Nothing)) of
  (Success (Just c) _, b') -> sameSet (propertyLinks (snd (step b' (Execute (Ungroup c)))) s) (propertyLinks b s)
  _ -> True
ownerOf :: Backend -> Id -> Maybe Id                 -- the node shape of a property shape
law_ownerFixed :: Backend -> Id -> PropertyShapePatch -> Bool
law_ownerFixed b p patch =
  let (r, b') = step b (Execute (SetPropertyShape p patch Nothing)) in not (failed r) ==> ownerOf b' p == ownerOf b p

-- | Subject targets form a union. Keep every predicate because any one can select a focus node.
subjectTargetMatches :: [Iri] -> [Iri] -> Bool  -- target predicates, predicates on a subject
subjectTargetMatches targets predicates = any (`elem` predicates) targets
law_subjectTargetUnion :: [Iri] -> [Iri] -> [Iri] -> Bool
law_subjectTargetUnion a b predicates = subjectTargetMatches (a ++ b) predicates == (subjectTargetMatches a predicates || subjectTargetMatches b predicates)

-- | Direct targets and positive node constraints define one checked-node relation.
-- Queries return reasons. They exclude view graphs and the validation report.
-- Node constraints check the same focus node. Property node constraints check path values.
-- Constraint checking does not add a class type. Validation runs when shapes exist, without a palette class.
shapesForNode :: (Eq n, Eq s) => [(n, s)] -> n -> [s]
shapesForNode relation node = nub [s | (n, s) <- relation, n == node]
nodesForShape :: (Eq n, Eq s) => [(n, s)] -> s -> [n]
nodesForShape relation shape = nub [n | (n, s) <- relation, s == shape]
law_targetNavigation :: (Eq n, Eq s) => [(n, s)] -> n -> s -> Bool
law_targetNavigation relation node shape = (shape `elem` shapesForNode relation node) == (node `elem` nodesForShape relation shape)
nodeReferenceChecks :: Iri -> [Iri] -> Bool -> [Iri]
nodeReferenceChecks focus values propertyLevel = if propertyLevel then nub values else [focus]
law_nodeNavigation :: Iri -> [Iri] -> Bool
law_nodeNavigation focus values = nodeReferenceChecks focus values False == [focus] && nodeReferenceChecks focus values True == nub values

-- 8.2 Shape proposal --------------------------------------------------------------------

-- | proposeShapes (shape-proposal.ts, SHACLxtract) makes node shapes from the model graph and writes them to the shapes file.
-- Without classes: each IRI type of the model graph that no sh:targetClass names. Classes with a shape are skipped.
-- RDF, RDFS, OWL, SHACL, SKOS, view and workspace types get no proposal. rdf:type gets no property shape.
-- Each shape gets sh:name, the class label. The proposal describes the data. It is a draft, not a rule.
-- Limit: values in shapes files are not read (open.md G11).
proposeShapes :: [Iri] -> Tx (Either Error [Iri])
excludedNamespaces :: [Iri]
excludedNamespaces =
  [ "http://www.w3.org/1999/02/22-rdf-syntax-ns#", "http://www.w3.org/2000/01/rdf-schema#", "http://www.w3.org/2002/07/owl#"
  , "http://www.w3.org/ns/shacl#", "http://www.w3.org/2004/02/skos/core#", workspaceNamespace ]
isViewVocabulary :: Iri -> Bool
proposalClasses :: Maybe [Iri] -> [Iri] -> [Iri] -> [Iri]   -- requested classes, model types, sh:targetClass values
proposalClasses requested types targeted =
  [c | c <- fromMaybe types requested, c `notElem` targeted, not (any (`isPrefixOf` c) excludedNamespaces), not (isViewVocabulary c)]

-- 8.3 SKOS ------------------------------------------------------------------------------

-- | SKOS edits: createValueSet, addConcept, removeConcept, setConceptBroader. Schemes, collections and concepts are Domain data.
-- Scheme membership uses skos:inScheme. Collection membership uses skos:member.
-- Removing a collection member keeps the concept. Removing a scheme concept deletes it only when no other scheme uses it.
-- Broader edits keep existing parents. Reject missing concepts, self-links and cycles, also through inverse skos:narrower.
-- Collection edits refresh helper sh:in lists. Plain legacy value lists are read only.
membershipPredicate :: ValueSetKind -> Iri
membershipPredicate Scheme = "skos:inScheme"
membershipPredicate Collection = "skos:member"
broaderOf :: Backend -> Iri -> [Iri]                 -- skos:broader, and the inverse of skos:narrower
ancestors :: Backend -> Iri -> [Iri]
ancestors b c = go [] (broaderOf b c)
  where
    go seen [] = seen
    go seen (x : xs)
      | x `elem` seen = go seen xs
      | otherwise = go (seen ++ [x]) (xs ++ broaderOf b x)
conceptExists :: Backend -> Iri -> Bool
broaderProblem :: Backend -> Iri -> Iri -> Maybe Error   -- concept, new parent
broaderProblem b c p
  | not (conceptExists b c && conceptExists b p) = Just "The concept does not exist."
  | c == p = Just "A concept cannot be broader than itself."
  | c `elem` ancestors b p = Just "The link makes a cycle."
  | otherwise = Nothing
law_broaderRejected :: Backend -> Iri -> Iri -> Bool
law_broaderRejected b c p = isJust (broaderProblem b c p) ==> failed (fst (step b (Execute (SetConceptBroader c p))))
law_broaderKeepsParents :: Backend -> Iri -> Iri -> Bool
law_broaderKeepsParents b c p =
  let b' = snd (step b (Execute (SetConceptBroader c p))) in all (`elem` broaderOf b' c) (broaderOf b c)
schemesOf :: Backend -> Iri -> [Iri]
law_removeSchemeConcept :: Backend -> Iri -> Iri -> Bool   -- scheme, concept
law_removeSchemeConcept b s c =
  let (r, b') = step b (Execute (RemoveConcept (elementId s) c))
  in (not (failed r) && any (/= s) (schemesOf b c)) ==> conceptExists b' c

-- 8.4 Migrations ------------------------------------------------------------------------

-- | Migrations: a path or target-class change can propose a migration of data that uses the old term.
-- An exclusive old term and an unused new term allow a wider rename through shapes, vocabulary and views.
-- Data predicate and type changes wait for Apply to data (migrateData, one command). Dismissal changes only the queue.
-- The queue is not saved. Datatype and cardinality changes give validation results, not migrations.
-- Opposing entries are unresolved (open.md MIGRATION1).
migrateData :: Id -> Tx (Either Error ())
dismissMigration :: Id -> IO ()
dismissMigration i = () <$ runOp (DismissMigration i)
law_dismissOnlyQueue :: Backend -> Id -> Bool
law_dismissOnlyQueue b i =
  let b' = snd (step b (DismissMigration i))
  in storeQuads b' == storeQuads b && Just (historyOf b') == (dismiss i (historyOf b) <|> Just (historyOf b))

-- | Metamodel: merged from the palette classes, links and fields of the vocabulary plugins (§8.5), with the SKOS vocabulary. Several node shapes can target one class.
-- Class labels come from the class resource, not the node-shape name. Value-set relations accept permitted concepts only.
-- Forms use a temporary sh:in expansion of SKOS helper targets. Saved shapes and validation keep the original constraints.
-- Limit: forms edit direct-path properties only. Inverse paths and undeclared predicates have no generic form editing.
-- An external change or a rejected edit can rebuild the form and lose field focus.
shapesTargeting :: Backend -> Iri -> [Iri]           -- class: the node shapes that target it; zero, one or more

-- 8.5 Vocabulary plugins: palette, links, fields --------------------------------------------

-- | Each reader of the metamodel has its own provider contract, named after it: @catenary/palette (the palette and the class
-- picker), @catenary/links (the link picker, drawn and reconnected edges), @catenary/fields (the Properties form, the card fields).
-- @catenary/explorer is the contract of the Model explorer (ADR 0006). A vocabulary plugin implements the contracts it can and reads
-- its statements only through a query port (@catenary/query). The host (@catenary/rdf authoring.ts) parses no vocabulary: it gives
-- each plugin a port (SHACL: the shapes graphs; RDFS: all graphs of the files, never the validation report), runs the plugins in
-- precedence order (SHACL, RDFS) and merges them (@catenary/model mergeContributions). The readers read only the merged metamodel.
-- Merge: the first plugin that gives a class wins it; the classes of a plugin follow those of the plugins before it, by order, then
-- name. For a class and a predicate, the first plugin that gives a link or a field wins (law_shaclWins). A link without a target
-- admits an instance of any class. A field of rdfs:label makes the label editable. A link with a value set and no values gets the
-- concepts of its scheme from the SKOS vocabulary.
-- SHACL (@catenary/shacl authoring.ts): a class for each sh:targetClass and for a node shape that is also a class; a link for
-- sh:class or sh:node, else a field (sh:datatype, sh:in, sh:nodeKind sh:IRI), with sh:minCount and sh:maxCount.
-- RDFS (@catenary/rdfs domain-range.ts): the written rdfs:domain and rdfs:range statements are suggestions for the editor, not
-- constraints. Validation never reads them, because RDFS domain and range are inference rules. A domain applies to its class and its
-- written subclasses. A class range gives a link and also admits the written subclasses. A literal range gives a field.
-- rdfs:Literal takes any literal. No range, rdfs:Resource and owl:Thing take any value: a field and a link without a target.
-- Several domains or ranges are a union. No cardinality. RDF, RDFS, OWL, SHACL and SKOS predicates and domains give no rules.
-- No type inference and no rdfs:subPropertyOf. An RDFS statement, or the label or comment of an RDFS predicate or class, rebuilds
-- the metamodel. Other data does not.
-- Properties edits the fields and links of a plugin other than SHACL in a form node shape of no file (pluginFormShape), one property
-- for each predicate with its ranges as alternatives. It is never saved or validated.
data PaletteClass = PaletteClass { paletteIri :: Iri, paletteOrder :: Maybe Int } deriving Eq
data LinkRule = LinkRule { linkDomain :: Iri, linkPredicate :: Iri, linkTarget :: Maybe Iri } deriving Eq   -- Nothing: any class
data FieldRule = FieldRule { fieldDomain :: Iri, fieldPredicate :: Iri, fieldDatatype :: Maybe Iri } deriving Eq
data Contributions = Contributions { pluginId :: String, pluginClasses :: [PaletteClass], pluginLinks :: [LinkRule], pluginFields :: [FieldRule] }
pluginContributions :: Backend -> [Contributions]    -- AUTHORING_PLUGINS in precedence order: shacl, rdfs
keysOf :: Contributions -> [(Iri, Iri)]              -- the (class, predicate) pairs of its links and fields
keysOf c = nub ([(linkDomain l, linkPredicate l) | l <- pluginLinks c] ++ [(fieldDomain f, fieldPredicate f) | f <- pluginFields c])
mergedKeys :: [Contributions] -> [(String, (Iri, Iri))]   -- the plugin of each (class, predicate) in the metamodel
mergedKeys = go []
  where
    go _ [] = []
    go owned (c : cs) = let new = [k | k <- keysOf c, k `notElem` owned] in [(pluginId c, k) | k <- new] ++ go (owned ++ new) cs
law_shaclWins :: [Contributions] -> Bool
law_shaclWins cs = and [firstGiver k == p | (p, k) <- mergedKeys cs]
  where firstGiver k = head [pluginId c | c <- cs, k `elem` keysOf c]
subclassesOf :: [(Iri, Iri)] -> Iri -> [Iri]         -- written rdfs:subClassOf pairs (sub, super), a class: it, then its subclasses
subclassesOf pairs c = go [] [c]
  where
    go seen [] = seen
    go seen (x : xs)
      | x `elem` seen = go seen xs
      | otherwise = go (seen ++ [x]) (xs ++ [s | (s, d) <- pairs, d == x])
law_domainSubclasses :: [(Iri, Iri)] -> Iri -> Bool
law_domainSubclasses pairs c = take 1 (subclassesOf pairs c) == [c] && all (`elem` subclassesOf pairs c) [s | (s, d) <- pairs, d == c]

-- 9. Validation --------------------------------------------------------------

-- | Validate model triples and the relevant shapes vocabulary 250 ms after a data or shape change.
-- Layout-only changes do not validate. SKOS changes rebuild the metamodel. A run made stale by a newer edit is discarded.
-- The bundled backend runs shacl-engine in a worker thread. Without the worker file, validation runs in the backend thread.
-- The report goes to urn:trellis:validation: derived, not saved, not in undo, not in the dirty comparison.
-- A result keeps focus, source shape, path, severity, component and message. A complex path can have no simple path field.
-- Explorer plugin queries and ordinary reads exclude the report graph.
validate :: IO ()
validationDelayMs :: Int
validationDelayMs = 250
data Severity = Violation | Warning | Info deriving Eq
data ValidationResult = ValidationResult
  { focusNode :: Iri, sourceShape :: Iri, resultPath :: Maybe Iri, severity :: Severity, component :: Iri, message :: String }
-- | The validator is a pure function: data quads and shape quads in, the results out. It reads nothing from the store or the files.
-- The coordinator builds the input (validationInput), writes the report graph and sends the change event. The worker thread gets a
-- full copy of the input for each run.
-- Reason: one input, one report. The validator can run in any thread and in tests without a store.
-- The shapes are all shapes graphs, own and imported. Without shapes, the report is empty.
validator :: [Quad] -> [Quad] -> [ValidationResult]   -- the data, the shapes
law_validatorNoShapes :: [Quad] -> Bool
law_validatorNoShapes dataQs = null (validator dataQs [])
data ChangeScope = ChangeScope { dataChanged, shapesChanged, layoutOnly :: Bool }
validates :: ChangeScope -> Bool
validates s = not (layoutOnly s) && (dataChanged s || shapesChanged s)
-- | A run reports only when no newer edit started after it.
reportIsCurrent :: Int -> Int -> Bool                -- the revision of the run, the current revision
reportIsCurrent run current = run == current
-- | With imported files (§2.6), validation reads the statements of own files, all statements of their subjects, and the rdf:type
-- and scheme membership statements of the IRIs that they refer to. The rest of the imported files is not validated.
-- Reason: imported files are read only and can be large. Validating all of them makes each edit slow, and their results cannot be fixed.
-- Scheme membership: a value "in scheme S" (sh:node of a scheme shape) is often a concept of an imported vocabulary.
-- Without imported files, validation reads the whole model graph.
validationData :: [Quad] -> [Quad] -> [Quad]      -- the statements of own files, the statements of the model graph
validationData own model = nub (own ++ ofSubjects ++ factsOfTargets)
  where
    subjects = map subjectOf own
    targets = [o | q <- own, o@(NamedNode _) <- [objectOf q], o `notElem` subjects]
    ofSubjects = [q | q <- model, subjectOf q `elem` subjects]
    factsOfTargets = [q | q <- model, predicateOf q `elem` [rdfType, skos "inScheme", skos "topConceptOf"], subjectOf q `elem` targets]
      ++ [q | q <- model, predicateOf q == skos "hasTopConcept", objectOf q `elem` targets]
rdfType :: Iri
rdfType = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
skos :: String -> Iri
skos local = "http://www.w3.org/2004/02/skos/core#" ++ local
-- | The SKOS projection of the shapes graphs: the statements with a SKOS predicate, and the rdf:type statements whose object is a
-- SKOS class. Concepts and schemes in a shapes file are data for validation: a value "in scheme S" is checked against them.
-- Scheme membership adds the skos:inScheme statements that skos:topConceptOf and skos:hasTopConcept imply (SKOS: both state it).
skosProjection :: [Quad] -> [Quad]
skosProjection shapes = schemeMembership [q | q <- shapes, isSkos q]
  where
    isSkos q = skos "" `isPrefixOf` predicateOf q || (predicateOf q == rdfType && isSkosClass (objectOf q))
    isSkosClass (NamedNode c) = skos "" `isPrefixOf` c
    isSkosClass _ = False
schemeMembership :: [Quad] -> [Quad]
schemeMembership qs = nub (qs ++
  [Quad c (skos "inScheme") s g | Quad c p s g <- qs, p == skos "topConceptOf"] ++
  [Quad c (skos "inScheme") s g | Quad s p c g <- qs, p == skos "hasTopConcept"])
law_ownStatementsValidated :: [Quad] -> [Quad] -> Bool
law_ownStatementsValidated own model = all (`elem` validationData own model) own
-- | ws:validation chooses what validation checks: Off, OpenViews ("views") or All. All is the default, and writers do not store it.
-- Reason: a full run after each edit is slow on a large model. The author chooses speed or completeness for the workspace.
-- Off: no run, an empty report graph, no violations. All: validationData and the whole SKOS projection of all shapes graphs.
-- OpenViews: the own statements whose subject is on an open view (an editor shows the view), then the statements of these subjects
-- and the facts of their targets, as validationData does. The SKOS projection goes in only for the elements on the open views and
-- the IRIs that these statements name. Unrelated vocabulary of the shapes files stays out.
-- The status bar counts an instance as checked only when the input has statements about it (not one that only imported files describe).
-- A shape that reads an element outside the open views can report too much or too little (spec/open.md VALIDATION2).
-- In OpenViews, a change of the open views and a change of a placement on an open view (not the layout) start a run.
data ValidationMode = ValidationOff | ValidationOpenViews | ValidationAll deriving Eq
validationValue :: ValidationMode -> Maybe String   -- the literal of ws:validation; Nothing: not written
validationValue ValidationOff = Just "off"
validationValue ValidationOpenViews = Just "views"
validationValue ValidationAll = Nothing
-- | The elements on the open views: the elements and group members of placements, and the subjects of placed relations.
validationFocus :: [Iri] -> [Quad] -> [Term]        -- the open views, the statements of the view graphs
validationFocus views qs = nub (
  [o | Quad _ p o@(NamedNode _) g <- qs, g `elem` views, p `elem` ["view:element", "view:member"]] ++
  [s | Quad _ "rdf:reifies" (TripleTerm s@(NamedNode _) _ _) g <- qs, g `elem` views])
-- The mode, the focus, own statements, the model graph, the shapes graphs (own and imported).
validationInput :: ValidationMode -> [Term] -> [Quad] -> [Quad] -> [Quad] -> [Quad]
validationInput ValidationOff _ _ _ _ = []
validationInput ValidationAll _ own model shapes = schemeMembership (validationData own model ++ skosProjection shapes)
validationInput ValidationOpenViews focus own model shapes =
  schemeMembership (selected ++ [q | q <- skosProjection shapes, subjectOf q `elem` named])
  where
    selected = validationData [q | q <- own, subjectOf q `elem` focus] model
    named = focus ++ [t | q <- selected, t@(NamedNode _) <- [subjectOf q, objectOf q]]
law_validationOffEmpty :: [Term] -> [Quad] -> [Quad] -> [Quad] -> Bool
law_validationOffEmpty focus own model shapes = null (validationInput ValidationOff focus own model shapes)
law_openViewsWithinAll :: [Term] -> [Quad] -> [Quad] -> [Quad] -> Bool
law_openViewsWithinAll focus own model shapes =
  all (`elem` validationInput ValidationAll focus own model shapes) (validationInput ValidationOpenViews focus own model shapes)
law_allHasProjection :: [Quad] -> [Quad] -> [Quad] -> Bool
law_allHasProjection own model shapes = all (`elem` validationInput ValidationAll [] own model shapes) (skosProjection shapes)
-- | A projection statement about an element on an open view goes in: scheme membership from a shapes file reaches OpenViews.
law_openViewsHasFocusProjection :: [Term] -> [Quad] -> [Quad] -> [Quad] -> Bool
law_openViewsHasFocusProjection focus own model shapes =
  all (`elem` validationInput ValidationOpenViews focus own model shapes) [q | q <- skosProjection shapes, subjectOf q `elem` focus]
law_reportNotInPatch :: Backend -> EditCommand -> Bool
law_reportNotInPatch b c = all ((/= graphIri ValidationGraph) . graphOf . changed) (lastPatch (snd (step b (Execute c))))
  where
    changed (Add q) = q
    changed (Remove q) = q

--------------------------------------------------------------------------------
-- Part III. Persistence
--------------------------------------------------------------------------------

-- 10. Writes, Git and the watcher ----------------------------------------------

-- 10.1 Write queue and dirty state ------------------------------------------------------

-- | Code (packages/rdf/src): saver.ts holds the dirty state, the write and the commit paths; reconciler.ts reads what the watcher reports.
-- | File operations run one at a time. Each edit, undo and redo queues a write of the pending changes.
-- Dirty: a write is pending or failed. It compares current canonical content with saved content.
-- Touched file graphs invalidate their canonical cache entries. They do not define dirty state.
-- Restoring saved content clears dirty state without a write, retry or commit.
-- Reason: undo must clear pending changes when current content equals saved content.
-- Save retries pending writes and commits. A successful command does not certify a disk write.
-- A failed write keeps the dirty state and reports its cause.
save :: IO CommandResult
save = runOp Save
canonicalContent :: Backend -> FilePath -> String   -- the canonical text of the current store content of a file
savedContent :: Backend -> FilePath -> String       -- the canonical text of the last read or successful write
dirty :: Backend -> FilePath -> Bool
dirty b f = canonicalContent b f /= savedContent b f
writeFailed :: Backend -> FilePath -> Bool
law_saveCleans :: Backend -> FilePath -> Bool
law_saveCleans b f = let b' = snd (step b Save) in not (writeFailed b' f) ==> not (dirty b' f)
law_failedWriteStaysDirty :: Backend -> FilePath -> Bool
law_failedWriteStaysDirty b f = let b' = snd (step b Save) in (dirty b f && writeFailed b' f) ==> dirty b' f

-- 10.2 Write form -----------------------------------------------------------------------

-- | Write form: a Turtle text patch where possible. It reads only the blocks of the changed subjects and keeps the
-- syntax tree of the last patched text of each file. Each candidate is parsed again and compared with the expected RDF.
-- Else the whole file: first in the style of the file, then the canonical writer as fallback. A fallback is reported.
-- No text patch for TriG (view files are written whole) and for a text with blank nodes.
-- Limit: the fallback can change comments, prefixes and statement order.
-- Refuse an overwrite when the disk text differs from the last read or write. A watcher reload can drop pending edits, with a warning.
-- Prepare temporary files, then rename. A failed rename can leave earlier files written.
-- Cross-file rollback is not required. Report the failure and retain pending writes for retry (§10.1).
-- Reason: Git and undo provide recovery, without a cross-file transaction protocol.
crossFileRollbackRequired :: Bool
crossFileRollbackRequired = False
data WriteForm = TextPatch | WholeInStyle | Canonical deriving Eq
parsesTo :: Format -> String -> [Quad] -> Bool       -- the text parses to exactly these quads
hasBlankNodes :: String -> Bool
writeForm :: Format -> String -> [Quad] -> Maybe String -> Maybe String -> WriteForm
writeForm fmt old expected patched styled
  | fmt == Turtle, not (hasBlankNodes old), Just t <- patched, parsesTo fmt t expected = TextPatch
  | Just t <- styled, parsesTo fmt t expected = WholeInStyle
  | otherwise = Canonical
-- | Any written text parses to the expected RDF.
law_writeIsFaithful :: Format -> String -> [Quad] -> Maybe String -> Maybe String -> String -> Bool
law_writeIsFaithful fmt old expected patched styled canonical =
  let chosen = case writeForm fmt old expected patched styled of
        TextPatch -> fromMaybe canonical patched
        WholeInStyle -> fromMaybe canonical styled
        Canonical -> canonical
  in parsesTo fmt canonical expected ==> parsesTo fmt chosen expected
diskText :: Backend -> FilePath -> IO String
lastKnownText :: Backend -> FilePath -> String      -- the text of the last read or write
mayOverwrite :: String -> String -> Bool             -- disk text, last known text
mayOverwrite disk known = disk == known

-- 10.3 Git ------------------------------------------------------------------------------

-- | Git: each write batch is one commit of its changed files, git commit --only. Unrelated staged changes stay out.
-- Files with outside uncommitted changes, found at open or reload, are not committed automatically. Ignored files stay out.
-- No repository: write files and warn once. A failed commit path is retried at a later write.
-- A batch can hold several command kinds. There is no promise of one commit per EditCommand.
data FileState = FileState { written :: Bool, outsideChanges :: Bool, gitIgnored :: Bool }
commitPaths :: [(FilePath, FileState)] -> [FilePath]   -- the files of one write batch
commitPaths fs = [f | (f, s) <- fs, written s, not (outsideChanges s), not (gitIgnored s)]
gitArguments :: String -> [FilePath] -> [String]   -- message, the commitPaths of the batch
gitArguments msg ps = ["commit", "--only", "-q", "-m", msg, "--"] ++ ps

-- 10.4 Watcher --------------------------------------------------------------------------

-- | Watcher: recursive, 150 ms after the last event. It ignores hidden paths, temporary files and unchanged own writes.
-- Added, changed and removed model files update the store. A workspace-file change opens the workspace again.
-- A read from disk clears the whole undo history. A missing workspace file or folder stops reads and writes until the next open.
-- Theia text auto-save is off by default. A clean text editor reloads after a canvas write.
watcherDelayMs :: Int
watcherDelayMs = 150
watcherIgnores :: FilePath -> Bool -> Bool            -- path, the event is an unchanged own write
watcherIgnores p ownWrite = ownWrite || any ("." `isPrefixOf`) (segments p) || isTemporary p
isTemporary :: FilePath -> Bool
law_diskReadClearsHistory :: Backend -> [FilePath] -> Bool
law_diskReadClearsHistory b fs =
  let (r, b') = step b (DiskChange fs) in (not (null fs) && not (failed r)) ==> historyOf b' == clearHistory
law_openClearsHistory :: Backend -> FilePath -> Bool
law_openClearsHistory b p = let (r, b') = step b (Open p) in not (failed r) ==> historyOf b' == clearHistory

-- | RDF 1.2 limits: JSON-LD cannot write triple terms. Turtle and TriG files with annotations are read only while n3
-- parsing can lose statements (open.md RDF1). Triple-term canonicalization extends RDFC-1.0. It is not a standard.
-- Legacy view vocabulary has no upgrade path.
hasTripleTerm :: Quad -> Bool
hasTripleTerm (Quad s _ o _) = isTriple s || isTriple o
  where
    isTriple TripleTerm {} = True
    isTriple _ = False
canWrite :: Format -> [Quad] -> Bool
canWrite JsonLd qs = writable JsonLd && not (any hasTripleTerm qs)
canWrite f _ = writable f

--------------------------------------------------------------------------------
-- Part IV. Interfaces
--------------------------------------------------------------------------------

-- 11. Read interface ----------------------------------------------------------

-- 11.1 RPC --------------------------------------------------------------------------------

-- | RPC carries JSON only. Interface: modeler/src/common/protocol.ts, ModelService.
-- Writes: open, create, execute, undo, redo, save, setSettings, setPrefixes, dismissMigration, setImported,
-- importFiles (each is an Op). Undo and redo answer as execute: a step that changes an imported file is refused (§2.6).
-- checkMarkdownExport and exportMarkdown read Markdown files and write an export folder (spec/ui-manifest.hs §9).
-- They are not Ops: they do not change the model, its files or its history.
-- Reads: getSnapshot and the queries of packages/model/src/queries.ts (ModelQueries, MODEL_QUERIES), by group below.
-- The pure rules on scoped Docs: packages/model/src/prompts.ts.
-- sources gives every source file of an element with an optional 1-based disk line. It does not parse all RDF spellings.
-- Backend queries supply panel data. The frontend owns selection, expansion, viewport and transient input (ADR 0007).
data QueryGroup = PanelQueries | ViewQueries | FormQueries | SelectionQueries | PromptQueries deriving (Eq, Enum, Bounded)
queries :: QueryGroup -> [String]
queries PanelQueries = ["explorerChildren", "explorerSearch", "explorerPaths", "explorerElements", "properties", "outline", "problems", "search", "links"]
queries ViewQueries = ["viewLabels", "view", "viewGesture", "appearance", "occurrence", "showing", "unplaced"]
queries FormQueries = ["formData", "shapesText", "shapes"]
queries SelectionQueries = ["selected", "selectionActions", "sources"]   -- selectionActions also gives the cards of Show Details
queries PromptQueries =
  [ "deletePlan", "relationChoices", "neighborChoices", "shapeSourceChoices", "linkChoices", "newLabel"
  , "knownPredicates", "knownClasses", "memberOptions", "instancesNamed", "elementRows" ]
-- | The read interface is exactly these queries. MODEL_QUERIES lists the same names.
modelQueries :: [String]
modelQueries = concatMap queries [minBound .. maxBound]
law_queryNamesUnique :: Bool
law_queryNamesUnique = unique modelQueries
-- | A query changes no store content and no history.
runQuery :: Backend -> String -> (String, Backend)  -- query name with JSON arguments; JSON answer
law_queriesRead :: Backend -> String -> Bool
law_queriesRead b q = let b' = snd (runQuery b q) in storeQuads b' == storeQuads b && historyOf b' == historyOf b
data SourceLine = SourceLine { sourceFile :: FilePath, sourceLine :: Maybe Int }
law_sourceLinePositive :: SourceLine -> Bool
law_sourceLinePositive s = maybe True (>= 1) (sourceLine s)

-- 11.2 Snapshots ---------------------------------------------------------------------------

-- | Caches retain the last change event that affects their input. They use event identity, not independent counters.
-- Snapshot revision and shapesVersion expose sequence numbers of these events for existing clients.
-- Layout and report patches keep unrelated cache keys. A save keeps the current snapshot revision.
law_eventVersion :: Int -> Int -> Bool
law_eventVersion eventSequence snapshotVersion = snapshotVersion == eventSequence

-- | Each connection receives onDidChange snapshots (packages/model/src/snapshot.ts):
-- revision, files, shapesVersion, movedIds, warnings, migrations, prefixes, undo and dirty state,
-- the metamodel and counts (instances, report results, violations), and the last change:
-- its reason and, for an edit, undo or redo, its views, elements, shapes flag and layout flag.
-- The layout flag marks a change of placement geometry or style only. A panel skips a read that the change cannot affect.
-- A snapshot carries no Doc and no report. onDidChange is the client callback (ModelClient). getSnapshot reads the current one.
data ChangeReason = EditChange | UndoChange | RedoChange | LoadChange | FilesChange | SaveChange | ValidationChange
  | ShapesChange | QueueChange | DiskChangeReason deriving Eq
data SnapshotChange = SnapshotChange
  { reason :: ChangeReason, changedViews :: [Id], changedElements :: [Id], shapesFlag :: Bool, layoutFlag :: Bool }
data Snapshot = Snapshot
  { revision :: Int, lastChange :: Maybe SnapshotChange, movedIds :: [(Id, Id)], migrations :: [Migration]
  , canUndo, canRedo, snapshotDirty :: Bool, violations :: Int, results :: Int }
getSnapshot :: IO Snapshot
onDidChange :: Snapshot -> IO ()
snapshotOf :: Backend -> Snapshot
-- | The change cannot change what a model panel shows (explorer, search, links, problems, actions): a write of the files, a
-- move, resize or style change of placements, or a new report when the panel shows no violations (panelsUnchanged).
panelsUnchanged :: Maybe SnapshotChange -> Bool -> Bool   -- the change, the panel shows violations
panelsUnchanged Nothing _ = False
panelsUnchanged (Just c) showsViolations = case reason c of
  SaveChange -> True
  ValidationChange -> not showsViolations
  r -> r `elem` [EditChange, UndoChange, RedoChange] && layoutFlag c
-- | A GLSP session refreshes only when the change scope touches its scoped Doc: a shapes change, a changed view of the
-- Doc, or a changed instance of the Doc. No scope: refresh (view-session.ts, affectedBy).
refreshes :: Doc -> Maybe SnapshotChange -> Bool
refreshes _ Nothing = True
refreshes d (Just c) = shapesFlag c || any (`elem` docViews d) (changedViews c) || any (`elem` docElements d) (changedElements c)
-- | An instance-edge placement removal updates the displayed graph from its committed patch. Other changes use the full projection.
-- Unrelated cards keep their display objects. Removal cascades and arrival rules still run in the transaction (§7).
-- Reason: hiding one edge must not reconstruct unrelated cards.
law_edgeRemovalUpdatesDisplay :: [Id] -> [Id] -> [Id] -> Bool  -- before, removed edge placements, after
law_edgeRemovalUpdatesDisplay before removed after = sameSet after [i | i <- before, i `notElem` removed]
-- | Display refresh starts after synchronous edit completion. The backend can then return the edit result before unrelated display work.
displayRefreshAfterEdit :: Int -> Int -> Bool        -- edit completion, refresh start
displayRefreshAfterEdit completed started = completed <= started
-- | A validation run that changes the violations has a scope: the instances and property shapes whose count of violations changed.
-- A card shows these counts, so a view that shows none of them does not refresh (model-store.ts violationScope).
-- Reason: a run without a scope rebuilt every open view after each edit.
violationScope :: [(Id, Int)] -> [(Id, Int)] -> [Id]   -- violations by element before the run, after the run
violationScope before after = [i | i <- nub (map fst before ++ map fst after), lookup i before /= lookup i after]
-- | A move, resize or style change of placements keeps the reads that do not read the geometry: the figures, hidden neighbor counts
-- and shape applicability of each view, the explorer, the instance count and the file kinds. A write of the files keeps all reads.
-- The figures of a view read the store on demand around the placed terms of the view (notations.ts storeInput): no copy of the store.
-- Reason: these reads scan the whole store. Built again after each change, they made a move take seconds in a large workspace.
keepsReads :: SnapshotChange -> Bool
keepsReads c = reason c == SaveChange || (reason c `elem` [EditChange, UndoChange, RedoChange] && layoutFlag c)
law_snapshotMirrorsHistory :: Backend -> Bool
law_snapshotMirrorsHistory b =
  let s = snapshotOf b
      h = historyOf b
  in canUndo s == not (null (undoStack h)) && canRedo s == not (null (redoStack h)) && migrations s == queue h
     && violations s <= results s
-- | A save-only notification keeps the model revision. Reason: saving unchanged data must not trigger revision-keyed model reads.
law_saveKeepsRevision :: Backend -> Bool
law_saveKeepsRevision b = revision (snapshotOf (snd (step b Save))) == revision (snapshotOf b)
law_revisionIncreases :: Backend -> Op -> Bool
law_revisionIncreases b op = revision (snapshotOf (snd (step b op))) >= revision (snapshotOf b)
law_movedIdsFollowSetUri :: Backend -> Iri -> Iri -> Bool
law_movedIdsFollowSetUri b old new =
  let (r, b') = step b (Execute (SetUri (elementId old) (Just new)))
  in not (failed r) ==> (elementId old, elementId new) `elem` movedIds (snapshotOf b')

-- 12. CLI --------------------------------------------------------------------

-- | scripts/catenary.mjs finds backend token files in $XDG_RUNTIME_DIR/catenary, else in catenary below the OS temporary directory.
-- Each <pid>.json has mode 0600. A request is POST /catenary/cli with a random bearer token.
-- Keep the backend on localhost. eval runs arbitrary JavaScript in a window. The token is the access-control boundary.
tokenDirectory :: Maybe FilePath -> FilePath -> FilePath   -- $XDG_RUNTIME_DIR, the OS temporary directory
tokenDirectory xdg tmp = fromMaybe tmp xdg ++ "/catenary"
tokenFileMode :: Int
tokenFileMode = 0o600
cliPath :: String
cliPath = "/catenary/cli"

-- | Backend methods: status, model, rpc, exec (exec calls RPC execute with an EditCommand).
-- Window methods: commands, run, prompt, answer, ui, messages, eval. They need a connected window.
data CliMethod = Status | Model | Rpc | Exec | Commands | Run | Prompt | Answer | Ui | Messages | Eval deriving (Eq, Enum, Bounded)
needsWindow :: CliMethod -> Bool
needsWindow m = m `notElem` [Status, Model, Rpc, Exec]

-- | Backend choice: --port, else CATENARY_PORT, else the only running backend, else the one backend whose workspace contains
-- the current directory or is inside it. Otherwise the CLI fails and lists ports and workspaces. Files of dead PIDs are removed.
-- --window selects a window, else the last connection.
data RunningBackend = RunningBackend { backendPort :: Int, backendWorkspace :: FilePath }
contains :: FilePath -> FilePath -> Bool             -- a folder contains a path, or is it
contains folder p = folder == p || (folder ++ "/") `isPrefixOf` p
chooseBackend :: Maybe Int -> Maybe Int -> FilePath -> [RunningBackend] -> Maybe Int   -- --port, CATENARY_PORT, cwd, live backends
chooseBackend flag env cwd running = flag <|> env <|> only running <|> only (filter near running)
  where
    only [b] = Just (backendPort b)
    only _ = Nothing
    near b = contains (backendWorkspace b) cwd || contains cwd (backendWorkspace b)

-- | Output is JSON. Exit codes: 0 done, 1 failed, 2 usage or connection error, 3 waiting or timeout.
-- run and answer wait for completion, a prompt or the timeout (default 10 s). answer --cancel cancels a prompt.
-- Results hold status, prompts, notifications, a model summary and the changed flag.
data CliOutcome = Done | CliFailed | UsageOrConnection | WaitingOrTimeout deriving (Eq, Enum, Bounded)
exitCode :: CliOutcome -> Int
exitCode o = fromEnum o
cliTimeoutMs :: Int
cliTimeoutMs = 10000

-- | Prompt adapters: dialogs, quick picks, input boxes, canvas pickers, inline inputs.
-- Limit: notification buttons and canvas drags have no adapter. Use exec for model effects, not for gesture checks.
-- status reports source and build staleness, backend restart need and window reload need. All must be false before a runtime check.
data StatusReport = StatusReport { buildStale, restartNeeded :: Bool, reloadNeeded :: [Bool] }
readyForRuntimeCheck :: StatusReport -> Bool
readyForRuntimeCheck s = not (buildStale s) && not (restartNeeded s) && not (or (reloadNeeded s))

-- Compile-only stubs ----------------------------------------------------------

-- | GHC requires a binding for each signature. These stubs keep primitives as declarations only.
-- Add a stub here for each new primitive. Do not give a stub behavior: write behavior as an equation in its section.
manifestOnly :: a
manifestOnly = error "signature-level manifest only"

modelRdf = manifestOnly
clipboardHasNamedGraphs = manifestOnly
copiedDomainRdf = manifestOnly
isPlacementQuad = manifestOnly

instance Functor Tx where fmap = manifestOnly
instance Applicative Tx where
  pure = manifestOnly
  (<*>) = manifestOnly
instance Monad Tx where (>>=) = manifestOnly

ownedBy = manifestOnly
utf8 = manifestOnly
unescapeId = manifestOnly
storedPath = manifestOnly
formatOf = manifestOnly
segments = manifestOnly
globMatches = manifestOnly
modelFiles = manifestOnly
subjectKind = manifestOnly
nearFile = manifestOnly
defaultFileTx = manifestOnly
encodePath = manifestOnly
dataGraphNames = manifestOnly
addQuad = manifestOnly
origin = manifestOnly
priorOrigin = manifestOnly
subjectFile = manifestOnly
referrerFile = manifestOnly
readOnlyFile = manifestOnly
lastTransferFiles = manifestOnly
importedFiles = manifestOnly
pluginContributions = manifestOnly
fileStatements = manifestOnly
currentSettings = manifestOnly
docElements = manifestOnly
docViews = manifestOnly
viewDoc = manifestOnly
runRead = manifestOnly
sha256Hex = manifestOnly
termKey = manifestOnly
randomBase36 = manifestOnly
isNote = manifestOnly
fileNameOf = manifestOnly
step = manifestOnly
runOp = manifestOnly
runTx = manifestOnly
transact = manifestOnly
storeQuads = manifestOnly
historyOf = manifestOnly
filesOf = manifestOnly
lastPatch = manifestOnly
viewExists = manifestOnly
mintIri = manifestOnly
objectsOf = manifestOnly
permitted = manifestOnly
isViewGraph = manifestOnly
viewDescriptionText = manifestOnly
noteText = manifestOnly
viewReferences = manifestOnly
ownPlacementIn = manifestOnly
clipElements = manifestOnly
clipIsCut = manifestOnly
elementsOf = manifestOnly
viewShows = manifestOnly
placedIn = manifestOnly
linkFigure = manifestOnly
propertyLinks = manifestOnly
ownerOf = manifestOnly
proposeShapes = manifestOnly
isViewVocabulary = manifestOnly
broaderOf = manifestOnly
conceptExists = manifestOnly
schemesOf = manifestOnly
migrateData = manifestOnly
shapesTargeting = manifestOnly
validate = manifestOnly
validator = manifestOnly
canonicalContent = manifestOnly
savedContent = manifestOnly
writeFailed = manifestOnly
parsesTo = manifestOnly
hasBlankNodes = manifestOnly
diskText = manifestOnly
lastKnownText = manifestOnly
isTemporary = manifestOnly
runQuery = manifestOnly
getSnapshot = manifestOnly
onDidChange = manifestOnly
snapshotOf = manifestOnly
