// Placement of new subjects (ADR 0004), by kind: Auto (near its kind, NEAR_KIND) or a file. PlaceBox is one kind in the Workspace
// settings view and in the dialog of a new workspace. The workspace file holds the manifest only. The same dialog asks the placement
// when a folder without a workspace file opens (WorkspaceFileQuestion).

import { DialogError, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import React from '@theia/core/shared/react';
import { FileKind, NEAR_KIND, baseName } from '@catenary/model';
import { ModelFrontend } from '../model-client';
import { TextInput } from '../properties/controls';

export type PlaceKind = 'shapes' | 'concepts' | 'instances';
/** By kind: `NEAR_KIND`, or a path relative to the folder of the workspace file. */
export type Places = Record<PlaceKind, string>;

/** The kinds in display order: label, suffix of the proposed file, the file that Auto selects. */
export const PLACE_ROWS: { kind: PlaceKind; label: string; suffix: string; near: string }[] = [
    { kind: 'shapes', label: 'Shapes', suffix: 'shapes', near: 'the file with most node shapes' },
    { kind: 'concepts', label: 'SKOS / Collections', suffix: 'skos', near: 'the file of the scheme or collection' },
    { kind: 'instances', label: 'Everything else', suffix: 'data', near: 'the file with most subjects of the class' }
];

/**
 * The proposal for a workspace `<name>.trig`: `<name>.shapes.ttl`, `<name>.skos.ttl`, everything else near its kind. `present`: kinds
 * that model files of the folder contain already. Shapes or SKOS resources in the folder: near their kind (where they are).
 */
export function proposedPlaces(name: string, present: FileKind[] = []): Places {
    return {
        shapes: present.includes('shapes') ? NEAR_KIND : `${name}.shapes.ttl`,
        concepts: present.includes('concepts') ? NEAR_KIND : `${name}.skos.ttl`,
        instances: NEAR_KIND
    };
}

/**
 * One kind: Auto, or File with a path and Browse… `value`: NEAR_KIND (Auto) or a path relative to the workspace folder. `proposal`: the
 * path that File selects first. `rule`: the text after Auto. Without `onBrowse`, no Browse button.
 */
export function PlaceBox(p: {
    label: string; rule: string; value: string; proposal: string; onChange: (value: string) => void; onBrowse?: () => Promise<string | undefined>;
    problem?: string; help?: string
}) {
    const auto = p.value === NEAR_KIND;
    const group = React.useId();
    return <fieldset className='catenary-place'>
        <legend>{p.label}{p.help ? <span className='codicon codicon-question catenary-help-icon' title={p.help} /> : undefined}</legend>
        <label className='catenary-place-option'>
            <input type='radio' name={group} checked={auto} onChange={() => p.onChange(NEAR_KIND)} />
            Auto <span className='catenary-place-rule'>· {p.rule}</span>
        </label>
        <label className={`catenary-place-option file${auto ? ' off' : ''}`}>
            <input type='radio' name={group} checked={!auto} onChange={() => p.onChange(p.proposal)} />
            File
            {auto ? <input className='theia-input' type='text' disabled value={p.proposal} aria-label={`${p.label} file`} />
                : <TextInput value={p.value} placeholder='path in the workspace folder' onCommit={v => { if (v.trim()) p.onChange(v.trim()); }} />}
            {p.onBrowse ? <button className='theia-button secondary' disabled={auto} onClick={async e => {
                e.preventDefault();
                const path = await p.onBrowse!();
                if (path) p.onChange(path);
            }}>Browse…</button> : undefined}
        </label>
        {p.problem ? <div className='catenary-problem'><span className='codicon codicon-warning' /> {p.problem}</div> : undefined}
    </fieldset>;
}

export interface PlacementDialogOptions {
    title: string;
    /** The first line of the dialog. */
    intro: string;
    accept: string;
    present?: FileKind[];
}

/** Dialog of a new workspace: the file of each kind, or near its kind. The answer: the placement for `ModelService.create`. */
export class NewWorkspaceDialog extends ReactDialog<Places> {
    protected places: Places;
    /** The last file of a kind: "File" again after "Near its kind" shows it. */
    protected readonly files: Places;

    /** `name`: the workspace file without `.trig`. */
    constructor(protected readonly name: string, protected readonly options: PlacementDialogOptions = {
        title: 'New Workspace', intro: 'Where Catenary writes new subjects.', accept: 'Create'
    }) {
        super({ title: options.title });
        this.places = proposedPlaces(name, options.present);
        this.files = { shapes: `${name}.shapes.ttl`, concepts: `${name}.skos.ttl`, instances: `${name}.data.ttl` };
        this.contentNode.classList.add('catenary-new-workspace');
        this.appendCloseButton('Cancel');
        this.appendAcceptButton(options.accept);
    }

    get value(): Places {
        return { ...this.places };
    }

    protected override isValid(value: Places): DialogError {
        const empty = PLACE_ROWS.find(r => !value[r.kind].trim());
        return empty ? `${empty.label}: enter a file path or select Auto.` : '';
    }

    protected set(kind: PlaceKind, place: string): void {
        if (place !== NEAR_KIND) this.files[kind] = place;
        this.places = { ...this.places, [kind]: place };
        this.update();
        this.validate();
    }

    protected render(): React.ReactNode {
        return <div className='catenary-props'>
            <div className='catenary-help'>{this.options.intro} Paths are relative to the folder of the workspace file <code>{this.name}.trig</code>. You can change all of this later in the Workspace settings.</div>
            <div className='catenary-places'>
                {PLACE_ROWS.map(r => <PlaceBox key={r.kind} label={r.label} rule={r.near} value={this.places[r.kind]} proposal={this.files[r.kind]}
                    onChange={v => this.set(r.kind, v)} />)}
            </div>
        </div>;
    }
}

/**
 * A folder without a workspace file opened (ADR 0004: default settings, not on disk): ask once for each folder in this window for the
 * placement of new subjects. Create writes the workspace file. Cancel keeps the default settings; a later settings change writes it.
 */
@injectable()
export class WorkspaceFileQuestion implements FrontendApplicationContribution {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;

    protected readonly asked = new Set<string>();

    onStart(): void {
        this.model.onDidChange(s => {
            const ws = s.files.workspace;
            if (!ws || ws.onDisk || this.asked.has(ws.path)) return;
            this.asked.add(ws.path);
            void this.ask(ws.path);
        });
    }

    protected async ask(workspace: string): Promise<void> {
        const name = baseName(workspace).replace(/\.trig$/, '');
        const present = [...new Set(this.model.snapshot.files.files.flatMap(f => f.kinds))];
        const places = await new NewWorkspaceDialog(name, {
            title: 'Set Up Workspace', accept: 'Set Up', present,
            intro: `Welcome to Catenary. Choose where new shapes, SKOS resources and other subjects go. Catenary keeps these settings in ${name}.trig.`
        }).open();
        if (!places || this.model.snapshot.files.workspace?.path !== workspace) return;
        await this.model.report(this.model.service.setSettings({ placement: places }));
    }
}
