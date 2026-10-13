// Protocol between the Theia frontend and the model backend.
// The backend owns the document (one model, many views; see ModelStore for the files). The frontend and the GLSP diagram
// sessions only send edit commands and receive snapshots.

import type { CommandResult, EditCommand, ExportProblem, ImportResult, ModelQueries, ModelSnapshot, Remote, TraceBatch, UnresolvedEmbed, ValidationMode } from '@catenary/model';
import type { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

export const MODEL_SERVICE_PATH = '/services/catenary';
export const ModelService = Symbol('ModelService');

/** GLSP diagram type and contribution id of the view editor. */
export const DIAGRAM_TYPE = 'catenary-view';
export const CONTRIBUTION_ID = 'catenary';

/** URI of a view editor: catenary-view:/<view id>. Views are not files. */
export const VIEW_SCHEME = 'catenary-view';
/** URI of a model element (used for problem markers): catenary:/<instance id>. */
export const ELEMENT_SCHEME = 'catenary';

/**
 * Apply Layout algorithms (modeler/src/node/glsp/layout.ts). tidy: ELK layered, keeps the current order. force, flow, untangle:
 * cola.js, as the Reactodia layouts of the same names (force: force-directed, then no overlaps; flow: top to bottom; untangle: only
 * removes overlaps).
 */
export const LAYOUT_ALGORITHMS = [
    { id: 'layered', label: 'Layered', description: 'left to right, order with fewer edge crossings (ELK)' },
    { id: 'force', label: 'Force', description: 'force-directed (cola.js)' }
] as const;
export type LayoutAlgorithm = typeof LAYOUT_ALGORITHMS[number]['id'];
/** Space between boxes (px) of Apply Layout: user preference `catenary.layoutSpacing`, sent with each layout request. */
export const LAYOUT_SPACING = { default: 200, min: 20, max: 400 } as const;
/** A spacing in range; else the default. */
export function layoutSpacing(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(LAYOUT_SPACING.max, Math.max(LAYOUT_SPACING.min, Math.round(n))) : LAYOUT_SPACING.default;
}

/**
 * GLSP action from the server to the view editor: what a paste of a view clip did (spec/ui-manifest.hs §5.8). `placed`: new
 * placements; `skipped`: elements that the view showed already; `missing`: clip elements that this model does not have.
 * `alreadyInView`: the view showed all of them, and no command ran.
 */
export interface PasteResultAction {
    kind: typeof PASTE_RESULT;
    mode: 'copy' | 'cut';
    placed: number;
    skipped: number;
    missing: number;
    alreadyInView: boolean;
    /** The clip id of a cut, from the clipboard data: the client clears the mark only for this clip. */
    clipboardId?: string;
}
export const PASTE_RESULT = 'catenaryPasteResult';

export function viewIdOfUri(uri: string): string | undefined {
    const m = /^catenary-view:\/+([^?#/]+)/.exec(uri) ?? /^\/+([^?#/]+)$/.exec(uri);
    return m?.[1];
}

/** Manifest settings that the user changes (ADR 0004). */
export interface WorkspaceSettings {
    defaultFile?: string;
    /** By kind: "near", or a file path relative to the workspace folder. */
    placement?: { shapes?: string; concepts?: string; instances?: string };
    exclude?: string[];
    /** Globs of imported (read-only) files, relative to the workspace folder (ws:imported). */
    imported?: string[];
    /** What SHACL validation checks (ws:validation): nothing, the elements on the open views, or the model. */
    validation?: ValidationMode;
    /** The language of the labels (ws:language): a language tag. Empty: clears the setting. */
    language?: string;
    /** Whether Catenary commits its writes to git (ws:autoCommit). */
    autoCommit?: boolean;
}

/** What to export: files and folders (absolute paths), and documents to leave out (paths relative to the root). */
export interface MarkdownExportRequest { sources: string[]; destination?: string; exclude?: string[] }

/** The check of a Markdown export (spec/ui-manifest.hs §9): the views to render, or why the export cannot run. */
export interface MarkdownExportCheck {
    ok: boolean;
    error?: string;
    /** The real path of the destination folder. */
    destination?: string;
    /** The real path of the source root: the common ancestor folder of the sources. */
    root: string;
    /** The documents that the export writes, relative to the root, with `/`, sorted. */
    documents: string[];
    /** Each embedded view once, in the order of its first embed. */
    views: { iri: string; id: string; label: string }[];
    /** Embeds that name no view, with the source file (relative to the source folder) and the line. */
    unresolved: UnresolvedEmbed[];
    /** Links that the export does not change and reports: missing targets, folders, absolute paths. */
    problems: ExportProblem[];
}

/** The result of a Markdown export. Paths are relative to the destination folder. */
export interface MarkdownExportResult {
    ok: boolean;
    error?: string;
    written: string[];
    /** Files with the same content as the output: not written again. */
    unchanged: string[];
    /** Files of an earlier export that this export does not write, removed. */
    removed: string[];
    /** Files of an earlier export that this export does not write, kept because they changed after that export. */
    kept: string[];
    /** Files that the export would overwrite and does not own: the export wrote nothing. */
    conflicts: string[];
    /** The write that failed; the files in `written` were written before it. */
    failed?: { path: string; error: string };
    unresolved?: UnresolvedEmbed[];
    problems: ExportProblem[];
}

/** The model backend for one frontend: the read queries (ModelQueries, @catenary/model) and the operations below. */
export interface ModelService extends RpcServer<ModelClient>, Remote<ModelQueries> {
    getSnapshot(): Promise<ModelSnapshot>;
    /** Open a workspace file (TriG, the manifest): the RDF files of its folder are the model (ADR 0004). */
    open(workspacePath: string): Promise<CommandResult>;
    /**
     * Create a workspace file with the placement of new subjects (default: `<name>.shapes.ttl`, `<name>.skos.ttl`, near), an empty file for
     * each file of the placement and views/main.view.trig with a view "Main", and open it.
     */
    create(workspacePath: string, placement?: WorkspaceSettings['placement']): Promise<CommandResult>;
    /** Change the manifest settings (ADR 0004): placement by kind (paths relative to the workspace folder), exclude globs. */
    setSettings(settings: WorkspaceSettings): Promise<CommandResult>;
    /**
     * Mark one file as imported or as own (a path relative to the workspace folder, or absolute): its path in the imported globs.
     * Mark as own fails when another glob still matches the file. No undo step.
     */
    setImported(file: string, on: boolean): Promise<CommandResult>;
    /**
     * Import RDF files (absolute paths): for each, a Turtle copy with IRIs for its blank nodes in imported/, marked as imported; their
     * prefixes that the workspace does not have go to the workspace file. All files or none. Reads the workspace again once (no undo).
     */
    importFiles(sources: string[]): Promise<ImportResult>;
    /** Replace the prefix table of the workspace (manifest of the primary workspace file; saved with it). No undo step. */
    setPrefixes(prefixes: Record<string, string>): Promise<CommandResult>;
    /**
     * Check a Markdown export of the request: the root, the documents and the views that they embed, by IRI. Without a destination, it
     * does not check one. Writes nothing.
     */
    checkMarkdownExport(request: MarkdownExportRequest): Promise<MarkdownExportCheck>;
    /** Export the Markdown documents of the request to its destination with the SVG of each embedded view (view IRI → SVG text). */
    exportMarkdown(request: MarkdownExportRequest & { destination: string }, svgs: Record<string, string>): Promise<MarkdownExportResult>;
    /** Remove an entry of the patch queue without applying it. */
    dismissMigration(id: string): Promise<void>;
    /** Write what is not written yet (after a failed write) and commit it. */
    save(): Promise<CommandResult>;
    /** Undo or redo one step. A step that changes an imported file is refused (`imported`: the files); it stays on its stack. */
    undo(): Promise<CommandResult>;
    redo(): Promise<CommandResult>;
    execute(command: EditCommand): Promise<CommandResult>;
    /**
     * Start (true) or stop (false) the trace for this connection (the Trace panel). The backend records while one connection or more
     * has it on. A closed connection stops its trace.
     */
    setTracing(on: boolean): Promise<void>;
    /** The trace spans after `since` (the `seq` of an earlier batch; 0: all kept spans) and the totals. */
    trace(since: number): Promise<TraceBatch>;
    /** Capture the final batch before stopping this connection. Other tracing connections remain active. */
    stopTracing(since: number): Promise<TraceBatch>;
    /** Remove the kept spans and the totals. */
    clearTrace(): Promise<void>;
}

export interface ModelClient {
    onDidChange(snapshot: ModelSnapshot): void;
}

