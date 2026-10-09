// Base widget and small form controls of the Properties and Appearance panels.

import { ReactWidget } from '@theia/core/lib/browser';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { Message } from '@theia/core/shared/@lumino/messaging';
import { EditCommand, iriText, parseIri } from '@catenary/model';
import { ModelActions } from '../actions';
import { COLOR_NAMES, COLOR_ORDER, PRESETS } from '../diagram/views';
import { ModelFrontend } from '../model-client';
import { SelectionModel, Selected } from '../selection-model';

/** Side panel for the selected element. Renders again when the model or the selection changes, and when the backend resolved the selection. */
@injectable()
export abstract class ElementPanel extends ReactWidget {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(ModelActions) protected readonly actions: ModelActions;
    @inject(SelectionModel) protected readonly elements: SelectionModel;

    @postConstruct()
    protected init(): void {
        this.addClass('catenary-properties');
        this.toDispose.push(this.model.onDidChange(s => { if (s.change?.reason !== 'save') this.update(); }));
        this.toDispose.push(this.elements.onDidChange(() => this.update()));
        this.toDispose.push(this.elements.onDidResolve(() => this.update()));
        this.update();
    }

    protected override onUpdateRequest(msg: Message): void {
        if (this.contentVisible()) super.onUpdateRequest(msg);
    }

    protected contentVisible(): boolean { return this.isVisible; }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        this.update();
    }

    protected exec(command: EditCommand): void {
        this.model.execute(command);
    }

    protected render(): React.ReactNode {
        if (!this.model.isOpen) return <div className='theia-widget-noInfo'>No model is open.</div>;
        return <div className='catenary-props'>{this.body(this.elements.resolved)}{this.footer()}</div>;
    }

    protected abstract body(s: Selected): React.ReactNode;

    /** Content after the element sections, for any selection. */
    protected footer(): React.ReactNode {
        return undefined;
    }
}

/**
 * `help`: text of a "?" icon in the heading, shown on hover. `scope`: a tag at the right of the heading that tells where a change applies.
 * With `onToggle`, the heading opens and closes the section; `open` false shows the heading only.
 */
export function Section(p: { title: string; help?: string; scope?: string; open?: boolean; onToggle?: () => void; children?: React.ReactNode }) {
    const open = p.open ?? true;
    const text = <>{p.title}{p.help ? <span className='codicon codicon-question catenary-help-icon' title={p.help} /> : undefined}</>;
    const scope = p.scope ? <span className='catenary-scope'>{p.scope}</span> : undefined;
    return <section className='catenary-section'>
        {p.onToggle
            ? <h4><button className='catenary-fold' aria-expanded={open} onClick={p.onToggle}>
                <span className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} />{text}{scope}
            </button></h4>
            : <h4>{text}{scope}</h4>}
        {open ? p.children : undefined}
    </section>;
}

/**
 * `term`: the RDF term of the field (sh:name), at the right of the label. `tip`: help text of a "?" icon after the label, shown on hover.
 * `help`: help text below the control, always shown. `inline`: the label at the left of the control, not above it.
 */
export function Row(p: { label: string; term?: string; tip?: string; help?: string; required?: boolean; problems?: string[]; inline?: boolean; children?: React.ReactNode }) {
    return <div className={p.inline ? 'catenary-row inline' : 'catenary-row'}>
        <label>
            {p.label}{p.required ? <span className='req' title='Required (sh:minCount ≥ 1)'> *</span> : undefined}
            {p.tip ? <span className='codicon codicon-question catenary-help-icon' title={p.tip} /> : undefined}
            {p.term ? <code className='catenary-term'>{p.term}</code> : undefined}
        </label>
        {p.children}
        {p.help ? <div className='catenary-help'>{p.help}</div> : undefined}
        {(p.problems ?? []).map((m, i) => <div key={i} className='catenary-problem'><span className='codicon codicon-warning' /> {m}</div>)}
    </div>;
}

