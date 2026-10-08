// Protocol between the Theia frontend and the model backend.
// The backend owns the document (one model, many views; see ModelStore for the files). The frontend and the GLSP diagram
// sessions only send edit commands and receive snapshots.

import type { CommandResult, EditCommand, ImportResult, ModelQueries, ModelSnapshot, Remote } from '@catenary/model';
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
export const LAYOUT_SPACING = { default: 120, min: 20, max: 400 } as const;
/** A spacing in range; else the default. */
export function layoutSpacing(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(LAYOUT_SPACING.max, Math.max(LAYOUT_SPACING.min, Math.round(n))) : LAYOUT_SPACING.default;
}

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
    /** Globs of protected files, relative to the workspace folder (ws:protect). */
    protect?: string[];
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
     * Protect or unprotect one file (a path relative to the workspace folder, or absolute): its path in the protect globs. An unprotect
     * fails when another glob still protects the file. No undo step.
     */
    setProtected(file: string, on: boolean): Promise<CommandResult>;
    /**
     * Import an RDF file (absolute path): a Turtle copy with IRIs for its blank nodes in imported/, protected; its prefixes that the
     * workspace does not have go to the workspace file. Reads the workspace again (no undo across it).
     */
    importFile(source: string): Promise<ImportResult>;
    /** Replace the prefix table of the workspace (manifest of the primary workspace file; saved with it). No undo step. */
    setPrefixes(prefixes: Record<string, string>): Promise<CommandResult>;
    /** Store the views of an HTML export, in order (manifest of the primary workspace file; saved with it). No undo step. */
    setExportViews(ids: string[]): Promise<CommandResult>;
    /** Remove an entry of the patch queue without applying it. */
    dismissMigration(id: string): Promise<void>;
    /** Write what is not written yet (after a failed write) and commit it. */
    save(): Promise<CommandResult>;
    /** Undo or redo one step. A step that changes a protected file is refused (`protected`: the files); it stays on its stack. */
    undo(): Promise<CommandResult>;
    redo(): Promise<CommandResult>;
    execute(command: EditCommand): Promise<CommandResult>;
}

export interface ModelClient {
    onDidChange(snapshot: ModelSnapshot): void;
}

