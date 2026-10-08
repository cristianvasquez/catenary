// Workspace settings view (ADR 0004): the manifest of the workspace file, in the main area. It opens on the workspace file (double-click
// in the file navigator, File → Workspace Settings). Sections: the file of new subjects by kind (Auto or a file,
// PlaceBox; Everything else also sets the default file), the prefixes (ModelStore.setPrefixes), the exclude globs (ModelStore.setSettings), the
// imported globs and Import (ModelStore.setSettings, importFiles), the views of the HTML export in order (ModelStore.setExportViews). Each change writes the manifest at once (ADR 0003). No change is an undo step.

import { CommandService, URI } from '@theia/core';
import { AbstractViewContribution, ReactWidget } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common/message-service';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { FileDialogService } from '@theia/filesystem/lib/browser';
import { FileNavigatorContribution } from '@theia/navigator/lib/browser/navigator-contribution';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { DEFAULT_PREFIXES, NEAR_KIND, baseName, dirName, relativePath } from '@catenary/model';
import { WorkspaceSettings } from '../../common/protocol';
import { OrderRow, initialRows, setAllChecked } from '../../common/view-order';
import { ViewOrderList } from '../diagram/view-order-list';
import { ViewsExport } from '../diagram/views-export';
import { ModelFrontend } from '../model-client';
import { Button, Section, Warning } from '../properties/controls';
import { PLACE_ROWS, PlaceBox, PlaceKind } from './workspace-placement';

export const WORKSPACE_SETTINGS_ID = 'catenary-workspace-settings';

/** Commands of commands.ts (not imported: commands.ts imports this module). */
const SHOW_TEXT = 'catenary.showText';
const IMPORT_FILE = 'catenary.importFile';

/** Extensions of the Browse… dialog of a file of new subjects: the formats that Catenary writes (rdf-files RDF_FORMATS). */
const RDF_FILTER = { 'RDF files': ['ttl', 'turtle', 'trig', 'nt', 'nq', 'jsonld', 'json'] };

/** From this number of prefixes, a filter field shows above the list. */
const FILTER_FROM = 12;

@injectable()
export class WorkspaceSettingsWidget extends ReactWidget {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(CommandService) protected readonly commands: CommandService;
    @inject(FileDialogService) protected readonly fileDialog: FileDialogService;
    @inject(FileNavigatorContribution) protected readonly navigator: FileNavigatorContribution;
    @inject(ViewsExport) protected readonly viewsExport: ViewsExport;
    @inject(WorkspaceService) protected readonly workspace: WorkspaceService;

    /** Message of a rejected change, by row: a kind, 'prefix', 'exclude', 'imported', 'export'. Cleared by the next change of the row. */
    protected problems: Record<string, string | undefined> = {};
    /** The prefix row in edit mode. */
    protected editing?: string;
    protected filter = '';
    protected menuOpen = false;
    /** All views in view order, with the folders of their files. Read again when the model changes and the view is visible. */
    protected views: { id: string; label: string; folder: string }[] = [];

    @postConstruct()
    protected init(): void {
        this.id = WORKSPACE_SETTINGS_ID;
        this.title.label = 'Workspace';
        this.title.caption = 'Settings of the workspace file (manifest): files of new subjects, prefixes, exclude, HTML export';
        this.title.iconClass = 'codicon codicon-settings';
        this.title.closable = true;
        this.addClass('catenary-properties');
        this.addClass('catenary-workspace-settings');
        this.toDispose.push(this.model.onDidChange(() => {
            if (this.isVisible) void this.readViews();
            this.update();
        }));
        const close = (e: MouseEvent) => {
            if (this.menuOpen && !(e.target instanceof Element && e.target.closest('.catenary-toolbar-more'))) { this.menuOpen = false; this.update(); }
        };
        document.addEventListener('mousedown', close);
        this.toDispose.push({ dispose: () => document.removeEventListener('mousedown', close) });
        this.update();
    }

    protected override onAfterShow(msg: Parameters<ReactWidget['onAfterShow']>[0]): void {
        super.onAfterShow(msg);
        void this.readViews();
    }