/** Text input that commits on blur or Enter; Escape resets. Re-mounts when `value` changes. */
/** `field`: the first editable field of the element (label, path), for the follow-up of a creation (follow-up.ts). */
export function TextInput(p: { value: string; onCommit: (v: string) => void; placeholder?: string; multiline?: boolean; numeric?: boolean; field?: string }) {
    const commit = (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
        if (e.currentTarget.value !== p.value) p.onCommit(e.currentTarget.value);
    };
    if (p.multiline) {
        return <textarea key={p.value} className='theia-input' defaultValue={p.value} placeholder={p.placeholder}
            rows={Math.min(6, Math.max(2, Math.ceil(p.value.length / 34)))} onBlur={commit} />;
    }
    return <input key={p.value} className='theia-input' type='text' defaultValue={p.value} placeholder={p.placeholder}
        inputMode={p.numeric ? 'numeric' : undefined} data-catenary-field={p.field}
        onBlur={commit}
        onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') { e.currentTarget.value = p.value; e.currentTarget.blur(); }
        }} />;
}

/** Help text of every IRI field. */
export const IRI_HELP = 'prefix:local, <iri>, a full IRI, or a name (a urn:name IRI, canonical-md). Empty: a new IRI from the label.';

/**
 * The IRI field of every element kind. Shows "prefix:local" (and the full IRI below it), else the IRI. Reads the text with `parseIri`:
 * `onCommit(undefined)` for empty text (mint), `onError` for text that is not an IRI.
 */
export function IriInput(p: { value: string; onCommit: (iri: string | undefined) => void; onError: (message: string) => void }) {
    const text = iriText(p.value);
    return <>
        <TextInput value={text} onCommit={v => {
            const r = parseIri(v);
            if ('error' in r) p.onError(r.error); else p.onCommit(r.iri);
        }} />
        {text !== p.value ? <code className='catenary-iri'>{p.value}</code> : undefined}
    </>;
}

