import { expect, it, vi } from 'vitest';

vi.mock('@eclipse-glsp/client', () => ({ SetViewportAction: {}, isViewport: () => false }));
vi.mock('../src/browser/diagram/view-editors', () => ({ ViewEditors: class {} }));

import { EDGE_STYLE, EDGE_STYLE_DEFAULT, edgePreferences, edgeStyle, EdgePreferences } from '../src/browser/diagram/edge-preferences';

it('uses Direct as the initial, schema and missing-preference default (UI §7 defaultEdgeStyle)', () => {
    expect(EDGE_STYLE_DEFAULT).toBe('direct');
    expect(edgeStyle()).toBe('direct');
    expect(edgePreferences.schema!.properties![EDGE_STYLE].default).toBe('direct');
    const preferences = new EdgePreferences();
    Object.assign(preferences, { preferences: { get: (_key: string, fallback: string) => fallback } });
    expect(preferences.get()).toBe('direct');
});

it('preserves an explicit Orthogonal choice and falls back to Direct for an invalid choice', () => {
    const preferences = new EdgePreferences();
    Object.assign(preferences, { preferences: { get: () => 'orthogonal' } });
    expect(preferences.get()).toBe('orthogonal');
    Object.assign(preferences, { preferences: { get: () => 'invalid' } });
    expect(preferences.get()).toBe('direct');
});
