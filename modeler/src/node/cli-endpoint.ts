// HTTP endpoint of the command-line interface (scripts/catenary.mjs). See common/cli-protocol.ts.
// At start, writes a discovery file (port, token) to $XDG_RUNTIME_DIR/catenary/<pid>.json; the CLI finds the backend with it.

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as http from 'http';
import type { AddressInfo } from 'net';
import * as express from '@theia/core/shared/express';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { inject, injectable } from '@theia/core/shared/inversify';
import { MODEL_QUERIES } from '@catenary/model';
import { ModelStore } from '@catenary/rdf';
import { CLI_HTTP_PATH, CliBridgeClient, CliRequest, FRONTEND_METHODS, modelSummary } from '../common/cli-protocol';
import { ModelServiceImpl } from './model-service';

export function discoveryDir(): string {
    return path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'catenary');
}

/** Connected frontend windows, oldest first. */
@injectable()
export class CliWindows {
    readonly list: { client: CliBridgeClient; connectedAt: string }[] = [];

    add(client: CliBridgeClient): void {
        this.list.push({ client, connectedAt: new Date().toISOString() });
    }

    remove(client: CliBridgeClient): void {
        const i = this.list.findIndex(w => w.client === client);
        if (i >= 0) this.list.splice(i, 1);
    }
}

/** Methods of ModelService with their parameter names, read from the compiled class. */
function modelServiceMethods(): Record<string, string[]> {
    const skip = new Set(['constructor', 'init', 'setClient', 'getClient', 'dispose']);
    const methods: Record<string, string[]> = {};
    for (const name of Object.getOwnPropertyNames(ModelServiceImpl.prototype)) {
        const fn = (ModelServiceImpl.prototype as unknown as Record<string, unknown>)[name];
        if (skip.has(name) || typeof fn !== 'function') continue;
        const params = /^[^(]*\(([^)]*)\)/.exec(fn.toString())?.[1] ?? '';
        methods[name] = params.split(',').map(p => p.trim().replace(/\s*=.*$/, '')).filter(Boolean);
    }
    // The read queries forward their arguments as a rest parameter: their names come from the declaration.
    for (const [name, params] of Object.entries(MODEL_QUERIES)) methods[name] = [...params];
    return methods;
}

/** Newest modification time (ms) of the files under `dir`, 0 when it does not exist. */
function newestMtime(dir: string): number {
    let newest = 0;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
    }
    return newest;
}

/**
 * Is the running code the current source? The backend runs in the app directory (pnpm start, pnpm desktop). stale: a source file is
 * newer than the build (run pnpm build). restartNeeded: the build is newer than this process. reloadNeeded (per window): the frontend
 * bundle is newer than the window's connection.
 */
function buildInfo(startedAt: string) {
    const app = process.cwd();
    const root = path.dirname(app);
    const mtime = (f: string) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
    const bundle = mtime(path.join(app, 'lib/frontend/bundle.js'));
    const backend = mtime(path.join(app, 'lib/backend/main.js'));
    if (!bundle || !backend) return { root, error: `no build in ${app}/lib`, bundleAt: undefined };
    const builtAt = Math.min(bundle, backend);
    const source = Math.max(...['modeler/src', 'modeler/css', 'packages/model/src', 'packages/rdf/src'].map(d => newestMtime(path.join(root, d))));
    const iso = (ms: number) => new Date(ms).toISOString();
    return {
        root, builtAt: iso(builtAt), sourceChangedAt: iso(source), bundleAt: iso(bundle),
        stale: source > builtAt, restartNeeded: backend > Date.parse(startedAt)
    };
}

/** Value at a dot path ("doc.views", "violations.0"). */
function at(value: unknown, dotPath: string | undefined): unknown {
    if (!dotPath) return value;
    return dotPath.split('.').reduce<unknown>((v, k) => (v !== null && typeof v === 'object') ? (v as Record<string, unknown>)[k] : undefined, value);
}

