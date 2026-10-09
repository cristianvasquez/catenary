// The Trace panel (bottom area, next to the terminal): what the backend ran, what caused it and how long it took. It records only
// while it is visible: it asks the backend for the trace (ModelService.setTracing) when it shows, reads new spans once per second, and
// stops the trace when it hides or closes. Summary: totals by kind and name (calls, calls per minute, time, size). Timeline: the recent
// operations as a tree of causes.

import { AbstractViewContribution, ReactWidget, codicon } from '@theia/core/lib/browser';
import { Message } from '@theia/core/shared/@lumino/messaging';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { TRACE_KINDS, TraceSpan, TraceStat } from '@catenary/model';
import { ModelService } from '../../common/protocol';
import { ModelServiceProxy } from '../model-client';
import { FrontendTrace } from './frontend-trace';
import { addStats, sessionStats, statKey } from './trace-stats';

export const TRACE_ID = 'catenary-trace';

/** Time between two reads of the backend trace (ms). */
const POLL_MS = 1000;
/** Spans kept in the panel. */
const KEEP = 3000;
/** Rows shown in the summary and in the timeline. */
const SHOW = 400;

type StatKind = TraceStat['kind'];
type SortKey = 'kind' | 'name' | 'calls' | 'rate' | 'totalMs' | 'avg' | 'maxMs' | 'size';
const COLUMNS: { key: SortKey; label: string; title: string; numeric?: boolean }[] = [
    { key: 'kind', label: 'Kind', title: 'What the row measures' },
    { key: 'name', label: 'Name', title: 'Request, command, query (IRIs, literals and numbers replaced) or match pattern' },
    { key: 'calls', label: 'Calls', title: 'Number of calls while the panel recorded', numeric: true },
    { key: 'rate', label: '/min', title: 'Calls per minute of recording', numeric: true },
    { key: 'totalMs', label: 'Total ms', title: 'Sum of the durations', numeric: true },
    { key: 'avg', label: 'Avg ms', title: 'Mean duration', numeric: true },
    { key: 'maxMs', label: 'Max ms', title: 'Longest call', numeric: true },
    { key: 'size', label: 'Size', title: 'Sum of rows (queries), bytes (snapshots, round trips) or data triples (validation)', numeric: true }
];

const ms = (n: number) => n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
const clock = (t: number) => {
    const d = new Date(t);
    return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};
const size = (n?: number) => n === undefined ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : String(n);

@injectable()
export class TraceWidget extends ReactWidget {
    @inject(ModelServiceProxy) protected readonly service: ModelService;
    @inject(FrontendTrace) protected readonly local: FrontendTrace;

    protected recording = false;
    protected paused = false;
    protected timer?: ReturnType<typeof setInterval>;
    /** Counts the starts: the async steps of a start that a stop or a newer start replaced do nothing. */
    protected session = 0;
    /** A poll waits for its answer: the next poll is skipped (two polls would read the same spans). */
    protected polling = false;
    /** The `seq` of the last backend batch. */
    protected seq = 0;
    protected spans: TraceSpan[] = [];
    /**
     * Totals of the current session, and of the sessions before it. The backend totals are shared with other connections that trace:
     * a session counts from the backend totals at its start (`baseline`), see trace-stats.ts.
     */
    protected live: TraceStat[] = [];
    protected kept: TraceStat[] = [];
    protected baseline: TraceStat[] = [];
    /** Time of recording (ms): before the current recording, and the start of the current one. */
    protected recordedMs = 0;
    protected recordingSince = 0;
    protected dropped = 0;
    protected error?: string;

    protected mode: 'summary' | 'timeline' = 'summary';
    protected kind: StatKind | '' = '';
    protected sort: { key: SortKey; desc: boolean } = { key: 'totalMs', desc: true };
    protected readonly open = new Set<number>();

    @postConstruct()
    protected init(): void {
        this.id = TRACE_ID;
        this.title.label = 'Trace';
        this.title.caption = 'Requests, queries, validation and refreshes of the backend (records while visible)';
        this.title.iconClass = codicon('pulse');
        this.title.closable = true;
        this.addClass('catenary-trace');
        this.toDispose.push({ dispose: () => this.stop() });
        this.update();
    }

