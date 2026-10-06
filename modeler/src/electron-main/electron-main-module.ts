// Electron main process (ADR 0005). Theia forks the backend and ignores its exit after the start: the app then keeps running without
// a backend, and each new window (also from a second launch, which Theia hands to this instance) shows a spinner forever.
// Here the app shows why and quits when the backend process ends while the app is not quitting.
// One window per process: the backend holds one ModelStore, so two windows in one process would share one model. A request for a
// second window (File → New Window, a workspace opened in a new window, a second launch) starts a new process with the Electron
// profile of the workspace (the same rule as scripts/desktop.sh). Electron is single-instance per profile: a request for the
// workspace of an open process focuses that window.

import { app, BrowserWindow, dialog } from '@theia/core/electron-shared/electron';
import { ElectronMainWindowService } from '@theia/core/lib/electron-common/electron-main-window-service';
import { WindowSearchParams } from '@theia/core/lib/common/window';
import { ElectronMainApplication } from '@theia/core/lib/electron-main/electron-main-application';
import { ElectronMainWindowServiceImpl } from '@theia/core/lib/electron-main/electron-main-window-service-impl';
import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { createHash } from 'crypto';
import { fork, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The Electron profile of a workspace. Keep equal to scripts/desktop.sh. An empty path is a window without a workspace. */
export function profileDir(workspace: string): string {
    const base = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'catenary', 'profiles');
    if (!workspace) return path.join(base, 'no-workspace');
    return path.join(base, createHash('sha256').update(workspace).digest('hex').slice(0, 16));
}

/** The arguments of a new process on `workspace`: this process's arguments without its workspace and its --user-data-dir. */
export function childArgs(argv: string[], defaultApp: boolean, workspace: string): string[] {
    const rest = argv.slice(1);
    const appPath = defaultApp ? rest.splice(0, 1) : [];
    const firstPositional = rest.findIndex(a => !a.startsWith('-'));
    if (firstPositional >= 0) rest.splice(firstPositional, 1);
    const flags = rest.filter(a => !a.startsWith('--user-data-dir'));
    return [...appPath, ...(workspace ? [workspace] : []), ...flags, `--user-data-dir=${profileDir(workspace)}`];
}

@injectable()
export class CatenaryElectronMainApplication extends ElectronMainApplication {
    protected quitting = false;

    protected override async startBackend(): Promise<number> {
        if (process.argv.includes('--no-cluster')) return super.startBackend();
        process.env.THEIA_ELECTRON_VERSION = process.versions.electron;
        app.on('before-quit', () => { this.quitting = true; });
        const backend = fork(this.globals.THEIA_BACKEND_MAIN_PATH, this.processArgv.getProcessArgvWithoutBin(), await this.getForkOptions());
        // The backend is a process group leader (detached): kill it when the app quits.
        app.on('quit', () => {
            if (backend.exitCode !== null || backend.signalCode !== null || !backend.pid) return;
            try { process.kill(backend.pid); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
        });
        return new Promise((resolve, reject) => {
            let started = false;
            backend.on('message', (address: { port: number }) => { started = true; resolve(address.port); });
            backend.on('error', reject);
            backend.on('exit', (code, signal) => {
                if (!started) return reject(code);
                if (this.quitting) return;
                this.backendStopped(code, signal);
            });
        });
    }

    override async openDefaultWindow(params?: WindowSearchParams): Promise<BrowserWindow> {
        if (this.hasWindow()) return this.openInProcess('');
        return super.openDefaultWindow(params);
    }

    protected override async openWindowWithWorkspace(workspacePath: string): Promise<BrowserWindow> {
        if (this.hasWindow()) return this.openInProcess(workspacePath);
        return super.openWindowWithWorkspace(workspacePath);
    }

    /** A window shows, or the initial window waits for its first use. */
    protected hasWindow(): boolean {
        return !this.initialWindow && this.windows.size > 0;
    }

    /** Focuses this process's window if `workspace` belongs to its profile. Otherwise starts a new process on `workspace`. */
    openInProcess(workspace: string): BrowserWindow {
        const window = this.windows.get(this.activeWindowStack[0])?.window ?? [...this.windows.values()][0].window;
        if (path.resolve(profileDir(workspace)) !== path.resolve(app.getPath('userData'))) {
            fs.mkdirSync(profileDir(workspace), { recursive: true });
            if (workspace) fs.writeFileSync(path.join(profileDir(workspace), 'workspace'), workspace + '\n');
            const log = process.env.CATENARY_BACKEND_LOG;
            // Not the inherited stdio: this process can end first, and a closed pipe stops the new process (SIGPIPE).
            const out = log ? fs.openSync(log, 'a') : 'ignore';
            spawn(process.execPath, childArgs(process.argv, !!process.defaultApp, workspace), { cwd: process.cwd(), detached: true, stdio: ['ignore', out, out] }).unref();
            if (typeof out === 'number') fs.closeSync(out);
            console.log(`[catenary] started a new process on ${workspace || 'no workspace'}`);
            return window;
        }
        if (window.isMinimized()) window.restore();
        window.focus();
        return window;
    }

    protected backendStopped(code: number | null, signal: NodeJS.Signals | null): void {
        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        console.error(`[catenary] The backend process stopped (${reason}). The app quits.`);
        dialog.showErrorBox('Catenary: the backend stopped',
            `The backend process stopped (${reason}). Changes that were not saved are lost. Catenary quits; start it again.\n\n`
            + `Backend output: ${process.env.CATENARY_BACKEND_LOG ?? 'the terminal that started Catenary'}`);
        this.quitting = true;
        app.quit();
    }
}

/** A workspace opened in a new window goes to its own process (CatenaryElectronMainApplication.openInProcess). */
@injectable()
export class CatenaryElectronMainWindowService extends ElectronMainWindowServiceImpl {
    @inject(ElectronMainApplication) protected readonly catenaryApp: CatenaryElectronMainApplication;

    override openNewWindow(url: string, options: { external?: boolean }): undefined {
        const hash = options.external ? '' : new URL(url).hash.slice(1);
        if (!hash) return super.openNewWindow(url, options);
        this.catenaryApp.openInProcess(decodeURI(hash));
        return undefined;
    }
}

export default new ContainerModule((_bind, _unbind, _isBound, rebind) => {
    rebind(ElectronMainApplication).to(CatenaryElectronMainApplication).inSingletonScope();
    rebind(ElectronMainWindowService).to(CatenaryElectronMainWindowService).inSingletonScope();
});
