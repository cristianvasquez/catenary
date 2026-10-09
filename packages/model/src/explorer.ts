// The Model explorer (ADR 0006): sections from plugins (@catenary/explorer). The backend gives the children of a key when a folder
// opens, one page at a time. Keys: '<plugin id>/<plugin key>'.

import type { ExplorerRow } from '@catenary/explorer';
export type { ExplorerPath, ExplorerRow } from '@catenary/explorer';

/** Rows of one folder per request. */
export const EXPLORER_PAGE = 100;

/** One page of the children of a key: `total` counts all children. */
export interface ExplorerPage { rows: ExplorerRow[]; total: number }

/** A drag describes all selected folders, not their currently visible children. */
export interface ExplorerDrag { file?: string; ids: string[]; folders: string[] }
export const EXPLORER_DRAG = 'application/x-catenary-explorer';
