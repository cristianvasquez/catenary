// What the backend sends to the frontend after each change.

import type { Classes } from './metamodel';
import type { Migration } from './shapes-doc';

/** Metamodel without the shapes dataset (the dataset stays in the backend). */
export interface MetamodelInfo extends Classes {
    source?: string;
}

/** The extension of a view file: TriG with one graph, named by the view IRI (ADR 0011). */
export const VIEW_EXT = '.view.trig';
/** A view file is never a workspace file or another model file. */
export const isViewFile = (file: string) => file.toLowerCase().endsWith(VIEW_EXT);

/** A view file (`*.view.trig` in the views folder): one view. */
export interface ViewFileInfo {
    /** View id. */
    view: string;
    path: string;
    /** Not saved, or not on disk yet. */
    dirty: boolean;
    /** A ws:protect glob matches the file: Catenary refuses each change of it. */
    protected?: boolean;
}

/** What a model file contains (ADR 0004: from its triples, not from a role). */
export type FileKind = 'shapes' | 'concepts' | 'instances';

/** A model file: an RDF file of the workspace folder that is not a view file and not the workspace file. */
export interface ModelFileInfo {
    path: string;
    /** Not written yet, or the last write failed. */
    dirty: boolean;
    /** Why the file could not be read. */
    error?: string;
    /** A ws:protect glob matches the file: Catenary refuses each change of its statements. */
    protected?: boolean;
    kinds: FileKind[];
}

/** Where new subjects go, by kind: an absolute file path, or `NEAR_KIND` (near their kind). `instances`: all other subjects. */
export interface PlacementInfo { shapes: string; concepts: string; instances: string }
export const NEAR_KIND = 'near';

/** The files of the open workspace (ADR 0004: the RDF files of the folder of the workspace file). Absolute paths. */
export interface WorkspaceFiles {
    /** The workspace file: the manifest (prefixes, default file, placement, exclude, export list). */
    /** `onDisk` false: the folder was opened without a workspace file; the first change of a setting writes it. */
    workspace?: { path: string; dirty: boolean; onDisk: boolean };
    /** The file for new subjects when "near" finds no file, and whether the manifest sets it (else Catenary proposes it). */
    defaultFile?: { path: string; set: boolean };
    placement?: PlacementInfo;
    /** Globs of the manifest: files that are not model files. */
    exclude?: string[];
    /** Globs of the manifest: protected files. */
    protect?: string[];
    files: ModelFileInfo[];
    views: ViewFileInfo[];
}

/** Why the store changed. files: a file was added, removed or replaced; queue: the patch queue changed; disk: a referenced file appeared or disappeared. */
export type ChangeReason = 'edit' | 'undo' | 'redo' | 'load' | 'files' | 'save' | 'validation' | 'shapes' | 'queue' | 'disk';

/** The last change of the store (`ModelSnapshot.change`): panels skip a read that the change cannot affect. */
export interface SnapshotChange {
    reason: ChangeReason;
    /** edit, undo, redo: views whose view graph changed. */
    views?: string[];
    /** edit, undo, redo: instances in changed model statements. */
    elements?: string[];
    /** edit, undo, redo: a shapes graph or the SKOS vocabulary changed. */
    shapes?: boolean;
    /** edit, undo, redo: only the geometry or the style of placements changed (position, size, color, display, sides). */
    layout?: boolean;
}

/**
 * The change cannot change what a model panel shows (explorer, search, links, problems, actions): a write of the files, a move, resize or
 * style change of placements, or (`violations` false: the panel does not show violations) a new validation report.
 */
export function panelsUnchanged(change: SnapshotChange | undefined, violations = false): boolean {
    if (!change) return false;
    if (change.reason === 'save') return true;
    if (change.reason === 'validation') return !violations;
    return (change.reason === 'edit' || change.reason === 'undo' || change.reason === 'redo') && !!change.layout;
}

export interface ModelSnapshot {
    revision: number;
    /** The change that made this snapshot. Undefined: the first snapshot. */
    change?: SnapshotChange;
    /** File system path of the primary workspace file, if one is open. */
    file?: string;
    files: WorkspaceFiles;
    /** Changes each time the shapes are read. The frontend then reads them again with `shapesText`. */
    shapesVersion: number;
    meta: MetamodelInfo;
    /** Counts of the store: instances, and the results of the SHACL report (all, and with severity sh:Violation). */
    counts: { instances: number; results: number; violations: number };
    warnings: string[];
    /** The patch queue: data changes that shape edits ask for, to apply or dismiss. Not saved. */
    migrations: Migration[];
    /**
     * Old id -> new id, for the view, instance, node shape or value set whose IRI the last change changed (Set IRI, its undo or redo).
     * View editors reopen on the new view id; the selection follows the new ids.
     */
    movedIds: Record<string, string>;
    /** Prefix table in use. `stored`: the primary workspace file declares it; else it is the default table, not in the file. */
    prefixes: { table: Record<string, string>; stored: boolean };
    /** View ids of the last HTML export of the workspace, in export order (manifest ws:exportViews). Undefined: none stored. */
    exportViews?: string[];
    dirty: boolean;
    canUndo: boolean;
    canRedo: boolean;
}
