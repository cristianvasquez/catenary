// `pnpm test:perf`: the elapsed time of the Model explorer reads of a file with 600 subjects (spec/manifest.hs §11.3 readBudgetMs).
// The p50 of the samples of each read must keep the budget. explorer.test.ts checks the same reads without time.

import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { EXPLORER_BIG, Fixture, openExplorerFixture } from '../scale-fixtures';
import { PerfReport, spanSamples } from './report';

/** spec/manifest.hs §11.3 readBudgetMs. */
const READ_BUDGET_MS = 50;

const report = new PerfReport('explorer', { subjects: EXPLORER_BIG });
let fixture: Fixture;
beforeAll(async () => {
    fixture = await openExplorerFixture();
    Object.assign(report.fixture, { fileBytes: fixture.files });
}, 60_000);
afterAll(async () => {
    report.write();
    await fixture?.dispose();
});

describe(`Model explorer: a file with ${EXPLORER_BIG} subjects (§11.3 readBudgetMs)`, () => {
    const big = () => join(fixture.dir, 'big.ttl');
    it('explorerChildren: the sections of the file', async () => {
        report.check('rpc/sections', await spanSamples('sections', () => fixture.store.reads.explorerChildren(undefined, big())), READ_BUDGET_MS);
    }, 120_000);
    it('explorerChildren: the instances of a class folder', async () => {
        report.check('rpc/children', await spanSamples('children', () => fixture.store.reads.explorerChildren('rdfs/class:urn:z:Big', big())), READ_BUDGET_MS);
    }, 120_000);
});
