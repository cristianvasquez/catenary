// Properties of the selected instance, relation, view or group (Theia property view).
// Appearance in a view: appearance-widget.tsx. Views and relations of an element: links-widget.tsx.
// All data comes from the backend (ADR 0007): instances, relations, views, the violations and the store counts by SPARQL
// (`properties` RPC); shapes elements (`shapes`), the boxes of a view (`view`) and labels of elements (`elementRows`) on request.

import { GlspSelection } from '@eclipse-glsp/theia-integration';
import URI from '@theia/core/lib/common/uri';
import { OpenerService, open } from '@theia/core/lib/browser';
import { CommandService } from '@theia/core';
import { inject, injectable } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { PropertyViewContentWidget } from '@theia/property-view/lib/browser/property-view-content-widget';
import { DefaultPropertyViewWidgetProvider } from '@theia/property-view/lib/browser/property-view-widget-provider';
import type { ShaclForm } from '@ulb-darmstadt/shacl-form';
import {
    ACTIONS, ClassDef, Description, ElementProperties, ElementRow, InstanceProperties, baseName, LOGICAL_OPERATORS, LogicalOperator, NodeShapePatch, ShapesModel, View,
    ViewElementPatch, boxes, cardinalityText, compactIri, describeProperties, describeQuads, descriptionCommand, descriptionKey, formPredicates, formatPath, inside,
    parseCardinality, parsePath, permittedRelations, predicateName, primaryClass, rangeText, verbalizeConstraint, verbalizeProperty, verbalizeShape, alternativesOf,
    rangeKey, valueSetOf, Range, SimpleRange, NS, lockedKey
} from '@catenary/model';
import { ViewEditors } from '../diagram/view-editors';
import { ViewNotesEditors, ViewNotesField } from '../notes/view-notes';
import { VIEW_NOTES_SCHEME } from '../notes/view-notes-resource';
import { TextEditorSelection } from '@theia/editor/lib/browser/editor';
import { Button, Choice, ElementPanel, Head, IconButton, IRI_HELP, IriInput, Link, Row, Section, TextInput, Warning } from './controls';
import { ELEMENT_SCHEME, viewIdOfUri } from '../../common/protocol';
import { CatenaryNode } from '../explorer/model-explorer';
import { Selected } from '../selection-model';
import { ActionService } from '../action-service';
import { ShaclFormHost } from './shacl-form-host';
import type { ModelActions } from '../actions';

/** Help text of the view panel, shown on hover of the "?" icon. */
const VIEW_HELP = 'A view shows all relations between its elements. Del hides an edge in this view; restore it in the Appearance panel or with "Show hidden edges".\n\n'
    + 'Palette: select Instances or Shapes. Drag a node shape from the Model explorer (under its class) to show its card. On a shape card, → draws a property: to another card, or to empty canvas for a datatype, value set or scheme. '
    + 'Select a property edge and drag its violet handle to another edge: logical constraint. Click a cardinality to change it. Double-click a path to edit it. Ctrl+Del deletes from the shapes.';

/** Actions with an icon in the toolbar under the head, in two groups: navigation, then explorer, source and name. The menu has all actions. */
const TOOLBAR: [string, string][][] = [
    [['catenary.openView', 'link-external'], ['catenary.showInView', 'eye'], ['catenary.previousOccurrence', 'chevron-left'], ['catenary.nextOccurrence', 'chevron-right']],
    [['catenary.selectInExplorer', 'list-tree'], ['catenary.goToSource', 'go-to-file'], ['catenary.rename', 'edit'], ['catenary.editPath', 'edit']]
];
const DELETE = 'catenary.deleteFromModel';

/** Common cardinalities, as buttons. Other values: the text field beside them. */
const CARDINALITIES = ['0..1', '1', '0..*', '1..*'];

/** The SHACL term of each kind of target. */
const RANGE_TERMS: Record<Range['kind'], string | undefined> = {
    node: 'sh:node', class: 'sh:class', datatype: 'sh:datatype', nodeKind: 'sh:nodeKind', in: 'sh:in', scheme: 'sh:node', collection: 'sh:node', or: 'sh:or', any: undefined
};

// ------------------------------------------------------------------ widget

@injectable()
export class ModelPropertiesWidget extends ElementPanel implements PropertyViewContentWidget {
    static readonly ID = 'catenary-properties';
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(ViewNotesEditors) protected readonly notes: ViewNotesEditors;
    @inject(OpenerService) protected readonly openers: OpenerService;

    /** Edits from the SHACL form that the backend has not yet answered. */
    protected pending = 0;

    constructor() {
        super();
        this.id = ModelPropertiesWidget.ID;
        this.title.label = 'Model properties';
    }

    @inject(ActionService) protected readonly actionService: ActionService;
    @inject(CommandService) protected readonly commands: CommandService;

    /** The panel follows the SelectionModel, not the Theia selection. */
    updatePropertyViewContent(): void { /* see ElementPanel */ }

    /** Open state of the "More actions" menu, and of the sections that open and close, by key (this window). */
    protected menuOpen = false;
    protected readonly folds = new Map<string, boolean>();

    protected override init(): void {
        super.init();
        this.toDispose.push(this.actionService.onDidChange(() => this.update()));
        this.toDispose.push(this.elements.onDidChange(() => { this.menuOpen = false; }));
        const close = (e: PointerEvent) => {
            if (this.menuOpen && !(e.target instanceof Element && e.target.closest('.catenary-toolbar-more'))) { this.menuOpen = false; this.update(); }
        };
        document.addEventListener('pointerdown', close, true);
        this.toDispose.push({ dispose: () => document.removeEventListener('pointerdown', close, true) });
    }

