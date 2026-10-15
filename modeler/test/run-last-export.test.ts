import { expect, it, vi } from 'vitest';

vi.mock('@eclipse-glsp/client', () => ({ RequestExportAction: {}, GLSPSvgExporter: class {} }));
vi.mock('../src/browser/diagram/markdown-export-dialog', () => ({ MarkdownExportDialog: class {} }));
vi.mock('@theia/core/lib/browser', () => ({ ApplicationShell: class {}, ConfirmDialog: class {}, StorageService: Symbol() }));
vi.mock('@theia/filesystem/lib/browser', () => ({ FileDialogService: Symbol() }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class {} }));
vi.mock('../src/browser/model-client', () => ({ ModelFrontend: class {} }));
vi.mock('../src/browser/diagram/view-editors', () => ({ ViewEditors: class {} }));
vi.mock('../src/browser/diagram/view-widget', () => ({ ViewDiagramWidget: class {} }));

import { MarkdownExport } from '../src/browser/diagram/markdown-export';

/** A MarkdownExport with an in-memory storage and a backend whose export waits until `finish` (ok or failed). */
function fixture(workspace: string) {
    const data: Record<string, unknown> = {};
    const exports: { destination: string; finish: (ok: boolean) => void }[] = [];
    // Checks wait for `check.release()` only while `check.held` is true.
    const check = { held: false, waiting: [] as (() => void)[], release() { this.held = false; this.waiting.splice(0).forEach(r => r()); } };
    const model = {
        snapshot: { file: workspace },
        service: {
            checkMarkdownExport: async (r: { destination: string }) => (check.held && await new Promise<void>(r => check.waiting.push(r)), { ok: true, root: '/src', documents: ['a.md'], views: [], destination: r.destination, unresolved: [] }),
            exportMarkdown: (r: { destination: string }) => new Promise(resolve => exports.push({
                destination: r.destination,
                finish: ok => resolve({ ok, error: ok ? undefined : 'failed', written: [], removed: [], kept: [], problems: [], conflicts: [], overwritable: [] })
            }))
        }
    };
    const storage = { getData: async (k: string, d: unknown) => data[k] ?? d, setData: async (k: string, v: unknown) => { data[k] = v; } };
    const messages = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const exporter = Object.assign(new MarkdownExport(), { model, storage, messages, shell: { currentWidget: undefined } });
    const last = () => data['catenary.markdownExport.last'] as Record<string, { destination: string }> | undefined;
    return { exporter, model, exports, last, messages, check };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it('the last export is recorded under the workspace where the export started, also when another workspace opens during it (UI §9.2)', async () => {
    const { exporter, model, exports, last } = fixture('/a/workspace.trig');
    const running = exporter.exportSelection(['/src'], '/out-a');
    await settle();
    model.snapshot.file = '/b/workspace.trig';
    exports[0].finish(true);
    await running;
    expect(last()).toEqual({ '/a/workspace.trig': { sources: ['/src'], destination: '/out-a', exclude: [] } });
});

it('a workspace that opens during the first check keeps its own last export', async () => {
    const { exporter, model, exports, last, check } = fixture('/a/workspace.trig');
    check.held = true;
    const running = exporter.exportSelection(['/src'], '/out-a');
    model.snapshot.file = '/b/workspace.trig';
    check.release();
    await settle();
    exports[0].finish(true);
    await running;
    expect(Object.keys(last() ?? {})).toEqual(['/a/workspace.trig']);
});

it('law_failedExportKeepsLast: a failed export does not replace the last export; Run Last repeats the last one', async () => {
    const { exporter, exports, last, messages } = fixture('/a/workspace.trig');
    expect(await exporter.runLast()).toBeUndefined();
    expect(messages.info).toHaveBeenCalledWith(expect.stringMatching(/No earlier Markdown export/));

    const first = exporter.exportSelection(['/src'], '/out-1');
    await settle();
    exports[0].finish(true);
    await first;
    const failed = exporter.exportSelection(['/src'], '/out-2');
    await settle();
    exports[1].finish(false);
    await failed;
    expect(last()?.['/a/workspace.trig'].destination).toBe('/out-1');

    const again = exporter.runLast();
    await settle();
    expect(exports[2].destination).toBe('/out-1');
    exports[2].finish(true);
    await again;
});
