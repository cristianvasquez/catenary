import { ApplicationShell, SplitPanel } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';

type Side = 'left' | 'right';
const SIDES: Side[] = ['left', 'right'];

/**
 * Side panel widths. A tiling window manager (for example Niri) can resize the window after the shell restored the layout. The shell
 * restores the stored widths against the window width of that moment, and the split layout gives all later extra width to the main
 * area. The side panels then stay narrow. This class keeps the width of each side panel (the stored width, the default width, or the
 * width of the last sash drag) and widens a panel to that width again when the window size changes.
 */
@injectable()
export class SidePanelSizes {
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    /** The width of each side. Undefined: the default width for the current window width. */
    protected readonly target = new Map<Side, number | undefined>();
    protected timer: number | undefined;

    /** Call after the shell restored or created the layout. `fresh`: a new layout, without stored widths. */
    start(fresh: boolean): void {
        for (const side of SIDES) this.target.set(side, fresh ? undefined : this.handler(side).state.lastPanelSize);
        this.apply(fresh);
        window.addEventListener('resize', () => {
            window.clearTimeout(this.timer);
            this.timer = window.setTimeout(() => this.apply(), 100);
        });
        const split = this.handler('left').container.parent;
        if (split instanceof SplitPanel) split.node.addEventListener('pointerdown', e => this.onSashDown(split, e), true);
    }

    /**
     * Widens each open side panel that is narrower than its width. `exact`: also narrows wider panels. The split layout limits the width
     * to the free space.
     */
    protected apply(exact = false): void {
        for (const side of SIDES) {
            const handler = this.handler(side);
            if (handler.dockPanel.isHidden) continue;
            const width = this.target.get(side) ?? this.defaultWidth(side);
            const current = handler.container.node.offsetWidth;
            if (current < width - 1 || exact && current > width + 1) this.shell.resize(width, side);
        }
    }

    protected defaultWidth(side: Side): number {
        const width = window.innerWidth;
        return Math.round(side === 'left' ? Math.min(280, width * 0.2) : Math.min(320, width * 0.24));
    }

    /** A sash drag sets the width of its side panel. */
    protected onSashDown(split: SplitPanel, event: PointerEvent): void {
        const handle = split.handles.indexOf(event.target as HTMLDivElement);
        if (handle < 0) return;
        const side = SIDES.find(s => {
            const index = split.widgets.indexOf(this.handler(s).container);
            return s === 'left' ? handle === index : handle === index - 1;
        });
        if (!side) return;
        document.addEventListener('pointerup', () => {
            const handler = this.handler(side);
            if (!handler.dockPanel.isHidden) this.target.set(side, handler.container.node.offsetWidth);
        }, { once: true, capture: true });
    }

    protected handler(side: Side): ApplicationShell['leftPanelHandler'] {
        return side === 'left' ? this.shell.leftPanelHandler : this.shell.rightPanelHandler;
    }
}