    /** The sections. `data-catenary-element`: the follow-up finds the fields. */
    protected override render(): React.ReactNode {
        if (!this.model.isOpen) return super.render();
        const s = this.elements.resolved;
        return <div className='catenary-props' data-catenary-element={s.elements.length === 1 ? s.elements[0] : undefined}>
            {this.body(s)}{this.footer()}
        </div>;
    }

    /**
     * The actions that apply to the selection (spec 0.4: the same actions as every menu): icons for the frequent ones, and a menu with all of
     * them, Delete from Model last. A disabled one says why in its tooltip.
     */
    protected toolbar(): React.ReactNode {
        const states = this.actionService.latest(this.actionService.selectionTarget()).actions;
        if (!states.length) return undefined;
        const title = (a: typeof states[number]) => {
            const def = ACTIONS.find(d => d.id === a.id)!;
            return a.reason ?? (def.key ? `${def.label} (${def.key})` : def.label);
        };
        const run = (id: string) => { this.menuOpen = false; this.update(); void this.commands.executeCommand(id); };
        const groups = TOOLBAR.map(g => g.map(([id, icon]) => ({ state: states.find(a => a.id === id), icon })).filter(x => !!x.state)).filter(g => g.length);
        const menu = [...states.filter(a => a.id !== DELETE), ...states.filter(a => a.id === DELETE)];
        return <div className='catenary-toolbar'>
            {groups.map((g, i) => <React.Fragment key={i}>
                {i ? <span className='catenary-toolbar-separator' /> : undefined}
                {g.map(({ state, icon }) => <button key={state!.id} className='catenary-tool' title={title(state!)} aria-label={ACTIONS.find(d => d.id === state!.id)!.label}
                    disabled={!state!.enabled} onClick={() => run(state!.id)}><span className={`codicon codicon-${icon}`} /></button>)}
            </React.Fragment>)}
            <div className='catenary-toolbar-more'>
                <button className={`catenary-tool${this.menuOpen ? ' on' : ''}`} title='More actions' aria-label='More actions' aria-haspopup='menu' aria-expanded={this.menuOpen}
                    onClick={() => { this.menuOpen = !this.menuOpen; this.update(); }}><span className='codicon codicon-ellipsis' /></button>
                {this.menuOpen ? <div className='catenary-menu' role='menu' onKeyDown={e => { if (e.key === 'Escape') { this.menuOpen = false; this.update(); } }}>
                    {menu.map(a => {
                        const def = ACTIONS.find(d => d.id === a.id)!;
                        return <React.Fragment key={a.id}>
                            {a.id === DELETE && menu.length > 1 ? <div className='catenary-menu-separator' /> : undefined}
                            <button role='menuitem' className={a.id === DELETE ? 'catenary-danger' : ''} disabled={!a.enabled} title={a.reason}
                                onClick={() => run(a.id)}><span>{def.label}</span>{def.key ? <span className='key'>{def.key}</span> : undefined}</button>
                        </React.Fragment>;
                    })}
                </div> : undefined}
            </div>
        </div>;
    }

    /** Open state of a section that opens and closes; `initial` until the user changes it. */
    protected fold(key: string, initial = false): { open: boolean; onToggle: () => void } {
        return { open: this.folds.get(key) ?? initial, onToggle: () => { this.folds.set(key, !(this.folds.get(key) ?? initial)); this.update(); } };
    }

    /**
     * The IRI row of every element kind. Set IRI: the id follows the IRI; the selection and the view editors follow the new id (`movedIds`).
     * Empty: a new IRI from the label.
     */
    protected iriRow(id: string, uri: string, label = 'IRI'): React.ReactNode {
        return <Row label={label} tip={IRI_HELP}>
            <IriInput value={uri} onCommit={v => this.exec({ kind: 'setUri', id, uri: v })} onError={m => this.actions.info(m)} />
        </Row>;
    }

    /** The node shapes of the classes of an instance; a click shows the shape as a double-click on its Model explorer row does. */
    protected shapeRow(inst: InstanceProperties): React.ReactNode {
        const { shapes } = inst;
        if (!shapes.length) return undefined;
        return <Row label={shapes.length > 1 ? 'Shapes' : 'Shape'} inline>
            <div className='catenary-links-row'>{shapes.map(n => <Link key={n.id} icon='symbol-ruler' label={n.label}
                title={`${n.uri}\nShow the node shape (as a double-click in the Model explorer)`} onClick={() => void this.editors.show(n.id)} />)}</div>
        </Row>;
    }

    /** The last answer of the backend: the request (file, revision, element id) and the data. */
    protected data?: { request: string; id?: string; value?: ElementProperties };
    protected dataRequest?: string;

    /**
     * The data of the element `id` (none: the counts of the store). Asks the backend when the selection or the model changed; the last
     * answer for the same element holds while a newer one is on the way. Undefined: no answer yet.
     */
    protected properties(id?: string): ElementProperties | undefined {
        const { file, revision } = this.model.snapshot;
        const request = `${file}\n${revision}\n${id ?? ''}`;
        if (this.data?.request !== request && this.dataRequest !== request) {
            this.dataRequest = request;
            this.model.service.properties(id).then(value => {
                if (this.dataRequest !== request) return;
                this.dataRequest = undefined;
                this.data = { request, id, value };
                this.update();
            });
        }
        return this.data && this.data.id === id ? this.data.value : undefined;
    }

