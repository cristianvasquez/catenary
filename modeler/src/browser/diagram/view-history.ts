// Back and forward between the views the user went to, as a web browser. Mouse buttons 4 and 5, Alt+Left and Alt+Right,
// and the arrows in the view editor toolbar.

import { Emitter } from '@theia/core';
import { ApplicationShell, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { GLSPDiagramWidget } from '@eclipse-glsp/theia-integration';
import { VIEW_SCHEME } from '../../common/protocol';
import { ModelFrontend } from '../model-client';
import { ViewEditors } from './view-editors';

const MAX = 50;

@injectable()
export class ViewHistory implements FrontendApplicationContribution {
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;

    protected readonly backStack: string[] = [];
    protected readonly forwardStack: string[] = [];
    protected current?: string;
    /** True while back or forward opens a view: that change is not a new history entry. */
    protected moving = false;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange = this.onDidChangeEmitter.event;

    onStart(): void {
        this.editors.onDidChangeCurrentView(view => {
            // No view editor visible (all closed): keep the history.
            if (!view || view === this.current) return;
            if (!this.moving && this.current) {
                this.backStack.push(this.current);
                if (this.backStack.length > MAX) this.backStack.shift();
                this.forwardStack.length = 0;
            }
            this.current = view;
            this.onDidChangeEmitter.fire();
        });
        // Capture phase on window: before the listener of Theia on document.body, which moves in the text editor history.
        window.addEventListener('mousedown', e => this.onMouse(e, true), true);
        // Mouse up: a browser (not Electron) goes back in its own page history if not prevented.
        window.addEventListener('mouseup', e => this.onMouse(e, false), true);
    }

    protected onMouse(e: MouseEvent, run: boolean): void {
        if (e.button !== 3 && e.button !== 4) return;
        if (!this.handlesMouse()) return;
        e.preventDefault();
        e.stopPropagation();
        if (run) e.button === 3 ? this.back() : this.forward();
    }

    /** Mouse navigation is ours when the main area shows a view editor, else Theia moves in the text editor history. */
    protected handlesMouse(): boolean {
        const w = this.shell.currentWidget;
        return !w || (w instanceof GLSPDiagramWidget && w.uri.scheme === VIEW_SCHEME) || !this.shell.getWidgets('main').includes(w);
    }

    canGoBack(): boolean {
        return this.backStack.some(id => this.exists(id));
    }

    canGoForward(): boolean {
        return this.forwardStack.some(id => this.exists(id));
    }

    back(): Promise<void> {
        return this.move(this.backStack, this.forwardStack);
    }

    forward(): Promise<void> {
        return this.move(this.forwardStack, this.backStack);
    }

    /** Open the last view of `from` that still exists. Views deleted since are dropped; a view with a new IRI is followed. */
    protected async move(from: string[], to: string[]): Promise<void> {
        let target: string | undefined;
        while (from.length && !target) target = this.resolve(from.pop()!);
        if (!target) { this.onDidChangeEmitter.fire(); return; }
        if (this.current) to.push(this.current);
        this.moving = true;
        try {
            await this.editors.open(target);
        } finally {
            this.moving = false;
        }
        // The current view event can come before open resolves, or not at all (the view was already current).
        this.current = target;
        this.onDidChangeEmitter.fire();
    }

    protected exists(id: string): boolean {
        return !!this.resolve(id);
    }

    protected resolve(id: string): string | undefined {
        const { files, movedIds } = this.model.snapshot;
        const exists = (v: string) => files.views.some(f => f.view === v);
        if (exists(id)) return id;
        const moved = movedIds[id];
        return moved && exists(moved) ? moved : undefined;
    }
}
