// Appearance of the selected elements in the view they were selected in: color, size, card display, edge sides, edge visibility.
// The View section acts on the current view editor (Apply Layout, hidden edges), with or without a selection.
// Layout only: nothing here changes the model. The view data (boxes, edge layouts, labels, hidden edges) comes from the backend
// (RPC `appearance`, ADR 0007 step 5); the panel asks again when the selection or the model changes. The Preferences section at the
// end sets user preferences (font sizes, edge style of all views). It is closed by default.

import { CommandRegistry, CommandService } from '@theia/core';
import { AbstractViewContribution, codicon } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { AppearanceData, CardDisplay, EdgeLayout, View, boxOf, cardOf, edgeLayout } from '@catenary/model';
import { Button, Choice, ElementPanel, Head, IconButton, Row, Section, SidePicker, Swatches, TextInput } from './controls';
import { Selected } from '../selection-model';
import { CARD_FONT_SIZE, FONT_DEFAULTS, FONT_MAX, FONT_MIN, FontPreferences, GROUP_FONT_SIZE, NOTE_FONT_SIZE } from '../diagram/font-preferences';
import { EDGE_STYLE_DEFAULT, EdgePreferences } from '../diagram/edge-preferences';
import { LayoutPreferences } from '../diagram/layout-preferences';
import { LAYOUT_ALGORITHMS, LAYOUT_SPACING } from '../../common/protocol';
import { ViewEditors, ViewLabels, viewIdOf } from '../diagram/view-editors';
/** Commands of commands.ts (not imported: commands.ts imports this module). */
const TOGGLE_HIDDEN = 'catenary.toggleHidden', LAYOUT_VIEW = 'catenary.layoutView';
import { EDGE_STYLES, EdgeStyle } from '../diagram/edge-route';

export const APPEARANCE_ID = 'catenary-appearance';

/** The box of a selected element: a card by its element id (`selected` gives elements), another box by its placement id. */
const boxIn = (view: View, id: string) => boxOf(view, id) ?? cardOf(view, id);

function colorIn(view: View, id: string): string | undefined {
    return boxIn(view, id)?.color ?? edgeLayout(view, id)?.color ?? view.arrows.find(a => a.id === id)?.color;
}

/** Name of a selected element kind in the panel head. */
const KINDS: [keyof Selected, string][] = [
    ['instances', 'Card'], ['shapes', 'Node shape card'], ['valueSets', 'Value set card'], ['collections', 'Collection'], ['groups', 'Group'],
    ['notes', 'Note'], ['references', 'View reference'], ['relations', 'Edge'], ['arrows', 'Arrow']
];

const DISPLAYS = [{ value: 'detailed', label: 'Detailed' }, { value: 'simple', label: 'Simple', title: 'Class and name only' }];

/** Smallest width and height that the size fields accept. */
const MIN_SIZE = 40;

/** Route of each edge style, as an icon (16 px box), and what it does. */
const EDGE_ICONS: Record<EdgeStyle, [string, string]> = {
    orthogonal: ['M2 13H8V3h6', 'around the cards'],
    polyline: ['M2 13l5-7 7-3', 'around the cards'],
    curved: ['M2 13C8 13 8 3 14 3', 'around the cards'],
    direct: ['M2 13L14 3', 'from card to card, across boxes']
};

/** Scope tags of the section headings. */
const IN_VIEW = 'saved in this view', ALL_VIEWS = 'all views · not in model';

@injectable()
export class AppearanceWidget extends ElementPanel {
    @inject(FontPreferences) protected readonly fonts: FontPreferences;
    @inject(CommandService) protected readonly commands: CommandService;
    @inject(EdgePreferences) protected readonly edgeStyle: EdgePreferences;
    @inject(LayoutPreferences) protected readonly spacingPreference: LayoutPreferences;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(ViewLabels) protected readonly labels: ViewLabels;
    @inject(CommandRegistry) protected readonly registry: CommandRegistry;

    /** The algorithm of Apply Layout in the View section (this window). */
    protected algorithm: string = LAYOUT_ALGORITHMS[0].id;
    /** Open state of the Preferences section and of the hidden edge list (this window). */
    protected preferencesOpen = false;
    protected hiddenOpen = false;
    /** Message of a rejected width or height, until the next change of the selection or the model. */
    protected sizeProblem?: string;