    /** Answers of other queries for the current model revision, by key; the last answer for a key holds while a newer one is on the way. */
    protected answers = new Map<string, { request: string; value: unknown }>();
    protected asked = new Set<string>();

    /** The answer of `fetch` for `key` and the current model revision. Undefined: no answer yet; the panel renders again when it arrives. */
    protected ask<T>(key: string, fetch: () => Promise<T>): T | undefined {
        const { file, revision } = this.model.snapshot;
        const request = `${file}\n${revision}\n${key}`;
        const have = this.answers.get(key);
        if (have?.request !== request && !this.asked.has(request)) {
            this.asked.add(request);
            fetch().then(value => {
                this.asked.delete(request);
                // Most recent keys last; keep the last 50 (one panel shows a few keys at a time).
                this.answers.delete(key);
                this.answers.set(key, { request, value });
                if (this.answers.size > 50) this.answers.delete(this.answers.keys().next().value!);
                this.update();
            }, () => this.asked.delete(request));
        }
        return have?.value as T | undefined;
    }

    protected shapes(): ShapesModel | undefined {
        return this.ask('shapes', () => this.model.service.shapes());
    }

    protected storedView(viewId: string): View | undefined {
        return this.ask(`view ${viewId}`, () => this.model.service.view(viewId));
    }

    protected rows(ids: string[], viewId?: string): ElementRow[] | undefined {
        return this.ask(`rows ${viewId ?? ''} ${ids.join(' ')}`, () => this.model.service.elementRows(ids, viewId));
    }

    protected loading(): React.ReactNode {
        return <div className='catenary-help'>Loading…</div>;
    }

    protected body(sel: Selected): React.ReactNode {
        const { view, instances, relations, views, groups, notes, references, arrows, collections, shapes, properties, constraints, valueSets } = sel;
        const all = [...instances, ...relations, ...views, ...groups, ...notes, ...references, ...arrows, ...collections, ...shapes, ...properties, ...constraints, ...valueSets];
        if (all.length > 1) return this.multiPanel(all, view);
        if (valueSets.length === 1) return this.valueSetPanel(valueSets[0], view);
        if (properties.length === 1) return this.propertyShapePanel(properties[0], view);
        if (constraints.length === 1) return this.constraintPanel(constraints[0], view);
        if (shapes.length === 1) return this.nodeShapePanel(shapes[0], view);
        if (instances.length === 1) return this.instancePanel(instances[0]);
        if (relations.length === 1) return this.relationPanel(relations[0]);
        if (groups.length === 1) return this.groupPanel(view!, groups[0]);
        if (notes.length === 1) return this.notePanel(view!, notes[0]);
        if (references.length === 1) return this.referencePanel(view!, references[0]);
        if (arrows.length === 1) return this.arrowPanel(view!, arrows[0]);
        if (views.length === 1) return this.viewPanel(views[0]);
        if (view) return this.viewPanel(view);
        return this.summaryPanel();
    }

    /** The head of every panel: kind and name, then the action toolbar. */
    protected head(kind: React.ReactNode, title: string): React.ReactNode {
        return <><Head kind={kind} title={title} />{this.toolbar()}</>;
    }

    // ------------------------------------------------------------ instance

    /** The SHACL form for the statements of an instance that its shapes describe. */
    protected descriptionForm(inst: InstanceProperties, cls: ClassDef): React.ReactNode {
        const shapes = this.model.shapesText;
        if (shapes === undefined) return <div className='catenary-help'>Loading shapes…</div>;
        const predicates = formPredicates(cls);
        const shapeSubject = cls.shapes.find(s => s.includes(':'));
        const key = this.dataKey(inst, describeProperties(inst, predicates));
        const have = this.formValues?.id === inst.id ? this.formValues : undefined;
        if (have?.key !== key) this.requestFormData(inst.id, key);
        if (!have) return <div className='catenary-help'>Loading…</div>;
        // The form shows the data that the backend sent for `have.key`; it holds while newer data (form data or properties) is on the way.
        return <ShaclFormHost key={inst.id} shapes={shapes} subject={inst.uri} shapeSubject={shapeSubject}
            dataKey={have.key}
            hold={this.pending > 0 || have.key !== key || this.dataRequest !== undefined}
            values={() => have.text}
            onFormChange={form => this.formChanged(inst.id, predicates, form)} />;
    }

    /** Form data (N-Triples) of the instance `id`, as the backend sent it for the data key `key`. */
    protected formValues?: { id: string; key: string; text: string };
    protected formRequest?: string;

    protected requestFormData(id: string, key: string): void {
        const request = id + '\n' + key;
        if (this.formRequest === request) return;
        this.formRequest = request;
        this.model.service.formData(id).then(text => {
            if (this.formRequest !== request) return;
            this.formRequest = undefined;
            this.formValues = { id, key, text };
            this.update();
        });
    }

    /** What a form for an instance shows: its description, and the other instances (link candidates). */
    protected dataKey(inst: InstanceProperties, d: Description): string {
        return descriptionKey(d) + '\n--\n' + inst.candidates;
    }