export function Select(p: { value: string; options: [string, string][]; onChange: (v: string) => void }) {
    return <select className='theia-select' value={p.value} onChange={e => p.onChange(e.currentTarget.value)}>
        {p.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>;
}

/** Color presets of `Swatches`: '' (default, no stored color), then the stored presets. */
const SWATCHES = ['', ...COLOR_ORDER];
const colorName = (c: string) => (c === '' ? 'default' : c === 'none' ? 'none (transparent)' : COLOR_NAMES[c] ?? c);

/**
 * One button per color preset and a custom color input. '' means no color. Not undefined: JSON-RPC drops undefined properties,
 * so the patch would not remove the color. `mixed`: several elements with different colors; no swatch is marked.
 */
export function Swatches(p: { value?: string; mixed?: boolean; onChange: (v: string) => void }) {
    const value = p.mixed ? undefined : p.value ?? '';
    const custom = value !== undefined && value !== '' && !PRESETS[value] ? value : undefined;
    const picker = React.useRef<HTMLInputElement>(null);
    const onChange = React.useRef(p.onChange);
    onChange.current = p.onChange;
    // The native change event fires once, when the picker closes. React's onChange fires at each move of the picker.
    React.useEffect(() => {
        const input = picker.current;
        const commit = () => { if (input) onChange.current(input.value); };
        input?.addEventListener('change', commit);
        return () => input?.removeEventListener('change', commit);
    }, []);
    return <div>
        <div className='catenary-colors'>
            {SWATCHES.map(c => <button key={c} aria-pressed={c === value} title={colorName(c)} aria-label={colorName(c)}
                className={`catenary-color${c === '' ? ' default' : ''}${c === 'none' ? ' none' : ''}${c === value ? ' on' : ''}`}
                style={c && c !== 'none' ? { background: PRESETS[c] } : undefined} onClick={() => p.onChange(c)} />)}
            <label className={`catenary-color custom${custom ? ' on' : ''}`} title='Custom color' style={custom ? { background: custom } : undefined}>
                {custom ? undefined : <span className='codicon codicon-add' />}
                <input ref={picker} type='color' aria-label='Custom color' value={custom && /^#[0-9a-f]{6}$/i.test(custom) ? custom : '#808080'} onChange={() => undefined} />
            </label>
        </div>
        <div className='catenary-help'>{value === undefined ? 'mixed' : colorName(value)}</div>
    </div>;
}

/** One button per option; the button of `value` is marked. A value of no option (mixed) marks none. `icon`: SVG path data in a 16 px box. */
export function Choice(p: { value: string; options: { value: string; label: string; title?: string; icon?: string }[]; onChange: (v: string) => void }) {
    return <div className='catenary-choice'>
        {p.options.map(o => <button key={o.value} aria-pressed={o.value === p.value} className={o.value === p.value ? 'on' : ''}
            title={o.title ?? (o.icon ? o.label : undefined)} aria-label={o.label} onClick={() => { if (o.value !== p.value) p.onChange(o.value); }}>
            {o.icon ? <svg width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='currentColor' strokeWidth='1.5'><path d={o.icon} /></svg> : o.label}
        </button>)}
    </div>;
}

/** Side of an edge end: four arrows around "A" (auto, value ''). */
export function SidePicker(p: { label: string; value: string; onChange: (v: string) => void }) {
    const cell = (v: string, text: string, area: string) => <button style={{ gridArea: area }} className={v === p.value ? 'on' : ''}
        aria-pressed={v === p.value} title={`${p.label}: ${v || 'auto'}`} aria-label={`${p.label} ${v || 'auto'}`} onClick={() => p.onChange(v)}>{text}</button>;
    return <div className='catenary-sides'>
        <div className='catenary-side-grid'>
            {cell('top', '↑', 't')}{cell('left', '←', 'l')}{cell('', 'A', 'c')}{cell('right', '→', 'r')}{cell('bottom', '↓', 'b')}
        </div>
        <div className='catenary-help'>{p.label}: {p.value || 'auto'}</div>
    </div>;
}

export function Button(p: { label: string; onClick: () => void; kind?: 'primary' | 'danger' | 'secondary'; title?: string; disabled?: boolean }) {
    return <button className={`theia-button ${p.kind === 'primary' ? 'main' : 'secondary'} ${p.kind === 'danger' ? 'catenary-danger' : ''}`}
        title={p.title} disabled={p.disabled} onClick={p.onClick}>{p.label}</button>;
}

export function IconButton(p: { icon: string; title: string; onClick: () => void; danger?: boolean }) {
    return <span className={`codicon codicon-${p.icon} action-label catenary-icon-button ${p.danger ? 'catenary-danger' : ''}`} title={p.title}
        role='button' onClick={p.onClick} />;
}

/** A link; with `icon`, a codicon before the label. */
export function Link(p: { label: string; onClick: () => void; title?: string; icon?: string }) {
    return <a href='#' className='catenary-link' title={p.title} onClick={e => { e.preventDefault(); p.onClick(); }}>
        {p.icon ? <span className={`codicon codicon-${p.icon}`} /> : undefined}{p.label}
    </a>;
}

/** Head of a panel: kind and name of the selected element. The kind can hold a link (the owner of a property). */
export function Head(p: { kind: React.ReactNode; title: string }) {
    return <div className='catenary-head'><div className='kind'>{p.kind}</div><div className='title'>{p.title}</div></div>;
}

/** Problems of the selection, in a box near the top of the panel. `more`: a link after the list. */
export function Warning(p: { title: string; items: string[]; more?: React.ReactNode }) {
    return <div className='catenary-warning' role='status'>
        <div><span className='codicon codicon-warning' /> <b>{p.title}</b></div>
        {p.items.map((m, i) => <div key={i}>{m}</div>)}
        {p.more}
    </div>;
}