    constructor() {
        super();
        this.id = APPEARANCE_ID;
        this.title.label = 'Appearance';
        this.title.caption = 'Appearance in the view';
        this.title.iconClass = codicon('symbol-color');
        this.title.closable = true;
    }

    /** Slider values not yet saved, by preference name. */
    protected readonly drafts: Record<string, number> = {};

    protected override init(): void {
        super.init();
        this.toDispose.push(this.fonts.onDidChange(() => {
            for (const name in this.drafts) delete this.drafts[name];
            this.update();
        }));
        this.toDispose.push(this.edgeStyle.onDidChange(() => this.update()));
        this.toDispose.push(this.spacingPreference.onDidChange(() => { this.spacingDraft = undefined; this.update(); }));
        this.toDispose.push(this.editors.onDidChangeCurrentView(() => this.update()));
        const clear = () => { this.sizeProblem = undefined; };
        this.toDispose.push(this.model.onDidChange(clear));
        this.toDispose.push(this.elements.onDidChange(clear));
    }

    protected override footer(): React.ReactNode {
        return <>{this.viewSection()}{this.preferencesSection()}</>;
    }

    /** The current view editor: Apply Layout with its spacing, and the hidden edges of the view (list, Show Hidden Edges of this editor). */
    protected viewSection(): React.ReactNode {
        const w = this.editors.current();
        if (!w) return undefined;
        const viewId = viewIdOf(w);
        const label = this.labels.labels[viewId];
        const sel = this.elements.resolved;
        const hidden = this.dataOf(viewId, sel.view === viewId ? KINDS.flatMap(([k]) => sel[k] as string[]) : [])?.hidden ?? [];
        const shown = this.registry.isToggled(TOGGLE_HIDDEN, w);
        return <Section title={label ? `View · ${label}` : 'View'}>
            <Row label='Layout' inline>
                <div className='catenary-inline'>
                    <Choice value={this.algorithm} options={LAYOUT_ALGORITHMS.map(a => ({ value: a.id, label: a.label, title: a.description }))}
                        onChange={v => { this.algorithm = v; this.update(); }} />
                    <Button label='Apply' kind='primary' title={LAYOUT_ALGORITHMS.find(a => a.id === this.algorithm)?.description}
                        onClick={() => this.commands.executeCommand(LAYOUT_VIEW, w, this.algorithm)} />
                </div>
            </Row>
            {this.spacing()}
            <Row label='Hidden' inline>
                <div className='catenary-inline'>
                    {hidden.length
                        ? <button className='catenary-fold' aria-expanded={this.hiddenOpen} onClick={() => { this.hiddenOpen = !this.hiddenOpen; this.update(); }}>
                            <span className={`codicon codicon-chevron-${this.hiddenOpen ? 'down' : 'right'}`} />{hidden.length} {hidden.length === 1 ? 'edge' : 'edges'}
                        </button>
                        : <span className='catenary-none'>none</span>}
                    <label className='catenary-check' title='Show the hidden edges dashed in this editor. Not stored.'>
                        <input type='checkbox' checked={shown} onChange={async () => { await this.commands.executeCommand(TOGGLE_HIDDEN, w); this.update(); }} />
                        show dashed
                    </label>
                </div>
                {this.hiddenOpen && hidden.length ? this.hiddenList(viewId, hidden) : undefined}
            </Row>
        </Section>;
    }

    /** The hidden edges of a view, each with a Show button, and Show all. */
    protected hiddenList(viewId: string, hidden: AppearanceData['hidden']): React.ReactNode {
        const show = (ids: string[]) => this.exec({ kind: 'hideEdges', view: viewId, ids, hidden: false });
        return <>
            {hidden.map(r => <div key={r.id} className='catenary-value catenary-hidden-edge'>
                <span>{r.label}</span>
                <IconButton icon='eye' title='Show in this view' onClick={() => show([r.id])} />
            </div>)}
            {hidden.length > 1 ? <div className='catenary-buttons'><Button label='Show all' onClick={() => show(hidden.map(r => r.id))} /></div> : undefined}
        </>;
    }