    protected formChanged(id: string, predicates: string[], form: ShaclForm): string {
        // The last answer of the backend for the instance: the statements before the change.
        const inst = this.properties(id);
        if (inst?.kind !== 'instance') return '';
        const after = describeQuads(form.toRDF().getQuads(null, null, null, null), inst.uri, predicates);
        const command = descriptionCommand(inst, describeProperties(inst, predicates), after);
        if (command) {
            this.pending++;
            this.model.execute(command).finally(() => {
                this.pending--;
                this.update();
            });
        }
        return this.dataKey(inst, after);
    }

    protected instancePanel(id: string): React.ReactNode {
        const { meta } = this.model;
        const inst = this.properties(id);
        if (inst?.kind !== 'instance') return this.loading();
        const cls = primaryClass(meta, inst.types);
        const problems = inst.results;
        const known = new Set(cls ? formPredicates(cls) : []);
        const extra = Object.entries(inst.fields).filter(([p]) => !known.has(p));
        const problemText = (p: typeof problems[number]) => `${p.pathName && !p.message.includes(p.pathName) ? `${p.pathName}: ` : ''}${p.message}`;
        // Statements in protected files: no edit control. An edit in the form is refused and asks to unprotect (ModelFrontend.execute).
        const locked = new Set(inst.locked ?? []);
        const labelLocked = locked.has(lockedKey(NS.rdfs + 'label', { termType: 'Literal', value: inst.label }));
        return <>
            {this.head(cls?.name ?? 'Instance (class not in shapes)', inst.label)}
            {/* All violations: the form marks invalid values, but not empty required fields. */}
            {problems.length ? <Warning title={`${problems.length} ${problems.length === 1 ? 'violation' : 'violations'}`} items={problems.map(problemText)} /> : undefined}
            <Section title='Identity'>
                <Row label='Class' inline>
                    <div className='catenary-pills'>{inst.types.length ? inst.types.map(t => <span key={t} className='catenary-pill' title={t}>{compactIri(t)}</span>)
                        : <span className='catenary-none'>none</span>}</div>
                </Row>
                {this.shapeRow(inst)}
                {inst.importedFiles ? <Row label='Imported' inline tip={`Values from imported files are read only. New values go to ${this.model.snapshot.files.defaultFile
                    ? baseName(this.model.snapshot.files.defaultFile.path) : 'the default file'} (Workspace settings, Everything else).`}>
                    <div className='catenary-pills'>{inst.importedFiles.map(f => <span key={f} className='catenary-pill' title={f}>
                        <span className='codicon codicon-lock' /> {baseName(f)}</span>)}</div>
                </Row> : undefined}
                {locked.size ? <Row label='IRI' tip={IRI_HELP}><span className='catenary-value' title={inst.uri}>{inst.uri}</span></Row> : this.iriRow(inst.id, inst.uri)}
                {cls?.labelInShape ? undefined
                    : <Row label='Label' term='rdfs:label' tip='The shapes of this class have no rdfs:label property, so the form below does not show it.'>
                        {labelLocked ? <span className='catenary-value'>{inst.label}</span>
                            : <TextInput field='label' value={inst.label} onCommit={v => this.exec({ kind: 'rename', id: inst.id, label: v.trim() })} />}
                    </Row>}
            </Section>
            {cls ? <Section title='Description'>{this.descriptionForm(inst, cls)}</Section> : undefined}
            {extra.length ? <Section title='Not in shapes' scope={`${extra.reduce((n, [, vs]) => n + vs.length, 0)} statements`} {...this.fold('extra')}>{extra.map(([p, vs]) =>
                <Row key={p} label={predicateName(meta, p)} tip={p}>{vs.map((v, i) => <div key={i} className='catenary-value'>
                    <span>{v.value}</span>
                    {locked.has(lockedKey(p, v)) ? <span className='codicon codicon-lock' title='From an imported file (read only)' />
                        : <IconButton icon='close' title='Remove the value' onClick={() => this.exec({ kind: 'setStatements', id: inst.id, values: { [p]: vs.filter((_, j) => j !== i) } })} />}
                </div>)}</Row>)}</Section> : undefined}
            {cls?.unsupported.length ? <Section title='Not supported'>{cls.unsupported.map(u => <div key={u} className='catenary-help'>{u}</div>)}</Section> : undefined}
        </>;
    }

    // ------------------------------------------------------------ several

    /** Several elements of any kinds: a list (label and kind). The actions on them: the action row (spec 0.4). */
    protected multiPanel(ids: string[], viewId?: string): React.ReactNode {
        const rows = this.rows(ids, viewId);
        if (!rows) return this.loading();
        const select = (r: ElementRow) => r.kind === 'instance' ? void this.editors.show(r.id) : this.elements.set({ view: viewId, ids: [r.id] });
        return <>
            {this.head('Selection', `${ids.length} elements`)}
            <Section title='Elements'>{rows.map(r =>
                <div key={r.id} className='catenary-value'><Link label={r.label ?? r.id} onClick={() => select(r)} /><span className='catenary-help'>{r.kindName}</span></div>)}
            </Section>
        </>;
    }

    // ------------------------------------------------------------ relation

