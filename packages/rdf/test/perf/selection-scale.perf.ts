// `pnpm test:perf`: the elapsed time of the outline read of 300 placements (spec/manifest.hs §11.3 readBudgetMs). The outline indexes
// the view statements once: its p50 must keep the ceiling of 1000 ms. selection-scale.test.ts checks the same read without time.

import { afterAll, beforeAll, describe, it } from 'vitest';
import { Fixture, SELECTION_EDGES, SELECTION_N, openSelectionFixture, selectionIds, selectionView } from '../scale-fixtures';
import { PerfReport, spanSamples } from './report';

/** The ceiling of the outline of 300 placements: linear in the placements, not quadratic (the limit of selection-scale.test.ts before 0fqy). */
const OUTLINE_CEILING_MS = 1000;

const report = new PerfReport('selection-scale', { placements: SELECTION_N, placedRelations: SELECTION_EDGES });
let fixture: Fixture;
beforeAll(async () => {
    fixture = await openSelectionFixture();
    Object.assign(report.fixture, { fileBytes: fixture.files });
}, 60_000);
afterAll(async () => {
    report.write();
    await fixture?.dispose();
});

describe(`selection reads of ${SELECTION_N} placements (§11.3 readBudgetMs)`, () => {
    it('outline of the view with three selected placements', async () => {
        const read = () => fixture.store.reads.outline(selectionView, { view: selectionView, ids: selectionIds.slice(0, 3) });
        const samples = await spanSamples('outline', read);
        report.check('rpc/outline', samples, OUTLINE_CEILING_MS, 'linear-time ceiling');
    }, 120_000);
});