    protected preferencesSection(): React.ReactNode {
        const style = this.edgeStyle.get();
        const reset = () => {
            for (const name of [CARD_FONT_SIZE, GROUP_FONT_SIZE, NOTE_FONT_SIZE]) if (this.fonts.get(name) !== FONT_DEFAULTS[name]) void this.fonts.set(name, undefined);
            if (style !== EDGE_STYLE_DEFAULT) void this.edgeStyle.set(EDGE_STYLE_DEFAULT);
        };
        return <Section title='Preferences' scope={ALL_VIEWS} open={this.preferencesOpen} onToggle={() => { this.preferencesOpen = !this.preferencesOpen; this.update(); }}>
            <div className='catenary-help catenary-subhead'>Text size (px, {FONT_MIN}–{FONT_MAX})</div>
            {this.fontSize('Cards', CARD_FONT_SIZE)}
            {this.fontSize('Groups', GROUP_FONT_SIZE)}
            {this.fontSize('Notes', NOTE_FONT_SIZE)}
            <Row label='Edges' inline>
                <Choice value={style} options={EDGE_STYLES.map(v => ({ value: v, label: v, title: `${v}: ${EDGE_ICONS[v][1]}`, icon: EDGE_ICONS[v][0] }))}
                    onChange={v => this.edgeStyle.set(v as EdgeStyle)} />
                <div className='catenary-help'>{style}: {EDGE_ICONS[style][1]}</div>
            </Row>
            <div className='catenary-buttons'><Button label='Reset to Defaults' onClick={reset} /></div>
        </Section>;
    }

    /** Slider value not yet saved. */
    protected spacingDraft: number | undefined;

    /** Layout spacing (a user preference): slider and number field; the slider saves when released (nothing to preview: layout runs on request). */
    protected spacing(): React.ReactNode {
        const value = this.spacingDraft ?? this.spacingPreference.spacing;
        const release = () => { if (this.spacingDraft !== undefined) this.spacingPreference.setSpacing(this.spacingDraft); };
        return <Row label='Spacing' inline help='All views. Used at the next Apply.'>
            <div className='catenary-slider'>
                <input type='range' min={LAYOUT_SPACING.min} max={LAYOUT_SPACING.max} step={10} value={value} aria-label='Layout spacing' title={`Space between boxes: ${LAYOUT_SPACING.min}–${LAYOUT_SPACING.max} px`}
                    onChange={e => { this.spacingDraft = Number(e.currentTarget.value); this.update(); }}
                    onPointerUp={release} onKeyUp={release} onBlur={release} />
                <TextInput numeric value={String(value)} onCommit={v => {
                    const n = Number(v);
                    if (Number.isInteger(n) && n >= LAYOUT_SPACING.min && n <= LAYOUT_SPACING.max) this.spacingPreference.setSpacing(n);
                    else this.update();
                }} />
            </div>
        </Row>;
    }

    /** Slider and number field. The slider previews while it moves and saves when released. */
    protected fontSize(label: string, name: string): React.ReactNode {
        const value = this.drafts[name] ?? this.fonts.get(name);
        const save = (n: number) => {
            if (n === this.fonts.get(name)) { delete this.drafts[name]; this.update(); return; }
            this.fonts.set(name, n === FONT_DEFAULTS[name] ? undefined : n);
        };
        const release = () => { if (this.drafts[name] !== undefined) save(this.drafts[name]); };
        return <Row label={label} inline>
            <div className='catenary-slider'>
                <input type='range' min={FONT_MIN} max={FONT_MAX} step={1} value={value} aria-label={`${label} text size`}
                    onChange={e => {
                        const n = Number(e.currentTarget.value);
                        this.drafts[name] = n;
                        this.fonts.preview(name, n);
                        this.update();
                    }}
                    onPointerUp={release} onKeyUp={release} onBlur={release} />
                <TextInput numeric value={String(value)} onCommit={v => {
                    const n = Number(v);
                    if (Number.isInteger(n) && n >= FONT_MIN && n <= FONT_MAX) save(n);
                    else this.update();
                }} />
            </div>
        </Row>;
    }

    /** The last answer of the backend for each view and ids, with the request it answers (view, ids, revision). */
    protected readonly answers = new Map<string, { key: string; data?: AppearanceData }>();
    protected readonly requested = new Map<string, string>();