    protected async readViews(): Promise<void> {
        if (!this.model.isOpen) return;
        const views = await this.viewsExport.views();
        if (JSON.stringify(views) === JSON.stringify(this.views)) return;
        this.views = views;
        this.update();
    }

    /** Runs a change of row `key`; a rejection shows its message below the row. */
    protected async report(key: string, result: Promise<{ ok: boolean; error?: string }>): Promise<boolean> {
        const r = await result;
        this.problems = { ...this.problems, [key]: r.ok ? undefined : r.error };
        this.update();
        return r.ok;
    }

    protected setSettings(key: string, settings: WorkspaceSettings): Promise<boolean> {
        return this.report(key, this.model.service.setSettings(settings));
    }

    protected setPrefixes(table: Record<string, string>): Promise<boolean> {
        return this.report('prefix', this.model.service.setPrefixes(table));
    }

    /** The table with the row `prefix` replaced (undefined `to`: removed), in the same place. */
    protected change(prefix: string, to?: [string, string]): Record<string, string> {
        return Object.fromEntries(Object.entries(this.model.snapshot.prefixes.table).flatMap(([p, ns]) => p === prefix ? (to ? [to] : []) : [[p, ns]]));
    }

    /** A path relative to the folder of the workspace file. */
    protected rel(path: string): string {
        const file = this.model.snapshot.file;
        return (file && relativePath(dirName(file), path)) ?? path;
    }

    /** Browse… of a file of new subjects: a file dialog in the workspace folder. The answer: the path relative to that folder. */
    protected async browse(title: string): Promise<string | undefined> {
        const root = (await this.workspace.roots)[0];
        const uri = await this.fileDialog.showOpenDialog({ title, canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: RDF_FILTER }, root);
        return uri ? this.rel(uri.path.fsPath()) : undefined;
    }

    protected render(): React.ReactNode {
        const s = this.model.snapshot;
        if (!this.model.isOpen || !s.files.workspace) return <div className='theia-widget-noInfo'>No workspace is open.</div>;
        return <div className='catenary-props'>
            <div className='catenary-settings'>
                {this.head()}
                {this.status()}
                {this.placesSection()}
                {this.prefixSection()}
                {this.excludeSection()}
                {this.importedSection()}
                {this.exportSection()}
            </div>
        </div>;
    }

    protected head(): React.ReactNode {
        const s = this.model.snapshot, ws = s.files.workspace!;
        const folder = dirName(ws.path);
        return <div className='catenary-settings-head'>
            <div>
                <div className='kind'>Workspace file</div>
                <div className='title'>{baseName(ws.path)}</div>
                <div className='catenary-help'>{folder} · {s.files.files.length} model files · each change writes the file at once, no undo</div>
            </div>
            <div className='catenary-toolbar'>
                <button className='catenary-tool' title='Show Text' aria-label='Show Text' onClick={() => this.commands.executeCommand(SHOW_TEXT, this)}>
                    <span className='codicon codicon-file-code' />
                </button>
                <button className='catenary-tool' title='Select in Explorer' aria-label='Select in Explorer' onClick={async () => {
                    await this.navigator.openView({ activate: true, reveal: true });
                    await this.navigator.selectFileNode(URI.fromFilePath(ws.path));
                }}><span className='codicon codicon-list-tree' /></button>
                <span className='catenary-toolbar-separator' />
                <div className='catenary-toolbar-more'>
                    <button className={`catenary-tool${this.menuOpen ? ' on' : ''}`} title='More actions' aria-label='More actions' aria-haspopup='menu'
                        aria-expanded={this.menuOpen} onClick={() => { this.menuOpen = !this.menuOpen; this.update(); }}><span className='codicon codicon-ellipsis' /></button>
                    {this.menuOpen ? <div className='catenary-menu' role='menu'>
                        <button role='menuitem' onClick={() => { this.menuOpen = false; void this.setPrefixes({ ...DEFAULT_PREFIXES }); }}>
                            <span>Reset Prefixes to Defaults</span>
                        </button>
                    </div> : undefined}
                </div>
            </div>
        </div>;
    }

