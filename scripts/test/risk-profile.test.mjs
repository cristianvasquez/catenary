// The risk profiles of representative changes (commits of this repository). A rule change must keep these answers, or change
// this table in the same commit.
import { describe, expect, it } from 'vitest';
import { classify, gate, glob, pathProfile, plan, testSelection } from '../risk-profile.mjs';

const change = (paths, added = {}) => ({ files: paths.map(p => (typeof p === 'string' ? { status: 'M', path: p } : p)), added });
const profileOf = (paths, added, labels) => classify({ ...change(paths, added), labels }).profile;

describe('risk profile of a change', () => {
    it.each([
        ['typo in the user guide', ['docs/user-guide.md'], 'docs'],
        ['row in open work', ['spec/open.md'], 'docs'],
        ['61bea66 translucent cards (CSS only)', ['modeler/css/modeler.css'], 'cosmetic'],
        ['1461f47 color constant in TypeScript', ['modeler/src/browser/diagram/card-chrome.ts'], 'standard'],
        ['532bdf6 default line style', ['docs/user-guide.md', 'modeler/src/browser/diagram/edge-preferences.ts', 'modeler/test/edge-preferences.test.ts', 'spec/ui-manifest.hs'], 'standard'],
        ['manifest edit (GHC typechecks it)', ['spec/manifest.hs'], 'standard'],
        ['pure model rule', ['packages/model/src/labels.ts'], 'standard'],
        ['example workspace', ['examples/bookshop/workspace.trig'], 'standard'],
        ['unknown file', ['.osg.yaml'], 'standard'],
        ['TriG view writer', ['packages/rdf/src/trig.ts'], 'critical'],
        ['Turtle text patch', ['packages/rdf-files/src/text-patch.ts'], 'critical'],
        ['test fixture', ['packages/rdf/test/fixtures/data.ttl'], 'critical'],
        ['markdown inside fixtures is data', ['packages/rdf/test/fixtures/notes.md'], 'critical'],
        ['CLI token check', ['modeler/src/node/cli-token-validator.ts'], 'critical'],
        ['RPC protocol', ['modeler/src/common/protocol.ts'], 'critical'],
        ['edit commands', ['packages/model/src/commands.ts'], 'critical'],
        ['b0ef2ef shacl-engine patch', ['patches/shacl-engine@1.1.2.patch', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'], 'platform'],
        ['3dcb616 bookshop example', ['examples/bookshop/workspace.trig', 'scripts/desktop.sh', 'scripts/smoke-desktop.mjs'], 'platform'],
        ['0bd276c AppImage', ['.github/workflows/release.yml'], 'platform'],
        ['the classifier itself', ['scripts/risk-profile.mjs'], 'platform'],
        ['Electron main', ['modeler/src/electron-main/electron-main-module.ts'], 'platform'],
        ['highest file wins', ['docs/user-guide.md', 'modeler/css/modeler.css', 'packages/rdf/src/ops.ts'], 'critical']
    ])('%s → %s', (_name, paths, expected) => {
        expect(profileOf(paths)).toBe(expected);
    });

    it('tripwires raise a low path profile, never lower it', () => {
        const file = 'modeler/src/browser/panel.ts';
        expect(profileOf([file], { [file]: ["import { writeFileSync } from 'node:fs';"] })).toBe('critical');
        expect(profileOf([file], { [file]: ['const NS = "http://example.org/ns#";'] })).toBe('critical');
        expect(profileOf([file], { [file]: ['const a = 1;'] })).toBe('standard');
        expect(profileOf(['modeler/test/a.test.ts'], { 'modeler/test/a.test.ts': [`it.${'skip'}('x', () => {});`] })).toBe('critical');
    });

    it('a deleted test, a move in packages/ and a large change raise the profile', () => {
        expect(profileOf([{ status: 'D', path: 'modeler/test/layout.test.ts' }])).toBe('critical');
        expect(profileOf([{ status: 'R', from: 'packages/model/src/a.ts', path: 'packages/model/src/b.ts' }])).toBe('critical');
        expect(profileOf(Array.from({ length: 21 }, (_, i) => `docs/p${i}.md`))).toBe('standard');
    });

    it('labels raise only; .only fails; no files or the kill switch run everything', () => {
        expect(profileOf(['docs/a.md'], {}, ['risk:critical'])).toBe('critical');
        expect(profileOf(['packages/rdf/src/trig.ts'], {}, ['risk:low', 'risk:docs'])).toBe('critical');
        expect(classify(change(['modeler/test/a.test.ts'], { 'modeler/test/a.test.ts': [`it.${'only'}('x', () => {});`] })).errors).toHaveLength(1);
        expect(classify(change([])).profile).toBe('platform');
        expect(classify({ ...change(['docs/a.md']), off: true }).profile).toBe('platform');
    });

    it('glob', () => {
        expect(glob('**/*.md').test('readme.md')).toBe(true);
        expect(glob('**/*.md').test('a/b/c.md')).toBe(true);
        expect(glob('packages/model/src/{commands,ids}.ts').test('packages/model/src/ids.ts')).toBe(true);
        expect(glob('packages/model/src/{commands,ids}.ts').test('packages/model/src/labels.ts')).toBe(false);
        expect(glob('modeler/**/*.{ts,tsx}').test('modeler/src/a/b.tsx')).toBe(true);
        expect(pathProfile('README.MD').profile).toBe('standard');
    });
});

describe('CI plan', () => {
    const files = paths => paths.map(path => ({ status: 'M', path }));

    it('docs: no job after classify; cosmetic: the fast job only', () => {
        const docs = plan({ profile: 'docs', files: files(['docs/a.md']) });
        expect([docs.fast, docs.unit, docs.build, docs.e2e]).toEqual(['', '', '', '']);
        const css = plan({ profile: 'cosmetic', files: files(['modeler/css/modeler.css']) });
        expect([css.fast, css.check, css.unit, css.build]).toEqual(['required', false, '', '']);
    });

    it('standard: affected tests, app build, e2e optional for browser files', () => {
        const p = plan({ profile: 'standard', files: files(['modeler/src/browser/diagram/card-chrome.ts']) });
        expect([p.affected, p.unit, p.build, p.electron, p.e2e, p.cli]).toEqual(['required', '', 'required', false, 'optional', '']);
        expect(plan({ profile: 'standard', files: files(['packages/model/src/labels.ts']) }).unit).toBe('required');
        expect(plan({ profile: 'standard', files: files(['spec/manifest.hs']) }).e2e).toBe('');
    });

    it('critical: full suite and CLI smoke required; e2e and Windows optional', () => {
        const p = plan({ profile: 'critical', files: files(['packages/rdf-files/src/text-patch.ts']) });
        expect([p.unit, p.cli, p.e2e, p.windows_unit, p.packages]).toEqual(['required', 'required', 'optional', 'optional', '']);
    });

    it('platform: packages required when packaging files change', () => {
        expect(plan({ profile: 'platform', files: files(['scripts/package.sh']) }).packages).toBe('required');
        expect(plan({ profile: 'platform', files: files(['scripts/package.sh']) }).release_dry).toBe('optional');
        expect(plan({ profile: 'platform', files: files(['vitest.config.mts']) }).packages).toBe('');
    });

    it('after the merge everything is required; the nightly run adds Windows and the packages', () => {
        const main = plan({ profile: 'cosmetic', files: files(['modeler/css/modeler.css']), mode: 'main' });
        expect([main.unit, main.build, main.electron, main.cli, main.e2e, main.windows_unit]).toEqual(['required', 'required', true, 'required', 'required', '']);
        const nightly = plan({ profile: 'platform', files: [], mode: 'nightly' });
        expect([nightly.windows_unit, nightly.packages]).toEqual(['required', 'required']);
    });

    it('risk:hold and shadow runs', () => {
        expect(plan({ profile: 'standard', files: files(['docs/a.md']), labels: ['risk:hold'] }).hold).toBe(true);
        expect(plan({ profile: 'cosmetic', files: files(['modeler/css/modeler.css']), pr: 10, shadowEvery: 5 }).shadow).toBe('optional');
        expect(plan({ profile: 'cosmetic', files: files(['modeler/css/modeler.css']), pr: 11, shadowEvery: 5 }).shadow).toBe('');
        expect(plan({ profile: 'critical', files: files(['packages/rdf/src/trig.ts']), pr: 10 }).shadow).toBe('');
    });

    it('test selection', () => {
        expect(testSelection(files(['packages/model/src/labels.ts'])).mode).toBe('full');
        expect(testSelection(files(['packages/rdf/test/helpers.ts'])).mode).toBe('full');
        expect(testSelection(files(['spec/manifest.hs'])).mode).toBe('none');
        expect(testSelection(files(['examples/bookshop/workspace.trig'])).tests).toContain('packages/rdf/test/workspace-files.test.ts');
        expect(testSelection(files(['modeler/src/browser/a.ts', 'modeler/test/b.test.ts']))).toEqual({ mode: 'affected', related: ['modeler/src/browser/a.ts'], tests: ['modeler/test/b.test.ts'] });
    });
});

describe('gate', () => {
    const ok = { classify: 'success', fast: 'success', unit: 'success', build: 'success' };
    const plan = { fast: 'required', unit: 'required', build: 'required', e2e: 'optional', windows_unit: '', shadow: 'optional', hold: 'false' };

    it('passes when every required job passed; an optional failure does not block', () => {
        expect(gate(plan, { ...ok, e2e: 'failure', shadow: 'failure' }).ok).toBe(true);
    });

    it('fails on a failed, skipped or cancelled required job, or a failed classify', () => {
        expect(gate(plan, { ...ok, unit: 'failure' }).ok).toBe(false);
        expect(gate(plan, { ...ok, build: 'skipped' }).ok).toBe(false);
        expect(gate(plan, { ...ok, fast: 'cancelled' }).ok).toBe(false);
        expect(gate(plan, { ...ok, classify: 'failure' }).ok).toBe(false);
    });

    it('risk:hold makes optional jobs blocking, except the shadow run', () => {
        expect(gate({ ...plan, hold: 'true' }, { ...ok, e2e: 'failure' }).ok).toBe(false);
        expect(gate({ ...plan, hold: 'true' }, { ...ok, e2e: 'success', shadow: 'failure' }).ok).toBe(true);
    });
});