    /** The view data of `viewId` for the selected `ids`, from the backend. Until a new answer arrives, the last one for the same view and ids. */
    protected dataOf(viewId: string, ids: string[]): AppearanceData | undefined {
        const slot = JSON.stringify([viewId, ids]);
        const key = JSON.stringify([viewId, ids, this.model.snapshot.revision]);
        if (this.requested.get(slot) !== key) {
            this.requested.set(slot, key);
            // Keep the slots small: the View section (current view, no ids) and the selection.
            if (this.requested.size > 4) for (const k of [...this.requested.keys()].slice(0, this.requested.size - 4)) { this.requested.delete(k); this.answers.delete(k); }
            void this.model.service.appearance(viewId, ids).catch(() => undefined).then(data => {
                if (this.requested.get(slot) !== key) return;
                this.answers.set(slot, { key, data });
                this.update();
            });
        }
        return this.answers.get(slot)?.data;
    }

    protected body(sel: Selected): React.ReactNode {
        const { view: viewId, instances, relations, views } = sel;
        const all = KINDS.flatMap(([k]) => sel[k] as string[]);
        const none = <div className='catenary-none'>Select an element in a view. Appearance is set per view.</div>;
        if (viewId && all.length) {
            const data = this.dataOf(viewId, all);
            if (!data) return undefined;
            if (all.length === 1 && relations.length === 1) return this.relationPanel(data, relations[0]);
            if (all.length === 1 && instances.length === 1 && !cardOf(data.view, instances[0])) return this.notInViewPanel(data, instances[0]);
            return this.elementsPanel(data, all, [...instances, ...sel.shapes], KINDS.find(([k]) => (sel[k] as string[]).length)![1]);
        }
        const editor = this.editors.current();
        const shown = views.length === 1 ? views[0] : viewId && !instances.length && !relations.length ? viewId : editor ? viewIdOf(editor) : undefined;
        if (!shown) return none;
        const data = this.dataOf(shown, []);
        return data ? this.viewPanel(data) : undefined;
    }

    /** Width and height fields that set the size of all `ids` (setBounds). Different values show as empty. */
    protected sizes(view: View, ids: string[]): React.ReactNode {
        const sized = ids.map(id => boxIn(view, id)).filter(b => !!b);
        if (!sized.length) return undefined;
        const one = (k: 'width' | 'height') => {
            const values = new Set(sized.map(b => b![k]));
            return values.size === 1 ? [...values][0] : undefined;
        };
        const field = (k: 'width' | 'height', value?: number) => <TextInput numeric value={value === undefined ? '' : String(value)} placeholder='mixed' onCommit={v => {
            const n = Number(v);
            if (v.trim() && Number.isFinite(n) && n >= MIN_SIZE) {
                this.sizeProblem = undefined;
                this.exec({ kind: 'setBounds', view: view.id, bounds: ids.filter(id => boxIn(view, id)).map(id => ({ id, [k]: n })) });
            } else {
                this.sizeProblem = `${k === 'width' ? 'Width' : 'Height'}: a number of ${MIN_SIZE} or more.`;
                this.update();
            }
        }} />;
        return <Row label='Size' inline problems={this.sizeProblem ? [this.sizeProblem] : undefined}>
            <div className='catenary-size'>
                <span className='catenary-help' title='Width'>W</span>{field('width', one('width'))}
                <span className='catenary-help' title='Height'>H</span>{field('height', one('height'))}
                <span className='catenary-help'>px</span>
            </div>
        </Row>;
    }

    /** Display of instance and node shape cards: detailed or simple. With different values, no option is marked. */
    protected display(view: View, cards: string[]): React.ReactNode {
        const values = new Set(cards.map(id => cardOf(view, id)).filter(n => !!n).map(n => n!.display ?? 'detailed'));
        if (!values.size) return undefined;
        return <Row label='Display' inline>
            <Choice value={values.size > 1 ? '' : [...values][0]} options={DISPLAYS}
                onChange={v => this.exec({ kind: 'setViewElements', view: view.id, ids: cards, patch: { display: v as CardDisplay } })} />
            {values.size > 1 ? <div className='catenary-help'>mixed</div> : undefined}
        </Row>;
    }