    /** The workspace file is not on disk, or it declares no prefixes. */
    protected status(): React.ReactNode {
        const s = this.model.snapshot;
        const items = [
            ...(s.files.workspace!.onDisk ? [] : ['The workspace file is not on disk. The first change of a setting writes it.']),
            ...(s.prefixes.stored ? [] : ['Prefixes use the default table. The workspace file declares no prefixes.'])
        ];
        if (!items.length) return undefined;
        return <Warning title='Workspace file' items={items}
            more={s.prefixes.stored ? undefined : <div className='catenary-buttons'><Button label='Store in Workspace' onClick={() => this.setPrefixes(s.prefixes.table)} /></div>} />;
    }

    /**
     * One box per kind. "Everything else" also sets the default file (the file of a subject that Auto cannot place): File sets both to
     * the file, Auto sets the kind to near and clears the default file.
     */
    protected placesSection(): React.ReactNode {
        const s = this.model.snapshot, placement = s.files.placement!, d = s.files.defaultFile;
        const name = baseName(s.files.workspace!.path).replace(/\.trig$/, '');
        const place = (kind: PlaceKind) => placement[kind] === NEAR_KIND ? NEAR_KIND : this.rel(placement[kind]);
        const settings = (kind: PlaceKind, v: string): WorkspaceSettings => kind !== 'instances' ? { placement: { [kind]: v } }
            : { placement: { instances: v }, defaultFile: v === NEAR_KIND ? '' : v };
        const rule = (kind: PlaceKind, near: string) => kind === 'instances' && d ? `${near}, else ${this.rel(d.path)}` : near;
        return <Section title='New subjects' scope='new subjects only'
            help='The file where Catenary writes a new subject of each kind. A path that does not exist makes a new file at the first write. Everything else also takes a shape or concept that Auto cannot place.'>
            <div className='catenary-places'>
                {PLACE_ROWS.map(r => <PlaceBox key={r.kind} label={r.label} rule={rule(r.kind, r.near)} value={place(r.kind)} proposal={`${name}.${r.suffix}.ttl`}
                    problem={this.problems[r.kind]} onChange={v => this.setSettings(r.kind, settings(r.kind, v))}
                    onBrowse={() => this.browse(`File for ${r.label}`)} />)}
            </div>
        </Section>;
    }

