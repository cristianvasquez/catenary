// Frontend side of the command-line interface (see common/cli-protocol.ts): lists and runs Theia commands, reads and answers the
// prompt (dialog, quick input, picker, inline input) that a command opens, records the notifications, and evaluates code for inspection.

import { CommandRegistry, MessageService } from '@theia/core';
import { MessageType } from '@theia/core/lib/common/message-service-protocol';
import { ApplicationShell, FrontendApplicationContribution, KeybindingRegistry, Widget } from '@theia/core/lib/browser';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { inject, injectable, interfaces } from '@theia/core/shared/inversify';
import { MonacoQuickInputImplementation } from '@theia/monaco/lib/browser/monaco-quick-input-service';
import { CLI_BRIDGE_PATH, CliBridgeClient, CliBridgeServer, CliMessage, CliPrompt, CliRunResult, modelSummary } from '../common/cli-protocol';
import { ViewEditors, ViewLabels, viewIdOf } from './diagram/view-editors';
import { ModelFrontend } from './model-client';
import { SelectionModel } from './selection-model';

export const CliContainer = Symbol('CliContainer');

/** The parts of a monaco quick input that the bridge reads and sets. */
interface QuickInput {
    title?: string;
    placeholder?: string;
    prompt?: string;
    value: string;
    validationMessage?: string;
    items?: readonly { type?: string; label?: string; description?: string; detail?: string }[];
    activeItems?: readonly unknown[];
    selectedItems?: readonly unknown[];
    canSelectMany?: boolean;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

/** A JSON value for any result: no cycles, no functions, widgets and DOM nodes as short descriptions. */
export function toJson(v: unknown, depth = 0, path = new Set<object>()): unknown {
    if (v === null || v === undefined || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
    if (typeof v === 'bigint' || typeof v === 'symbol') return String(v);
    if (typeof v === 'function') return `[function ${v.name || 'anonymous'}]`;
    const o = v as object;
    if (path.has(o)) return '[cycle]';
    if (o instanceof Error) return { error: o.message };
    if (o instanceof Widget) return { widget: o.id, title: o.title.label };
    if (typeof Node !== 'undefined' && o instanceof Node) return `[${o.nodeName}]`;
    if (o.constructor?.name === 'URI') return String(o);
    if (depth > 8) return '[…]';
    path.add(o);
    try {
        if (Array.isArray(o)) return o.map(x => toJson(x, depth + 1, path));
        if (o instanceof Map) return [...o.entries()].map(e => toJson(e, depth + 1, path));
        if (o instanceof Set) return [...o].map(x => toJson(x, depth + 1, path));
        return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, toJson(x, depth + 1, path)]));
    } finally {
        path.delete(o);
    }
}

/** The text input of a dialog. Checkboxes and radio buttons are not text. */
const DIALOG_TEXT = '.dialogContent input:not([type=checkbox]):not([type=radio]), .dialogContent textarea';

@injectable()
export class CliBridge implements CliBridgeClient, FrontendApplicationContribution {
    @inject(CliContainer) protected readonly container: interfaces.Container;
    @inject(CommandRegistry) protected readonly commands: CommandRegistry;
    @inject(KeybindingRegistry) protected readonly keybindings: KeybindingRegistry;
    @inject(MessageService) protected readonly messageService: MessageService;
    @inject(MonacoQuickInputImplementation) protected readonly quickInput: MonacoQuickInputImplementation;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(SelectionModel) protected readonly selection: SelectionModel;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(ViewLabels) protected readonly labels: ViewLabels;

    protected readonly messages: CliMessage[] = [];
    protected seq = 0;
    /** The command of the last `run`, until it ends. */
    protected pending?: { command: string; since: number; before: { revision: number; dirty: boolean }; done: boolean; result?: unknown; error?: string };

    onStart(): void {
        this.recordMessages();
        const server = ServiceConnectionProvider.createProxy<CliBridgeServer>(this.container, CLI_BRIDGE_PATH, this);
        server.hello().catch(e => console.warn(`catenary CLI bridge: ${errorText(e)}`));
    }

