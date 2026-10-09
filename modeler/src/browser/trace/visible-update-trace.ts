// Two animation frames after a model DOM mutation give a paint opportunity, not proof of screen presentation.
const MODEL = 'svg.sprotty-graph, .catenary-properties, .catenary-links';

export class VisibleUpdateTrace {
    private observer?: MutationObserver;
    private pending?: { start: number; clock: number; name: string };
    private frame = 0;
    private expiry?: ReturnType<typeof setTimeout>;

    constructor(private readonly record: (name: string, start: number, ms: number) => void) {}

    private readonly input = (event: Event) => {
        const target = event.target instanceof Element ? event.target : undefined;
        if (!target?.closest(MODEL) || target.closest('#catenary-trace')) return;
        this.cancel();
        this.pending = { start: Date.now(), clock: performance.now(), name: event.type };
        this.expiry = setTimeout(() => this.cancel(), 5000);
    };

    start(): void {
        if (this.observer) return;
        document.addEventListener('pointerdown', this.input, true);
        document.addEventListener('keydown', this.input, true);
        this.observer = new MutationObserver(records => {
            if (!this.pending || this.frame) return;
            const changed = records.some(r => {
                const node = r.target instanceof Element ? r.target : r.target.parentElement;
                return node && !node.closest('#catenary-trace') && node.closest(MODEL) && node.getClientRects().length > 0;
            });
            if (!changed) return;
            const sample = this.pending;
            this.frame = requestAnimationFrame(() => {
                this.frame = requestAnimationFrame(() => {
                    this.cancel();
                    this.record(sample.name, sample.start, performance.now() - sample.clock);
                });
            });
        });
        this.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    }

    cancel(): void {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        clearTimeout(this.expiry);
        this.pending = undefined;
    }

    stop(): void {
        this.cancel();
        this.observer?.disconnect();
        this.observer = undefined;
        document.removeEventListener('pointerdown', this.input, true);
        document.removeEventListener('keydown', this.input, true);
    }
}