    protected prefixSection(): React.ReactNode {
        const { table } = this.model.snapshot.prefixes;
        const all = Object.entries(table).sort(([a], [b]) => a.localeCompare(b));
        const f = this.filter.toLowerCase();
        const rows = f ? all.filter(([p, ns]) => p.toLowerCase().includes(f) || ns.toLowerCase().includes(f)) : all;
        return <Section title={`Prefixes ${all.length}`} help='Prefixes of the workspace (sh:declare in the manifest). Compact IRIs, IRI inputs and the writers use them.'>
            {all.length >= FILTER_FROM ? <input className='theia-input catenary-settings-filter' type='search' placeholder='Filter prefixes' value={this.filter}
                onChange={e => { this.filter = e.currentTarget.value; this.update(); }} /> : undefined}
            <div className='catenary-settings-list'>
                {rows.map(([prefix, ns]) => prefix === this.editing
                    ? <PrefixEdit key={prefix} prefix={prefix} namespace={ns} onCancel={() => { this.editing = undefined; this.update(); }}
                        onCommit={async (p, n) => {
                            if (p !== prefix && table[p] !== undefined) return void this.report('prefix', Promise.resolve({ ok: false, error: `The prefix "${p}" exists.` }));
                            if (await this.setPrefixes(this.change(prefix, [p, n]))) { this.editing = undefined; this.update(); }
                        }} />
                    : <div key={prefix} className='catenary-settings-row prefix'>
                        <code>{prefix}:</code>
                        <code className='ns' title={ns}>{ns}{/[#/]$/.test(ns) ? undefined
                            : <span className='codicon codicon-warning catenary-settings-warn' title='The namespace does not end with / or #.' />}</code>
                        <span className='acts'>
                            <span className='codicon codicon-edit action-label catenary-icon-button' role='button' title={`Edit ${prefix}:`}
                                onClick={() => { this.editing = prefix; this.update(); }} />
                            <span className='codicon codicon-close action-label catenary-icon-button' role='button' title={`Remove ${prefix}:`}
                                onClick={() => this.setPrefixes(this.change(prefix))} />
                        </span>
                    </div>)}
                <AddRow fields={['prefix', 'namespace IRI']} problem={this.problems.prefix} onAdd={async ([p, n]) => {
                    if (!p || !n) return this.report('prefix', Promise.resolve({ ok: false, error: 'Enter a prefix and a namespace IRI.' }));
                    if (table[p] !== undefined) return this.report('prefix', Promise.resolve({ ok: false, error: `The prefix "${p}" exists. Edit its row, or enter another prefix.` }));
                    return this.setPrefixes({ ...table, [p]: n });
                }} />
            </div>
            {f && rows.length < all.length ? <div className='catenary-help'>The filter shows {rows.length} of {all.length}.</div> : undefined}
        </Section>;
    }

    protected excludeSection(): React.ReactNode {
        const exclude = this.model.snapshot.files.exclude ?? [];
        return <Section title={`Exclude ${exclude.length}`} scope='reads the folder again'
            help='Files of the folder that are not model files. Globs relative to the workspace folder: *, **, ?'>
            <div className='catenary-settings-list'>
                {exclude.map(g => <div key={g} className='catenary-settings-row glob'>
                    <code>{g}</code>
                    <span className='acts'><span className='codicon codicon-close action-label catenary-icon-button' role='button' title={`Remove ${g}`}
                        onClick={() => this.setSettings('exclude', { exclude: exclude.filter(x => x !== g) })} /></span>
                </div>)}
                <AddRow fields={['glob, for example drafts/**']} problem={this.problems.exclude} onAdd={async ([g]) => {
                    if (!g) return this.report('exclude', Promise.resolve({ ok: false, error: 'Enter a glob.' }));
                    if (exclude.includes(g)) return this.report('exclude', Promise.resolve({ ok: false, error: `The glob "${g}" exists.` }));
                    return this.setSettings('exclude', { exclude: [...exclude, g] });
                }} />
            </div>
        </Section>;
    }

    /** The imported globs: read-only files that Catenary reads and does not change. Import adds the path of each copy. */
    protected importedSection(): React.ReactNode {
        const imported = this.model.snapshot.files.imported ?? [];
        const count = this.model.snapshot.files.files.filter(f => f.imported).length;
        return <Section title={`Imported ${imported.length}`} scope={`${count} model ${count === 1 ? 'file' : 'files'}`}
            help='Files that Catenary reads and does not change: an edit of their statements is refused. New statements about their subjects go to the file of Everything else. Globs relative to the workspace folder: *, **, ?'>
            <div className='catenary-settings-list'>
                {imported.map(g => <div key={g} className='catenary-settings-row glob'>
                    <code>{g}</code>
                    <span className='acts'><span className='codicon codicon-close action-label catenary-icon-button' role='button' title={`Remove ${g}`}
                        onClick={() => this.setSettings('imported', { imported: imported.filter(x => x !== g) })} /></span>
                </div>)}
                <AddRow fields={['glob, for example official/**']} problem={this.problems.imported} onAdd={async ([g]) => {
                    if (!g) return this.report('imported', Promise.resolve({ ok: false, error: 'Enter a glob.' }));
                    if (imported.includes(g)) return this.report('imported', Promise.resolve({ ok: false, error: `The glob "${g}" exists.` }));
                    return this.setSettings('imported', { imported: [...imported, g] });
                }} />
            </div>
            <div className='catenary-buttons'>
                <Button label='Import Files…' onClick={() => this.commands.executeCommand(IMPORT_FILE)} />
                <span className='catenary-help'>Copies RDF files to imported/ as Turtle, with IRIs for their blank nodes, and marks the copies as imported.</span>
            </div>
        </Section>;
    }

    protected exportSection(): React.ReactNode {
        const views = this.views;
        if (!views.length) return undefined;
        const order = views.map(v => v.id);
        const rows = initialRows(views, this.model.snapshot.exportViews ?? []);
        const checked = rows.filter(r => r.checked).map(r => r.id);
        const store = (next: OrderRow[]) => this.report('export', this.model.service.setExportViews(next.filter(r => r.checked).map(r => r.id)));
        return <Section title={`HTML export ${checked.length} of ${views.length}`} scope='order of Export Views as HTML'>
            <div className='catenary-view-order-bar'>
                <span className='catenary-help'>Drag a numbered row, or press Alt+↑ or Alt+↓ on it. A check adds the view at the end.</span>
                <button className='theia-button secondary' onClick={() => store(setAllChecked(rows, true, order))}>All</button>
                <button className='theia-button secondary' onClick={() => store(setAllChecked(rows, false, order))}>None</button>
                <button className='theia-button main' disabled={!checked.length} title='Export the checked views in this order'
                    onClick={() => this.viewsExport.exportHtml(checked)}><span className='codicon codicon-export' /> Export…</button>
            </div>
            <ViewOrderList rows={rows} order={order} offHeading='Not exported' onChange={store} />
            {this.problems.export ? <div className='catenary-problem'><span className='codicon codicon-warning' /> {this.problems.export}</div> : undefined}
        </Section>;
    }
}

/** A prefix row in edit mode. Enter or ✓ saves both fields; Escape or ↺ cancels. */
function PrefixEdit(p: { prefix: string; namespace: string; onCommit: (prefix: string, namespace: string) => void; onCancel: () => void }) {
    const [prefix, setPrefix] = React.useState(p.prefix);
    const [ns, setNs] = React.useState(p.namespace);
    const commit = () => p.onCommit(prefix.trim(), ns.trim());
    const keys = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') p.onCancel();
    };
    return <div className='catenary-settings-row prefix editing'>
        <input className='theia-input' autoFocus value={prefix} aria-label='Prefix' onChange={e => setPrefix(e.currentTarget.value)} onKeyDown={keys} />
        <input className='theia-input' value={ns} aria-label='Namespace IRI' onChange={e => setNs(e.currentTarget.value)} onKeyDown={keys} />
        <span className='acts'>
            <span className='codicon codicon-check action-label catenary-icon-button' role='button' title='Save (Enter)' onClick={commit} />
            <span className='codicon codicon-discard action-label catenary-icon-button' role='button' title='Cancel (Escape)' onClick={p.onCancel} />
        </span>
    </div>;
}