    /** Keep each notification (last 200), with the actions it offers. */
    protected recordMessages(): void {
        const service = this.messageService as unknown as { processMessage(type: unknown, text: string, args?: unknown[]): Promise<string | undefined> };
        const process = service.processMessage.bind(service);
        service.processMessage = (type, text, args) => {
            const actions = args?.filter((a): a is string => typeof a === 'string');
            this.messages.push({ seq: ++this.seq, type: (MessageType[type as MessageType] ?? String(type)).toLowerCase(), text, ...(actions?.length ? { actions } : {}) });
            if (this.messages.length > 200) this.messages.shift();
            return process(type, text, args);
        };
    }

    async request(method: string, params: Record<string, unknown>): Promise<unknown> {
        switch (method) {
            case 'commands': return this.listCommands(params.filter as string | undefined, !!params.all);
            case 'run': return this.run(String(params.id), (params.args as unknown[] | undefined) ?? [], Number(params.timeout ?? 10000));
            case 'prompt': return this.prompt() ?? null;
            case 'answer': return this.answer(params, Number(params.timeout ?? 10000));
            case 'ui': return this.ui();
            case 'messages': return this.messages.filter(m => m.seq > Number(params.since ?? 0));
            case 'eval': return this.evaluate(String(params.code));
        }
        throw new Error(`unknown frontend method "${method}"`);
    }

    // ------------------------------------------------------------ commands

