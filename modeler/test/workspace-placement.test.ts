import { expect, it, vi } from 'vitest';

vi.mock('@theia/core/lib/browser', () => ({ FrontendApplicationContribution: Symbol() }));
vi.mock('@theia/core/lib/browser/dialogs/react-dialog', () => ({ ReactDialog: class {} }));
vi.mock('../src/browser/model-client', () => ({ ModelFrontend: class {} }));
vi.mock('../src/browser/properties/controls', () => ({ TextInput: () => null }));

import { NEAR_KIND } from '@catenary/model';
import { proposedPlaces } from '../src/browser/prefixes/workspace-placement';

it('proposes a file for each kind of a new workspace (manifest §2.2 proposedPlacement)', () => {
    expect(proposedPlaces('w')).toEqual({ shapes: 'w.shapes.ttl', concepts: 'w.skos.ttl', instances: 'w.data.ttl' });
});

it('keeps a kind that the folder already contains near its kind (Set Up Workspace)', () => {
    expect(proposedPlaces('w', ['shapes', 'instances'])).toEqual({ shapes: NEAR_KIND, concepts: 'w.skos.ttl', instances: NEAR_KIND });
});