    // Record only while visible: a hidden tab or a collapsed bottom panel stops the trace in the backend.
    protected override onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        if (this.isVisible) this.start();
    }
    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        this.start();
    }
    protected override onAfterHide(msg: Message): void {
        super.onAfterHide(msg);
        this.stop();
    }
    protected override onBeforeDetach(msg: Message): void {
        this.stop();
        super.onBeforeDetach(msg);
    }

    protected start(): void {
        if (this.recording || this.paused) return;
        this.recording = true;
        this.recordingSince = Date.now();
        this.local.on = true;
        void this.begin(++this.session);
        this.update();
    }

    /**
     * Read the backend totals and the last span number first: what another connection recorded while this panel was hidden is not
     * part of this session. Then start the trace and the polls.
     */
    protected async begin(session: number): Promise<void> {
        try {
            const before = await this.service.trace(this.seq);
            if (session !== this.session || !this.recording) return;
            this.seq = before.seq;
            this.baseline = before.stats;
            await this.service.setTracing(true);
            if (session !== this.session || !this.recording) return;
            clearInterval(this.timer);
            this.timer = setInterval(() => this.poll(), POLL_MS);
            await this.poll();
        } catch (e) {
            this.fail(e);
        }
    }

    protected stop(): void {
        if (!this.recording) return;
        this.recording = false;
        this.recordedMs += Date.now() - this.recordingSince;
        clearInterval(this.timer);
        this.local.on = false;
        this.kept = addStats(this.kept, this.live);
        this.live = [];
        this.service.setTracing(false).catch(e => this.fail(e));
        this.update();
    }

    protected async poll(): Promise<void> {
        if (!this.recording || this.polling) return;
        this.polling = true;
        const session = this.session;
        try {
            const batch = await this.service.trace(this.seq);
            if (!this.recording || session !== this.session) return;
            this.seq = batch.seq;
            this.live = sessionStats(batch.stats, this.baseline);
            this.dropped += batch.dropped;
            this.error = undefined;
            const fresh = [...batch.spans, ...this.local.take()];
            if (fresh.length) this.spans = [...this.spans, ...fresh].slice(-KEEP);
        } catch (e) {
            this.fail(e);
        } finally {
            this.polling = false;
        }
        this.update();
    }

    protected fail(e: unknown): void {
        this.error = e instanceof Error ? e.message : String(e);
        this.update();
    }

    protected clear(): void {
        this.spans = [];
        this.kept = [];
        this.live = [];
        this.baseline = [];
        this.dropped = 0;
        this.open.clear();
        this.recordedMs = 0;
        this.recordingSince = Date.now();
        this.local.clear();
        void this.service.clearTrace();
        this.update();
    }

    protected togglePause(): void {
        this.paused = !this.paused;
        if (this.paused) this.stop();
        else if (this.isVisible) this.start();
        this.update();
    }

    protected minutes(): number {
        return Math.max(1 / 60, (this.recordedMs + (this.recording ? Date.now() - this.recordingSince : 0)) / 60000);
    }

    protected render(): React.ReactNode {
        return <>
            {this.renderToolbar()}
            <div className='catenary-trace-body'>{this.mode === 'summary' ? this.renderSummary() : this.renderTimeline()}</div>
        </>;
    }

    protected renderToolbar(): React.ReactNode {
        const state = this.paused ? 'paused' : this.recording ? 'recording' : 'stopped (hidden)';
        return <div className='catenary-trace-toolbar'>
            <div className='catenary-trace-tabs' role='tablist'>
                {(['summary', 'timeline'] as const).map(m =>
                    <button key={m} role='tab' aria-selected={this.mode === m} className={this.mode === m ? 'active' : ''}
                        onClick={() => { this.mode = m; this.update(); }}>{m === 'summary' ? 'Summary' : 'Timeline'}</button>)}
            </div>
            <select value={this.kind} title='Show one kind' onChange={e => { this.kind = e.target.value as StatKind | ''; this.update(); }}>
                <option value=''>All kinds</option>
                {[...TRACE_KINDS, 'match' as const].map(k => <option key={k} value={k}>{k}</option>)}
            </select>
            <button className='theia-button secondary' onClick={() => this.togglePause()} title={this.paused ? 'Record again' : 'Stop recording'}>
                <span className={codicon(this.paused ? 'debug-start' : 'debug-pause')} /> {this.paused ? 'Resume' : 'Pause'}
            </button>
            <button className='theia-button secondary' onClick={() => this.clear()} title='Remove the spans and the totals'>
                <span className={codicon('clear-all')} /> Clear
            </button>
            <span className={`catenary-trace-state ${this.recording ? 'on' : ''}`}>
                {state} · {this.spans.length} spans{this.dropped ? ` · ${this.dropped} dropped` : ''}
            </span>
            {this.error && <span className='catenary-trace-error'>{this.error}</span>}
        </div>;
    }

    protected rows(): (TraceStat & { rate: number; avg: number })[] {
        const minutes = this.minutes();
        const all = addStats(addStats(this.kept, this.live), this.local.stats())
            .filter(s => !this.kind || s.kind === this.kind)
            .map(s => ({ ...s, rate: s.calls / minutes, avg: s.totalMs / s.calls }));
        const { key, desc } = this.sort;
        const sign = desc ? -1 : 1;
        return all.sort((a, b) => {
            const x = a[key], y = b[key];
            return sign * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)));
        }).slice(0, SHOW);
    }

    protected renderSummary(): React.ReactNode {
        const rows = this.rows();
        if (!rows.length) return <div className='catenary-trace-empty'>{this.recording ? 'Nothing recorded yet. Work in the model to see what runs.' : 'Not recording.'}</div>;
        const setSort = (key: SortKey) => {
            this.sort = this.sort.key === key ? { key, desc: !this.sort.desc } : { key, desc: !!COLUMNS.find(c => c.key === key)?.numeric };
            this.update();
        };
        return <table className='catenary-trace-table'>
            <thead><tr>{COLUMNS.map(c =>
                <th key={c.key} title={c.title} className={c.numeric ? 'num' : ''} onClick={() => setSort(c.key)}>
                    {c.label}{this.sort.key === c.key ? (this.sort.desc ? ' ▾' : ' ▴') : ''}
                </th>)}
            </tr></thead>
            <tbody>{rows.map(r =>
                <tr key={statKey(r)}>
                    <td><span className={`catenary-trace-kind k-${r.kind}`}>{r.kind}</span></td>
                    <td className='name' title={r.name}>{r.name}</td>
                    <td className='num'>{r.calls}</td>
                    <td className='num'>{r.rate.toFixed(1)}</td>
                    <td className='num'>{ms(r.totalMs)}</td>
                    <td className='num'>{ms(r.avg)}</td>
                    <td className='num'>{ms(r.maxMs)}</td>
                    <td className='num'>{size(r.size || undefined)}</td>
                </tr>)}
            </tbody>
        </table>;
    }

    protected renderTimeline(): React.ReactNode {
        const ids = new Set(this.spans.map(s => s.id));
        const children = new Map<number, TraceSpan[]>();
        for (const s of this.spans) {
            if (s.parent === undefined || !ids.has(s.parent)) continue;
            const list = children.get(s.parent);
            if (list) list.push(s); else children.set(s.parent, [s]);
        }
        // With a kind: the spans of that kind, flat. Without: the operations whose cause is not in the panel, with their effects below.
        const top = (this.kind ? this.spans.filter(s => s.kind === this.kind) : this.spans.filter(s => s.parent === undefined || !ids.has(s.parent)))
            .sort((a, b) => b.start - a.start).slice(0, SHOW);
        if (!top.length) return <div className='catenary-trace-empty'>{this.recording ? 'Nothing recorded yet. Work in the model to see what runs.' : 'Not recording.'}</div>;
        const row = (s: TraceSpan, depth: number): React.ReactNode => {
            const kids = this.kind ? undefined : children.get(s.id)?.sort((a, b) => a.start - b.start);
            const isOpen = this.open.has(s.id);
            const toggle = () => { if (isOpen) this.open.delete(s.id); else this.open.add(s.id); this.update(); };
            return <React.Fragment key={s.id}>
                <div className={`catenary-trace-span${s.error ? ' error' : ''}`} style={{ paddingLeft: 4 + depth * 14 }}>
                    <span className={`caret ${kids ? codicon(isOpen ? 'chevron-down' : 'chevron-right') : ''}`} onClick={kids ? toggle : undefined} />
                    <span className='time'>{clock(s.start)}</span>
                    <span className={`catenary-trace-kind k-${s.kind}`}>{s.kind}</span>
                    <span className='name' title={s.name}>{s.name}</span>
                    <span className='num' title='Duration (ms)'>{ms(s.ms)} ms</span>
                    <span className='num muted' title='Quad-store calls in this span and its effects: count, time (ms)'>
                        {s.queries ? `${s.queries} q · ${ms(s.queryMs ?? 0)} ms` : ''}
                    </span>
                    <span className='num muted' title='Rows, bytes or triples'>{size(s.size)}</span>
                    {kids && <span className='muted'>{kids.length} effects</span>}
                    {s.detail && <span className='detail' title={s.detail}>{s.detail}</span>}
                </div>
                {kids && isOpen && kids.map(k => row(k, depth + 1))}
            </React.Fragment>;
        };
        return <div className='catenary-trace-timeline'>{top.map(s => row(s, 0))}</div>;
    }
}

/** View → Trace: the panel in the bottom area. */
@injectable()
export class TraceContribution extends AbstractViewContribution<TraceWidget> {
    constructor() {
        super({
            widgetId: TRACE_ID, widgetName: 'Trace',
            defaultWidgetOptions: { area: 'bottom' },
            toggleCommandId: 'catenary.toggleTrace'
        });
    }
}