    protected relationPanel(rid: string): React.ReactNode {
        const { meta } = this.model;
        const r = this.properties(rid);
        if (r?.kind !== 'relation') return this.loading();
        const s = r.subject, o = r.object;
        const permitted = permittedRelations(meta, s.types, o.types, o.uri).some(x => x.path === r.predicate);
        return <>
            {this.head('Relation', predicateName(meta, r.predicate))}
            <Section title='Triple'>
                <Row label='From' inline><Link label={s.label} onClick={() => this.editors.show(s.id)} /></Row>
                <Row label='Predicate' inline><code className='catenary-iri' title={r.predicate}>{compactIri(r.predicate)}</code></Row>
                <Row label='To' inline><Link label={o.label} onClick={() => this.editors.show(o.id)} /></Row>
                {permitted ? undefined : <div className='catenary-problem'><span className='codicon codicon-warning' /> The shapes do not declare this relation for these classes.</div>}
            </Section>
        </>;
    }

    // ------------------------------------------------------------ group

    protected groupPanel(viewId: string, gid: string): React.ReactNode {
        const view = this.storedView(viewId);
        const g = boxes(view, 'group').find(x => x.id === gid);
        if (!view || !g) return this.loading();
        const set = (patch: ViewElementPatch) => this.exec({ kind: 'setViewElements', view: viewId, ids: [gid], patch });
        const members = boxes(view, 'card').filter(n => inside(n, g));
        const labels = new Map((this.rows(members.map(n => n.element)) ?? []).map(r => [r.id, r.label]));
        return <>
            {this.head(`Group in "${view.label}"`, g.label)}
            <Section title='Group'>
                <Row label='Name'><TextInput field='label' value={g.label} onCommit={v => set({ label: v })} /></Row>
                <div className='catenary-help'>Layout only: a group has no meaning in the model. Dragging the group moves the cards inside it.</div>
            </Section>
            <Section title={`Inside (${members.length})`}>
                {members.length ? members.map(n => <div key={n.id} className='catenary-value'>
                    <Link label={labels.get(n.element) ?? '?'} onClick={() => this.editors.reveal(viewId, [n.element])} />
                </div>) : <span className='catenary-none'>no cards</span>}
            </Section>
        </>;
    }

    // ------------------------------------------------------------ view-owned nodes

    protected notePanel(viewId: string, noteId: string): React.ReactNode {
        const view = this.storedView(viewId);
        const note = boxes(view, 'note').find(n => n.id === noteId);
        if (!view || !note) return this.loading();
        return <>
            {this.head(`Note in "${view.label}"`, note.text.split('\n')[0] || 'Empty note')}
            <Section title='Note'>
                <div className='catenary-help'>This note belongs to the view. It is not a model entity. Rename (F2) edits its Markdown.</div>
            </Section>
        </>;
    }

    protected arrowPanel(viewId: string, arrowId: string): React.ReactNode {
        const view = this.storedView(viewId);
        const row = this.rows([arrowId], viewId)?.[0];
        if (!view || !row) return this.loading();
        return <>
            {this.head(`Arrow in "${view.label}"`, row.label ?? '')}
            <Section title='Arrow'>
                <div className='catenary-help'>This arrow belongs to the view. It is not a model relation. It goes when one of its ends leaves the view.</div>
            </Section>
        </>;
    }

    protected referencePanel(viewId: string, referenceId: string): React.ReactNode {
        const view = this.storedView(viewId);
        const reference = boxes(view, 'reference').find(r => r.id === referenceId);
        if (!view || !reference) return this.loading();
        if (reference.file) {
            return <>
                {this.head(`File reference in "${view.label}"`, baseName(reference.file))}
                <Section title='Target'>
                    {reference.broken ? <span className='catenary-problem'>{reference.file}: not on disk (moved or removed).</span>
                        : <Link label={reference.file} title={reference.path} onClick={() => void open(this.openers, URI.fromFilePath(reference.path!))} />}
                    <div className='catenary-help'>Path relative to the view file (view:file). A click on the canvas element opens the file.</div>
                </Section>
            </>;
        }
        const target = this.storedView(reference.target!);
        return <>
            {this.head(`View reference in "${view.label}"`, target?.label ?? 'Missing view')}
            <Section title='Target'>
                {target ? <Link label={target.label} title={target.uri} onClick={() => this.editors.open(target.id)} /> : <span className='catenary-problem'>The target view does not exist.</span>}
                <div className='catenary-help'>A click on the canvas element opens the target view.</div>
            </Section>
        </>;
    }

    // ------------------------------------------------------------ shapes