    protected listCommands(filter: string | undefined, all: boolean) {
        const f = filter?.toLowerCase();
        const test = (fn: () => boolean) => { try { return fn(); } catch { return false; } };
        return this.commands.commands
            .filter(c => !f || [c.id, c.label, c.category].some(s => s?.toLowerCase().includes(f)))
            .map(c => ({
                id: c.id, label: c.label, category: c.category,
                enabled: test(() => this.commands.isEnabled(c.id)), visible: test(() => this.commands.isVisible(c.id)),
                toggled: test(() => this.commands.isToggled(c.id)) || undefined,
                keys: [...new Set(this.keybindings.getKeybindingsForCommand(c.id).map(k => k.keybinding))]
            }))
            .filter(c => all || c.enabled)
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    protected async run(id: string, args: unknown[], timeout: number): Promise<CliRunResult> {
        // A command that waits for its prompt blocks the next one. A command that only runs long does not.
        if (this.pending && !this.pending.done && this.prompt()) {
            throw new Error(`"${this.pending.command}" waits for an answer (see prompt); answer or cancel first`);
        }
        if (!this.commands.getCommand(id)) throw new Error(`unknown command "${id}"; see "commands --all"`);
        const pending: NonNullable<CliBridge['pending']> = {
            command: id, since: this.seq, before: { revision: this.model.snapshot.revision, dirty: this.model.snapshot.dirty }, done: false
        };
        this.pending = pending;
        this.commands.executeCommand(id, ...args).then(
            r => { pending.result = r; },
            e => { pending.error = errorText(e); }
        ).finally(() => { pending.done = true; });
        return this.settle(timeout);
    }

    /** Wait until the pending command ends, opens a prompt, or the time is over. */
    protected async settle(timeout: number): Promise<CliRunResult> {
        const pending = this.pending;
        if (!pending) throw new Error('no command runs');
        const end = Date.now() + timeout;
        await sleep(50);
        while (!pending.done) {
            const prompt = this.prompt();
            if (prompt) return { status: 'waiting', command: pending.command, prompt, messages: this.messagesSince(pending.since) };
            if (Date.now() > end) return { status: 'timeout', command: pending.command, messages: this.messagesSince(pending.since) };
            await sleep(50);
        }
        // A handler that does not return its promise ends before its work: wait until the notifications and the revision are quiet
        // for 300 ms (at most 2 s).
        let seq = this.seq, revision = this.model.snapshot.revision, quiet = Date.now();
        const limit = Date.now() + 2000;
        while (Date.now() - quiet < 300 && Date.now() < limit) {
            await sleep(50);
            if (this.seq !== seq || this.model.snapshot.revision !== revision) {
                seq = this.seq;
                revision = this.model.snapshot.revision;
                quiet = Date.now();
            }
        }
        const snapshot = await this.model.service.getSnapshot();
        const model = modelSummary(snapshot);
        const { before } = pending;
        const prompt = this.prompt();
        return {
            status: pending.error !== undefined ? 'error' : prompt ? 'waiting' : 'done', command: pending.command,
            result: toJson(pending.result), error: pending.error, prompt, messages: this.messagesSince(pending.since),
            model, changed: model.revision !== before.revision || model.dirty !== before.dirty ? true : undefined
        };
    }

    protected messagesSince(seq: number): CliMessage[] {
        return this.messages.filter(m => m.seq > seq);
    }

    // ------------------------------------------------------------ prompts

    /** The dialog (topmost) or quick input that is open. */
    protected prompt(): CliPrompt | undefined {
        const dialog = this.dialog();
        if (dialog) {
            const input = dialog.querySelector<HTMLInputElement | HTMLTextAreaElement>(DIALOG_TEXT);
            return {
                kind: 'dialog',
                title: dialog.querySelector('.dialogTitle')?.textContent?.trim() || undefined,
                text: (input ? undefined : (dialog.querySelector('.dialogContent') as HTMLElement | null)?.innerText.trim()) || undefined,
                value: input?.value,
                error: dialog.querySelector('.error')?.textContent?.trim() || undefined,
                buttons: [...dialog.querySelectorAll<HTMLButtonElement>('.dialogControl button')].map(b => b.textContent?.trim() ?? '')
            };
        }
        const picker = this.picker();
        if (picker) {
            return {
                kind: 'picker', title: picker.querySelector('.title')?.textContent?.trim() || undefined,
                value: picker.querySelector('input')?.value || undefined,
                items: [...picker.querySelectorAll<HTMLElement>('.list .item')].map((el, index) => ({ index, label: el.textContent?.trim() ?? '' }))
            };
        }
        const inline = this.inlineInput();
        if (inline) return { kind: 'inline', placeholder: inline.placeholder || undefined, value: inline.value };
        const qi = this.currentQuickInput();
        if (!qi) return undefined;
        if (qi.items) {
            return {
                kind: 'quick-pick', title: qi.title, placeholder: qi.placeholder, value: qi.value || undefined,
                items: qi.items.flatMap((item, index) => item.type === 'separator' ? [] : [{ index, label: item.label ?? '', description: item.description, detail: item.detail }])
            };
        }
        return { kind: 'input-box', title: qi.title, placeholder: qi.placeholder, text: qi.prompt, value: qi.value, error: qi.validationMessage || undefined };
    }

    protected dialog(): HTMLElement | undefined {
        const overlays = [...document.querySelectorAll<HTMLElement>('.dialogOverlay')].filter(o => o.isConnected && o.getClientRects().length > 0);
        return overlays[overlays.length - 1];
    }

    protected picker(): HTMLElement | undefined {
        return document.querySelector<HTMLElement>('.catenary-popup-picker') ?? undefined;
    }

    protected inlineInput(): HTMLInputElement | undefined {
        return document.querySelector<HTMLInputElement>('input.catenary-name-input, input.catenary-embedded-input, input.catenary-inline-input, input.catenary-tab-rename') ?? undefined;
    }

    protected currentQuickInput(): QuickInput | undefined {
        const widget = document.querySelector<HTMLElement>('.quick-input-widget');
        if (!widget || widget.style.display === 'none') return undefined;
        return this.quickInput.currentQuickInput as unknown as QuickInput | undefined;
    }

    /**
     * Answer the open prompt. `text`: the input value (dialog, input box, inline) or the filter (quick pick, picker). `pick`: an item by
     * label, or `index` (see prompt). `button`: a dialog button by label (default: the main button). `cancel`: close the prompt.
     * Then wait as `run` does.
     */
    protected async answer(params: Record<string, unknown>, timeout: number): Promise<CliRunResult> {
        const text = params.text as string | undefined;
        const since = this.seq;
        const before = { revision: this.model.snapshot.revision, dirty: this.model.snapshot.dirty };
        const dialog = this.dialog();
        const picker = dialog ? undefined : this.picker();
        const inline = dialog || picker ? undefined : this.inlineInput();
        const qi = dialog || picker || inline ? undefined : this.currentQuickInput();
        if (!dialog && !picker && !inline && !qi) throw new Error('no prompt is open');
        const type = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            // The Theia file dialog validates the file name on keyup.
            input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            await sleep(100);
        };
        const key = (input: HTMLElement, k: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        if (picker) {
            const input = picker.querySelector('input');
            if (params.cancel) {
                if (input) key(input, 'Escape');
            } else {
                const pick = params.pick as string | undefined;
                if (input && (text ?? pick) !== undefined) await type(input, (text ?? pick)!);
                const items = [...picker.querySelectorAll<HTMLElement>('.list .item')];
                const item = params.index !== undefined ? items[Number(params.index)]
                    : pick !== undefined ? (items.find(i => i.textContent?.trim() === pick) ?? items[0]) : items[0];
                if (!item) throw new Error(`no item "${pick ?? params.index ?? ''}"; see prompt`);
                item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            }
        } else if (inline) {
            if (params.cancel) {
                key(inline, 'Escape');
            } else {
                if (text !== undefined) await type(inline, text);
                key(inline, 'Enter');
            }
        } else if (dialog) {
            if (params.cancel) {
                dialog.querySelector<HTMLElement>('.closeButton')?.click();
            } else {
                const input = dialog.querySelector<HTMLInputElement | HTMLTextAreaElement>(DIALOG_TEXT);
                if (text !== undefined) {
                    if (!input) throw new Error('the dialog has no input');
                    await type(input, text);
                }
                const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('.dialogControl button')];
                const label = params.button as string | undefined;
                const button = label ? buttons.find(b => b.textContent?.trim().toLowerCase() === label.toLowerCase()) : buttons.find(b => b.classList.contains('main'));
                if (!button) throw new Error(`no button "${label ?? 'main'}"; buttons: ${buttons.map(b => b.textContent?.trim()).join(', ')}`);
                button.click();
            }
        } else if (qi) {
            if (params.cancel) {
                await this.quickInput.cancel();
            } else {
                if (text !== undefined) {
                    qi.value = text;
                    await sleep(100);
                }
                if (qi.items) {
                    const items = qi.items.filter(i => i.type !== 'separator');
                    const pick = params.pick as string | undefined;
                    const item = params.index !== undefined ? qi.items[Number(params.index)]
                        : pick !== undefined ? (items.find(i => i.label === pick) ?? items.find(i => i.label?.toLowerCase().includes(pick.toLowerCase())))
                        : (qi.activeItems?.[0] as typeof items[number] | undefined);
                    if (!item || item.type === 'separator') throw new Error(`no item "${pick ?? params.index ?? '(active)'}"; see prompt`);
                    qi.activeItems = [item];
                    if (qi.canSelectMany) qi.selectedItems = [item];
                }
                await this.quickInput.accept();
            }
        }
        // A prompt that stays open after its command ended (an input in a card), or one that the user opened: report from here.
        if (!this.pending || this.pending.done) this.pending = { command: this.pending?.command ?? '(prompt)', since, before, done: true };
        return this.settle(timeout);
    }

