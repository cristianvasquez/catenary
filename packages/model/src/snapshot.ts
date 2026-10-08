// What the backend sends to the frontend after each change.

import type { Classes } from './metamodel';
import type { Migration } from './shapes-doc';

/** Metamodel without the shapes dataset (the dataset stays in the backend). */
export interface MetamodelInfo extends Classes {
    source?: string;
}

/**
 * The extension of the view files that Catenary names (a view file: TriG with one graph, named by the view IRI, ADR 0011). A view file
 * can have any `.trig` name: the read finds a view by the content of the file.
 */
export const VIEW_EXT = '.view.trig';
/** A `*.view.trig` file is a view file, never a workspace file or another model file. A file with another name can be a view file too. */
export const isViewFile = (file: string) => file.toLowerCase().endsWith(VIEW_EXT);

/** A view file (a TriG file that declares one view, any name): one view. */
export interface ViewFileInfo {
    /** View id. */
    view: string;
    path: string;
    /** Not saved, or not on disk yet. */
    dirty: boolean;
    /** A ws:imported glob matches the file: it is read only, and Catenary refuses each change of it. */
    imported?: boolean;
}

/** What a file holds that Catenary edits, from its content, not its name. A file can hold a workspace, views, both or none. */
export interface FileContent {
    /** It has the manifest graph: a workspace file. */
    workspace: boolean;
    /** The views that it declares. */
    views: { id: string; label: string }[];
    /** With views: the workspace that reads the file (the open one, else the nearest folder above with one workspace file). */
    workspaceFile?: string;
    /** Why the file is not RDF that Catenary reads. */
    error?: string;
}

/**
 * Why a file opens as text although it holds something that Catenary edits, or undefined. A file with the workspace settings and a
 * view: neither opens (a save of one part must not change the other; open.md D7).
 */
export function mixedFileProblem(c: FileContent): string | undefined {
    return c.workspace && c.views.length ? 'This file mixes workspace settings and a view. Move the view into its own file.' : undefined;
}

/** How a file can open: as its workspace, or as one of its views. None: it opens as text (a plain file, or `mixedFileProblem`). */
export type OpenMode = { kind: 'workspace' } | { kind: 'view'; id: string; label: string };
export function openModes(c: FileContent): OpenMode[] {
    if (mixedFileProblem(c)) return [];
    return [...(c.workspace ? [{ kind: 'workspace' } as const] : []), ...c.views.map(v => ({ kind: 'view' as const, ...v }))];
}

/**
 * The open modes of a preview (a file selected while browsing the navigator): the ones that stay in the open workspace `openFile`.
 * Switching to another workspace needs an explicit open (double-click or Enter). `file`: the path of the file.
 */
export function previewModes(c: FileContent, file: string, openFile?: string): OpenMode[] {
    return openModes(c).filter(m => (m.kind === 'workspace' ? file : c.workspaceFile) === openFile && openFile !== undefined);
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
    /** A ws:imported glob matches the file: it is read only, and Catenary refuses each change of its statements. */
    imported?: boolean;
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
    /** Globs of the manifest: imported (read-only) files. */
    imported?: string[];
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