/** The last row of a list: one input per field and "+ Add". Enter in an input adds too. The fields clear when `onAdd` returns true. */
function AddRow(p: { fields: string[]; problem?: string; onAdd: (values: string[]) => Promise<boolean> }) {
    const [values, setValues] = React.useState(() => p.fields.map(() => ''));
    const add = async () => {
        if (await p.onAdd(values.map(v => v.trim()))) setValues(p.fields.map(() => ''));
    };
    return <div className={`catenary-settings-row add${p.fields.length > 1 ? ' prefix' : ' glob'}`}>
        {p.fields.map((f, i) => <input key={f} className='theia-input' placeholder={f} aria-label={f} value={values[i]}
            onChange={e => { const v = e.currentTarget.value; setValues(vs => vs.map((x, j) => (j === i ? v : x))); }}
            onKeyDown={e => { if (e.key === 'Enter') void add(); }} />)}
        <button className='theia-button secondary catenary-add' title='Add (Enter)' onClick={() => void add()}><span className='codicon codicon-add' /> Add</button>
        {p.problem ? <div className='catenary-problem'><span className='codicon codicon-warning' /> {p.problem}</div> : undefined}
    </div>;
}

/** File → Workspace Settings, and the open handler of the workspace file (commands.ts). */
@injectable()
export class WorkspaceSettingsContribution extends AbstractViewContribution<WorkspaceSettingsWidget> {
    constructor() {
        super({
            widgetId: WORKSPACE_SETTINGS_ID, widgetName: 'Workspace',
            defaultWidgetOptions: { area: 'main' },
            toggleCommandId: 'catenary.workspaceSettings'
        });
    }
}
