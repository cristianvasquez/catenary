import { expect, it, vi } from 'vitest';

vi.mock('@eclipse-glsp/client', () => ({ SetViewportAction: {}, isViewport: () => false }));
vi.mock('../src/browser/diagram/view-editors', () => ({ ViewEditors: class {} }));

import { EDGE_STYLE, EDGE_STYLE_DEFAULT, edgePreferences, edgeStyle, EdgePreferences } from '../src/browser/diagram/edge-preferences';
import { EDGE_STYLES } from '../src/browser/diagram/edge-route';

it('offers curved and direct only, with curved as the initial, schema and missing-preference default (UI §7.4 defaultEdgeStyle)', () => {
    expect([...EDGE_STYLES]).toEqual(['curved', 'direct']);
    expect(EDGE_STYLE_DEFAULT).toBe('curved');
    expect(edgeStyle()).toBe('curved');
    expect(edgePreferences.schema!.properties![EDGE_STYLE].default).toBe('curved');
    expect(edgePreferences.schema!.properties![EDGE_STYLE].enum).toEqual(['curved', 'direct']);
    const preferences = new EdgePreferences();
    Object.assign(preferences, { preferences: { get: (_key: string, fallback: string) => fallback } });
    expect(preferences.get()).toBe('curved');
});

it('preserves an explicit direct choice and falls back to curved for a choice that no longer exists', () => {
    const preferences = new EdgePreferences();
    Object.assign(preferences, { preferences: { get: () => 'direct' } });
    expect(preferences.get()).toBe('direct');
    for (const old of ['orthogonal', 'polyline', 'invalid']) {
        Object.assign(preferences, { preferences: { get: () => old } });
        expect(preferences.get()).toBe('curved');
    }
});