@injectable()
export class CliEndpoint implements BackendApplicationContribution {
    @inject(ModelStore) protected readonly store: ModelStore;
    @inject(ModelServiceImpl) protected readonly service: ModelServiceImpl;
    @inject(CliWindows) protected readonly windows: CliWindows;

    protected readonly token = randomBytes(24).toString('hex');
    protected readonly startedAt = new Date().toISOString();

    configure(app: express.Application): void {
        app.post(CLI_HTTP_PATH, express.json({ limit: '20mb' }), async (req, res) => {
            if (req.headers.authorization !== `Bearer ${this.token}`) {
                res.status(401).json({ error: 'wrong or missing token' });
                return;
            }
            try {
                res.json((await this.handle(req.body as CliRequest)) ?? null);
            } catch (e) {
                res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
            }
        });
    }

    onStart(server: http.Server): void {
        const address = server.address() as AddressInfo | null;
        if (!address || typeof address !== 'object') return;
        const host = ['::', '0.0.0.0', '::1'].includes(address.address) ? '127.0.0.1' : address.address;
        const dir = discoveryDir();
        const file = path.join(dir, `${process.pid}.json`);
        try {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host, port: address.port, token: this.token, cwd: process.cwd(), argv: process.argv.slice(2), startedAt: this.startedAt }), { mode: 0o600 });
            process.on('exit', () => { try { fs.unlinkSync(file); } catch { /* already removed */ } });
        } catch (e) {
            console.error(`catenary CLI: cannot write ${file}: ${e}`);
        }
    }

    protected async handle({ method, params = {}, window }: CliRequest): Promise<unknown> {
        switch (method) {
            case 'status': {
                const s = this.store.snapshot();
                const build = buildInfo(this.startedAt);
                return {
                    pid: process.pid, startedAt: this.startedAt, build, model: modelSummary(s), files: s.files,
                    windows: this.windows.list.map((w, index) => ({
                        index, connectedAt: w.connectedAt, reloadNeeded: build.bundleAt ? Date.parse(build.bundleAt) > Date.parse(w.connectedAt) : undefined
                    }))
                };
            }
            case 'model': {
                // The snapshot, and for inspection the view labels and the report of the backend (one view: `rpc view <id>`).
                const s = { ...this.store.snapshot(), views: this.store.reads.viewLabels(), violations: this.store.violations };
                const value = at(s, params.path as string | undefined);
                if (value === undefined) throw new Error(`no value at "${params.path}"`);
                return params.keys && value && typeof value === 'object' ? Object.keys(value) : value;
            }
            case 'rpc': return this.rpc(params.method as string | undefined, (params.args as unknown[] | undefined) ?? []);
        }
        if (!(FRONTEND_METHODS as readonly string[]).includes(method)) {
            throw new Error(`unknown method "${method}"; backend: status, model, rpc; frontend: ${FRONTEND_METHODS.join(', ')}`);
        }
        const windows = this.windows.list;
        const w = window === undefined ? windows[windows.length - 1] : windows[window];
        if (!w) throw new Error(windows.length ? `no window ${window}; windows 0..${windows.length - 1}` : 'no frontend window is connected; open the app in a browser');
        return w.client.request(method, params);
    }

    /** Call a ModelService method. Without a method: the list of methods. */
    protected async rpc(method: string | undefined, args: unknown[]): Promise<unknown> {
        const methods = modelServiceMethods();
        if (!method) return methods;
        if (!methods[method]) throw new Error(`unknown ModelService method "${method}"; methods: ${Object.keys(methods).join(', ')}`);
        const before = modelSummary(this.store.snapshot());
        const fn = (this.service as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
        const result = await fn.apply(this.service, args);
        const after = modelSummary(this.store.snapshot());
        return { result, model: after, changed: after.revision !== before.revision || after.dirty !== before.dirty };
    }
}
