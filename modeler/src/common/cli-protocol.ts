// Protocol of the command-line interface (scripts/catenary.mjs).
// The CLI sends HTTP requests to the backend (CLI_HTTP_PATH, bearer token from the discovery file). The backend answers the model
// requests itself and forwards the UI requests to a connected frontend window over CLI_BRIDGE_PATH, where the frontend is the RPC client.

import type { ModelSnapshot } from '@catenary/model';
import type { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

export const CLI_HTTP_PATH = '/catenary/cli';
export const CLI_BRIDGE_PATH = '/services/catenary-cli';
export const CliBridgeServer = Symbol('CliBridgeServer');

/** Request of the CLI. `method`: a backend method (status, model, rpc) or a frontend method (FRONTEND_METHODS). */
export interface CliRequest {
    method: string;
    params?: Record<string, unknown>;
    /** Index of the frontend window (see status); default: the last connected one. */
    window?: number;
}

/** Methods that the frontend answers. */
export const FRONTEND_METHODS = ['commands', 'run', 'prompt', 'answer', 'ui', 'messages', 'eval'] as const;

export interface CliMessage {
    seq: number;
    type: string;
    text: string;
    actions?: string[];
}

/**
 * An open prompt, which waits for an answer. dialog: Theia dialog; quick-pick, input-box: Theia quick input; picker: the popup list of a
 * view editor; inline: a text input in a card, an edge label or a tab.
 */
export interface CliPrompt {
    kind: 'dialog' | 'quick-pick' | 'input-box' | 'picker' | 'inline';
    title?: string;
    text?: string;
    placeholder?: string;
    value?: string;
    /** Validation message of the dialog or input box. */
    error?: string;
    buttons?: string[];
    items?: { index: number; label: string; description?: string; detail?: string }[];
}

/** Outcome of `run` and `answer`. */
export interface CliRunResult {
    /** done: the command finished; waiting: a prompt is open (the command waits for it, or ended and left an input open); timeout: it still runs; error: it threw. */
    status: 'done' | 'waiting' | 'timeout' | 'error';
    command?: string;
    result?: unknown;
    error?: string;
    prompt?: CliPrompt;
    /** Notifications shown while the command ran. */
    messages: CliMessage[];
    /** The model after the command (see modelSummary); `changed`: revision or dirty state changed. */
    model?: ReturnType<typeof modelSummary>;
    changed?: boolean;
}

/** The frontend window, as RPC client of the backend. */
export interface CliBridgeClient {
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface CliBridgeServer extends RpcServer<CliBridgeClient> {
    hello(): Promise<void>;
}

/** Short state of the model: the feedback of each CLI request that can change it. */
export function modelSummary(s: ModelSnapshot) {
    return {
        revision: s.revision, file: s.file, dirty: s.dirty, canUndo: s.canUndo, canRedo: s.canRedo,
        instances: s.counts.instances, views: s.files.views.length,
        violations: s.counts.results, warnings: s.warnings.length, migrations: s.migrations.length
    };
}