    /** Elements of a view: one color, size and display for all. Size applies to boxes, display to cards. */
    protected elementsPanel(data: AppearanceData, ids: string[], cards: string[], kind: string): React.ReactNode {
        const { view } = data;
        const colors = new Set(ids.map(id => colorIn(view, id) ?? ''));
        const one = ids.length === 1;
        return <>
            <Head kind={`${one ? kind : 'Selection'} in "${view.label}"`} title={one ? data.labels[ids[0]] ?? '' : `${ids.length} elements`} />
            <Section title='Style' scope={IN_VIEW}>
                <Row label='Color'><Swatches value={[...colors][0]} mixed={colors.size > 1} onChange={c => this.exec({ kind: 'setViewElements', view: view.id, ids, patch: { color: c } })} /></Row>
                {this.display(view, cards)}
                {this.sizes(view, ids)}
            </Section>
        </>;
    }

    protected notInViewPanel(data: AppearanceData, id: string): React.ReactNode {
        const { view } = data;
        return <>
            <Head kind={`Card in "${view.label}"`} title={data.labels[id]} />
            <Section title='Card'>
                <div className='catenary-none'>Not in this view.</div>
                {/* The shared action (action-commands.ts): the element of the selection to the current view. */}
                <div className='catenary-buttons'><Button label='Add to Current View' onClick={() => this.commands.executeCommand('catenary.addToView')} /></div>
            </Section>
        </>;
    }

    protected relationPanel(data: AppearanceData, rid: string): React.ReactNode {
        const { view } = data;
        const { name, inView, layout } = data.relations[rid] ?? { name: rid, inView: false, layout: { relation: rid } };
        const set = (patch: Partial<EdgeLayout>) => this.exec({ kind: 'setEdgeLayout', view: view.id, relation: rid, patch });
        return <>
            <Head kind={`Edge in "${view.label}"`} title={name} />
            {inView ? <Section title='Style' scope={IN_VIEW}>
                <Row label='Color'><Swatches value={layout.color} onChange={c => set({ color: c })} /></Row>
                <Row label='Sides' inline>
                    <div className='catenary-side-pair'>
                        <SidePicker label='From' value={layout.fromSide ?? ''} onChange={v => set({ fromSide: v as EdgeLayout['fromSide'] })} />
                        <SidePicker label='To' value={layout.toSide ?? ''} onChange={v => set({ toSide: v as EdgeLayout['toSide'] })} />
                    </div>
                </Row>
                <Row label='Visible' inline><div>
                    <label className='catenary-check' title='Del hides the selected edges in the view. Other views are not affected.'>
                        <input type='checkbox' checked={!layout.hidden} onChange={() => this.exec({ kind: 'hideEdges', view: view.id, ids: [rid], hidden: !layout.hidden })} />
                        in this view <kbd className='catenary-kbd'>Del</kbd>
                    </label>
                </div></Row>
            </Section> : <Section title='Edge'><div className='catenary-none'>Not in this view: one end of the relation is not in the view.</div></Section>}
        </>;
    }

    /** No element selected. The View section shows the current editor; another view (selected in the explorer) shows its hidden edges here. */
    protected viewPanel(data: AppearanceData): React.ReactNode {
        const { view, hidden } = data;
        const current = this.editors.current();
        if (current && viewIdOf(current) === view.id) return <>
            <Head kind='View' title={view.label} />
            <div className='catenary-none catenary-hint'>Select cards or edges in the view to set color, size and display.</div>
        </>;
        return <>
            <Head kind='View' title={view.label} />
            <Section title={`Hidden edges (${hidden.length})`} scope={IN_VIEW}>
                {hidden.length ? this.hiddenList(view.id, hidden) : <span className='catenary-none'>none</span>}
            </Section>
        </>;
    }
}

@injectable()
export class AppearanceContribution extends AbstractViewContribution<AppearanceWidget> {
    constructor() {
        super({
            widgetId: APPEARANCE_ID, widgetName: 'Appearance',
            defaultWidgetOptions: { area: 'right', rank: 200 },
            toggleCommandId: 'catenary.toggleAppearance'
        });
    }
}