    protected schemeLabel = (iri: string) => this.model.meta.schemes?.find(s => s.iri === iri)?.label ?? iri.replace(/^.*[#/:]/, '');

    /** Select an element in the view of the selection. */
    protected selectShapeElement(id: string, view?: string): void {
        this.elements.set({ view, ids: [id] });
    }

    protected rawSection(raw: string[]): React.ReactNode {
        return raw.length ? <Section title='Not mapped (kept in the file)'>{raw.map((r, i) => <div key={i} className='catenary-help'><code>{r}</code></div>)}</Section> : undefined;
    }

    protected nodeShapePanel(id: string, view?: string): React.ReactNode {
        const shapes = this.shapes();
        const shape = shapes?.nodeShapes[id];
        if (!shapes || !shape) return this.loading();
        const set = (patch: NodeShapePatch) => this.actions.setNodeShape(id, patch);
        const reads = verbalizeShape(shapes, shape, this.schemeLabel);
        return <>
            {this.head('Node shape', shape.label)}
            <Section title='Shape'>
                {this.iriRow(id, shape.uri)}
                <Row label='Name' term='sh:name'><TextInput field='label' value={shape.label} onCommit={v => this.exec({ kind: 'rename', id, label: v.trim() })} /></Row>
                <Row label='Target class' term='sh:targetClass' tip='A name, prefix:local or <iri>. A name gives the class with that name (shapes or instance types), else a urn:name IRI (canonical-md). Empty: none. A change can ask for a data change (patch queue).'>
                    <TextInput value={shape.targetClass ? compactIri(shape.targetClass) : ''} onCommit={v => void this.actions.setTargetClassText(id, v)} />
                </Row>
                <div className='catenary-row'>
                    <label className='catenary-check' title='No properties other than the ones of the shape (rdf:type is ignored).'>
                        <input type='checkbox' checked={!!shape.closed} onChange={() => set({ closed: !shape.closed })} />Closed<code className='catenary-term'>sh:closed</code>
                    </label>
                </div>
                <Row label='Description' term='sh:description'><TextInput multiline value={shape.description ?? ''} placeholder='Add a description' onCommit={v => set({ description: v })} /></Row>
            </Section>
            <Section title='Properties' scope={String(shape.properties.length)}
                help={'"+ attribute" on the card adds a row. The → handle of the card draws a relation: to another card, or to empty canvas.'}>
                {shape.properties.map(pid => shapes.properties[pid]).filter(p => !!p).map(p => this.propertyRow(shapes, p, view))}
            </Section>
            {this.rawSection(shape.raw)}
            <Section title='Reads as' scope={`${reads.length} ${reads.length === 1 ? 'sentence' : 'sentences'}`} {...this.fold('reads')}>
                <ul className='catenary-verbal-list'>{reads.map((l, i) => <li key={i} className='catenary-verbal'>{l}</li>)}</ul>
            </Section>
        </>;
    }

    /** A property of a shape: path (a link that selects it), cardinality at the right (marked when required), target below. */
    protected propertyRow(shapes: ShapesModel, p: ShapesModel['properties'][string], view?: string, remove?: React.ReactNode): React.ReactNode {
        const constraint = p.constraint ? ` · ${shapes.constraints[p.constraint]?.operator}` : '';
        return <div key={p.id} className='catenary-prop-row'>
            <Link label={formatPath(p.path)} onClick={() => this.selectShapeElement(p.id, view)} />
            <span className={`catenary-cardinality${p.minCount ? ' required' : ''}`} title={p.minCount ? 'Required' : undefined}>{cardinalityText(p.minCount, p.maxCount)}</span>
            {remove}
            <span className='catenary-help'>{rangeText(shapes, p.range, this.schemeLabel)}{constraint}</span>
        </div>;
    }

    protected propertyShapePanel(id: string, view?: string): React.ReactNode {
        const shapes = this.shapes();
        const p = shapes?.properties[id];
        if (!shapes || !p) return this.loading();
        const owner = shapes.nodeShapes[p.owner];
        const set = (patch: Parameters<ModelActions['setProperty']>[1]) => this.actions.setProperty(id, patch, view);
        const num = (v: string) => v.trim() === '' ? null : Number(v);
        const data = this.properties(id);
        const problems = data?.kind === 'propertyShape' ? data.results : [];
        const constraint = p.constraint ? shapes.constraints[p.constraint] : undefined;
        const card = cardinalityText(p.minCount, p.maxCount);
        const setCard = (v: string) => {
            const c = parseCardinality(v);
            if (c) set({ minCount: c.minCount ?? null, maxCount: c.maxCount ?? null }); else this.actions.info(`"${v}" is not a cardinality. Use 1, 0..1, 1..* or 2..5.`);
        };
        const literals = [p.pattern, p.minLength, p.maxLength, p.languageIn?.length ? p.languageIn : undefined].filter(x => x !== undefined && x !== null && x !== '').length;
        const pill = (r: SimpleRange) => <span className='catenary-pill'><span className='k'>{r.kind}</span>{rangeText(shapes, r, this.schemeLabel, 20)}</span>;
        return <>
            {this.head(<>Property of <Link label={owner?.label ?? '?'} title='Select the node shape' onClick={() => this.selectShapeElement(p.owner, view)} /></>, formatPath(p.path))}
            {problems.length ? <Warning title={`${problems.length} ${problems.length === 1 ? 'violation' : 'violations'} in the data`}
                items={problems.slice(0, 5).map(v => `${v.focusLabel}: ${v.message}`)}
                more={problems.length > 5 ? <div className='catenary-help'>{problems.length - 5} more in the Problems view.</div> : undefined} /> : undefined}
            <div className='catenary-verbal catenary-reads'>{verbalizeProperty(shapes, p, this.schemeLabel)}</div>
            <Section title='Property'>
                {p.uri ? this.iriRow(id, p.uri) : undefined}
                <Row label='Path' term='sh:path' tip='A name, prefix:local or <iri>; a SPARQL path of these. A name gives a urn:name IRI (canonical-md). A rename can ask for a data change (patch queue).'>
                    <TextInput field='path' value={formatPath(p.path)} onCommit={v => {
                        const r = parsePath(v);
                        if ('path' in r) set({ path: r.path }); else this.actions.info(r.error);
                    }} />
                </Row>
                <Row label='Target' term={RANGE_TERMS[p.range.kind]} tip={p.nodeKind ? `Also sh:nodeKind ${p.nodeKind}.` : undefined}>
                    {p.range.kind === 'or'
                        ? p.range.alternatives.map(r => <div key={rangeKey(r)} className='catenary-value'>{pill(r)}
                            <IconButton icon='close' title='Remove this target' onClick={() => this.actions.removeAlternative(id, rangeKey(r), view)} /></div>)
                        : undefined}
                    <div className='catenary-pills'>
                        {p.range.kind === 'or' ? undefined : p.range.kind === 'any' ? <span className='catenary-none'>any</span> : pill(p.range)}
                        <Link label='Change…' onClick={() => this.actions.editRange(id, view)} />
                        <Link label='+ One of' title='Add a target (sh:or): each value is one of the targets.' onClick={() => this.actions.addAlternative(id, view)} />
                    </div>
                </Row>
                <Row label='Cardinality' tip='sh:minCount and sh:maxCount, as min..max: 1, 0..1, 1..*, 0..*, 2..5. A click on the badge on the canvas cycles it.'>
                    <div className='catenary-inline catenary-cardinality-edit'>
                        <Choice value={card} options={CARDINALITIES.map(c => ({ value: c, label: c }))} onChange={setCard} />
                        <TextInput value={card} onCommit={setCard} />
                    </div>
                </Row>
                <Row label='Name' term='sh:name'><TextInput value={p.name ?? ''} placeholder='none' onCommit={v => set({ name: v || null })} /></Row>
                <Row label='Description' term='sh:description'><TextInput multiline value={p.description ?? ''} placeholder='Add a description' onCommit={v => set({ description: v || null })} /></Row>
            </Section>
            <Section title='Literal constraints' scope={literals ? `${literals} set` : 'none set'} {...this.fold('literals')}>
                <Row label='Pattern' term='sh:pattern' tip='A regular expression.'><TextInput value={p.pattern ?? ''} onCommit={v => set({ pattern: v || null })} /></Row>
                <div className='catenary-pair'>
                    <Row label='Min length' term='sh:minLength'><TextInput numeric value={p.minLength?.toString() ?? ''} onCommit={v => set({ minLength: num(v) })} /></Row>
                    <Row label='Max length' term='sh:maxLength'><TextInput numeric value={p.maxLength?.toString() ?? ''} onCommit={v => set({ maxLength: num(v) })} /></Row>
                </div>
                <Row label='Languages' term='sh:languageIn' tip='Separated by commas: en, fr'>
                    <TextInput value={p.languageIn?.join(', ') ?? ''} onCommit={v => set({ languageIn: v.split(',').map(x => x.trim()).filter(Boolean) })} />
                </Row>
            </Section>
            {constraint ? <Section title='Logical constraint'>
                <div className='catenary-value'><Link label={`${constraint.operator} of ${constraint.members.length}`} onClick={() => this.selectShapeElement(constraint.id, view)} />
                    <Button label='Take out' onClick={() => this.exec({ kind: 'takeOutOfConstraint', id })} /></div>
            </Section> : undefined}
            {this.rawSection(p.raw)}
        </>;
    }

    /** A SKOS concept scheme or collection: label, concepts, the properties that use it. */
    protected valueSetPanel(id: string, view?: string): React.ReactNode {
        const shapes = this.shapes();
        const v = shapes?.valueSets[id];
        if (!shapes || !v) return this.loading();
        const users = Object.values(shapes.properties).filter(p => alternativesOf(p.range).some(a => valueSetOf(shapes, a) === id));
        return <>
            {this.head(v.kind === 'scheme' ? 'Concept scheme' : 'Collection', v.label)}
            <Section title={v.kind === 'scheme' ? 'Concept scheme' : 'Collection'}>
                {this.iriRow(id, v.uri)}
                <Row label='Label' term='skos:prefLabel'><TextInput field='label' value={v.label} onCommit={t => this.exec({ kind: 'rename', id, label: t.trim() })} /></Row>
            </Section>
            <Section title={v.kind === 'scheme' ? 'Concepts' : 'Members'} scope={String(v.members.length)}>
                {v.members.map(m => <div key={m.uri} className='catenary-value'>
                    <TextInput value={m.label} onCommit={t => this.actions.renameConcept(m.uri, t)} />
                    <IconButton icon='close' title={v.kind === 'scheme' ? 'Delete the concept' : 'Take out of the collection'} onClick={() => this.actions.removeConcept(id, m.uri)} />
                </div>)}
                <TextInput key={`${id}:${v.members.map(m => m.uri).join('|')}`} value='' placeholder={v.kind === 'scheme' ? '+ concept' : '+ member (new, or the label of a concept)'} onCommit={t => this.actions.addConcept(id, t)} />
            </Section>
            <Section title='Used by' scope={String(users.length)}>
                {users.map(p => <div key={p.id} className='catenary-value'>
                    <Link label={`${shapes.nodeShapes[p.owner]?.label} — ${formatPath(p.path)}`} onClick={() => this.selectShapeElement(p.id, view)} />
                </div>)}
            </Section>

        </>;
    }

    protected constraintPanel(id: string, view?: string): React.ReactNode {
        const shapes = this.shapes();
        const c = shapes?.constraints[id];
        if (!shapes || !c) return this.loading();
        return <>
            {this.head(`Logical constraint of ${shapes.nodeShapes[c.owner]?.label ?? '?'}`, c.operator)}
            <Section title='Reads as'><div className='catenary-verbal'>{verbalizeConstraint(shapes, c)}</div></Section>
            <Section title='Constraint'>
                <Row label='Operator' inline tip='or: at least one member. xone: exactly one. and: all. not: none (one member).'>
                    <Choice value={c.operator} options={LOGICAL_OPERATORS.map(o => ({ value: o, label: o }))}
                        onChange={v => this.exec({ kind: 'setConstraint', id, operator: v as LogicalOperator })} />
                </Row>
            </Section>
            <Section title='Members' scope={String(c.members.length)} help='Add a member: select an edge of the same shape and drag its violet handle to the circle.'>
                {c.members.map(m => shapes.properties[m]).filter(p => !!p).map(p => this.propertyRow(shapes, p, view,
                    <IconButton icon='close' title='Take out of the constraint' onClick={() => this.exec({ kind: 'takeOutOfConstraint', id: p.id })} />))}
            </Section>
            {c.raw.length ? this.rawSection(c.raw.map(r => `member ${r}`)) : undefined}
        </>;
    }

    /** The patch queue: data changes that shape edits ask for. */
    protected migrationsSection(): React.ReactNode {
        const queue = this.model.snapshot.migrations;
        if (!queue.length) return undefined;
        return <Section title={`Data changes to apply (${queue.length})`}>
            {queue.map(m => <div key={m.id} className='catenary-migration'>
                <div>{m.reason}</div>
                <div className='catenary-help'>{m.kind === 'renamePredicate'
                    ? `Replace ${compactIri(m.from)} by ${compactIri(m.to)}${m.classIri ? ` on instances of ${compactIri(m.classIri)}` : ''}: ${m.count} statement(s).`
                    : `Replace the class ${compactIri(m.from)} by ${compactIri(m.to)}: ${m.count} instance(s).`}</div>
                <div className='catenary-buttons'>
                    <Button label='Apply to data' kind='primary' onClick={() => this.actions.applyMigration(m)} />
                    <Button label='Dismiss' onClick={() => this.actions.dismissMigration(m.id)} />
                </div>
            </div>)}
            <div className='catenary-help'>The queue is not saved. Apply is one undo step.</div>
        </Section>;
    }

    // ------------------------------------------------------------ view

    protected viewPanel(vid: string): React.ReactNode {
        const view = this.properties(vid);
        if (view?.kind !== 'view') return this.loading();
        return <>
            {this.head('View', view.label)}
            {this.migrationsSection()}
            <Section title='Identity'>
                {this.iriRow(vid, view.uri, 'Graph IRI')}
                <Row label='Label'><TextInput field='label' value={view.label} onCommit={v => this.exec({ kind: 'rename', id: vid, label: v.trim() })} /></Row>
            </Section>
            <Section title='Notes'>
                <ViewNotesField key={vid} model={this.model} editors={this.notes} view={vid} value={view.description} />
            </Section>
            <Section title='Content' help={VIEW_HELP}>
                <div>{view.cards} model element(s), {view.shapes} node shape(s), {view.notes} note(s), {view.references} view reference(s), {view.relations} relation(s), {view.hidden} hidden.</div>
            </Section>
        </>;
    }

    // ------------------------------------------------------------ nothing selected

    protected summaryPanel(): React.ReactNode {
        const s = this.model.snapshot;
        const counts = this.properties();
        const unsupported = s.meta.classes.flatMap(c => c.unsupported.map(u => `${c.name}: ${u}`));
        return <>
            {this.head('Workspace', (s.file ? baseName(s.file) : ''))}
            {this.migrationsSection()}
            <Section title='Content'>
                {counts?.kind === 'workspace' ? <div>{counts.instances} instances, {counts.relations} relations, {counts.views} views.</div> : this.loading()}
                <div>{s.files.files.length} files; default file: {(s.files.defaultFile ? baseName(s.files.defaultFile.path) : '(none)')}; {s.meta.classes.length} classes.</div>
                {counts?.kind === 'workspace' ? <div>{counts.violations} violations (Problems view).</div> : undefined}
            </Section>
            {unsupported.length ? <Section title='Not supported in shapes'>{unsupported.map(u => <div key={u} className='catenary-help'>{u}</div>)}</Section> : undefined}
            {s.warnings.length ? <Section title='Warnings'>{s.warnings.map((w, i) => <div key={i} className='catenary-help'>{w}</div>)}</Section> : undefined}
        </>;
    }
}

@injectable()
export class ModelPropertiesProvider extends DefaultPropertyViewWidgetProvider {
    @inject(ModelPropertiesWidget) protected readonly widget: ModelPropertiesWidget;
    override readonly id = 'catenary-properties';
    override readonly label = 'Model properties';

    /** A Theia selection from a view editor, from an explorer (not only folders and files) or from Problems rows of an element. */
    override canHandle(selection: Object | undefined): number {
        const ours = TextEditorSelection.is(selection) && selection.uri.scheme === VIEW_NOTES_SCHEME ? true
            : GlspSelection.is(selection) ? !!viewIdOfUri(selection.sourceUri ?? '')
            : Array.isArray(selection) && selection.length > 0 && (
                (selection.every(CatenaryNode.is) && selection.some(CatenaryNode.isElement))
                || selection.every(n => n?.uri instanceof URI && n.uri.scheme === ELEMENT_SCHEME));
        return ours ? 500 : 0;
    }

    override async provideWidget(_selection: Object | undefined): Promise<ModelPropertiesWidget> {
        return this.widget;
    }

    override updateContentWidget(): void {
        this.widget.updatePropertyViewContent();
    }
}