    // ------------------------------------------------------------ inspection

    protected ui() {
        const describe = (w?: Widget) => w ? { id: w.id, title: w.title.label } : undefined;
        return {
            // activeWidget follows the DOM focus; it does not change while the window has no focus. currentWidget: the selected main tab.
            activeWidget: describe(this.shell.activeWidget), currentWidget: describe(this.shell.currentWidget),
            currentView: this.editors.currentViewId(),
            openViews: this.editors.all().map(w => ({ id: viewIdOf(w), label: this.labels.labels[viewIdOf(w)] })),
            selection: this.selection.selection,
            prompt: this.prompt(),
            pendingCommand: this.pending && !this.pending.done ? this.pending.command : undefined,
            model: modelSummary(this.model.snapshot)
        };
    }

    /**
     * Evaluate JavaScript in this window. An expression, or statements with `return`. In scope: `ctx` with container, get(symbol),
     * commands, model (ModelFrontend), selection, editors (ViewEditors), shell. The value may be a promise.
     */
    protected async evaluate(code: string): Promise<unknown> {
        const ctx = {
            container: this.container, get: (id: interfaces.ServiceIdentifier) => this.container.get(id),
            commands: this.commands, model: this.model, selection: this.selection, editors: this.editors, shell: this.shell
        };
        let fn: (ctx: unknown) => Promise<unknown>;
        try {
            fn = new Function('ctx', `return (async () => (${code}))();`) as typeof fn;
        } catch {
            fn = new Function('ctx', `return (async () => { ${code} })();`) as typeof fn;
        }
        return toJson(await fn(ctx));
    }
}
