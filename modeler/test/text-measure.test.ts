import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@eclipse-glsp/client', () => ({ GLSPSvgExporter: class {} }));

import { drawnFont, hideValidationClasses, withDrawnFont } from '../src/browser/diagram/text-measure';

/**
 * A window with the installed fonts `installed`: a font list draws its first installed family; a generic family draws its system font.
 * The pixels of a text identify the font that draws it.
 */
function windowWith(installed: string[], generic: Record<string, string>) {
    const draw = (font: string) => {
        for (const name of font.replace(/^\d+px\s+/, '').split(',').map(f => f.trim().replace(/^"|"$/g, ''))) {
            if (generic[name]) return generic[name];
            if (installed.includes(name)) return name;
        }
        return 'default';
    };
    let drawn = '';
    const context = {
        canvas: { width: 0, height: 0 }, font: '',
        clearRect() { drawn = ''; },
        fillText() { drawn = draw(context.font); },
        getImageData: () => ({ data: Uint8ClampedArray.from([...drawn].map(c => c.charCodeAt(0))) })
    };
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => context }) });
}

afterEach(() => vi.unstubAllGlobals());

it('names the installed font that draws a list, not a name of the list that the window takes only through an alias', () => {
    windowWith(['Liberation Sans'], { 'sans-serif': 'Liberation Sans', monospace: 'DejaVu Sans Mono', serif: 'Liberation Serif' });
    expect(drawnFont('"Helvetica Neue", Helvetica, sans-serif')).toBe('Liberation Sans');
    expect(withDrawnFont('"Helvetica Neue", Helvetica, sans-serif')).toBe('"Liberation Sans", "Helvetica Neue", Helvetica, sans-serif');
});

it('roborev 188: a list drawn in the monospace fallback does not take a candidate that is not installed', () => {
    windowWith(['DejaVu Sans Mono'], { monospace: 'DejaVu Sans Mono', serif: 'DejaVu Serif', 'sans-serif': 'DejaVu Sans' });
    expect(drawnFont('Menlo, monospace')).toBe('DejaVu Sans Mono');
    windowWith([], { monospace: 'Mono fallback', serif: 'Serif fallback', 'sans-serif': 'Sans fallback' });
    expect(drawnFont('Consolas, monospace')).toBeUndefined();
    expect(withDrawnFont('Consolas, monospace')).toBe('Consolas, monospace');
});

/** An element with classes; querySelectorAll takes a list of class selectors. */
function element(classes: string) {
    const set = new Set(classes.split(' '));
    return { classList: { contains: (c: string) => set.has(c), remove: (c: string) => set.delete(c), add: (c: string) => set.add(c) }, classes: () => [...set].join(' ') };
}

it('law_exportShowsNoValidation: the export canvas has no validation classes during the style copy, and gets them back after it', () => {
    const card = element('catenary-card invalid unknown'), shape = element('catenary-card shape-card invalid'), row = element('shape-row invalid');
    const edge = element('catenary-edge property invalid'), plain = element('catenary-card colored');
    const all = [card, shape, row, edge, plain];
    const svg = {
        querySelectorAll: (selector: string) => {
            const names = selector.split(',').map(s => s.trim().replace(/^\./, ''));
            return all.filter(e => names.some(n => e.classList.contains(n)));
        }
    } as unknown as Element;
    const restore = hideValidationClasses(svg);
    expect(all.map(e => e.classes())).toEqual(['catenary-card', 'catenary-card shape-card', 'shape-row', 'catenary-edge property', 'catenary-card colored']);
    restore();
    expect(all.map(e => e.classes())).toEqual(['catenary-card invalid unknown', 'catenary-card shape-card invalid', 'shape-row invalid', 'catenary-edge property invalid', 'catenary-card colored']);
});
