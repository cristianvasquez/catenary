// Browser wiring smoke test only. Model rules and view reactions belong in `pnpm test`.
// Requires `pnpm build` and Chromium (CHROMIUM overrides /usr/bin/chromium).
// Always use an isolated workspace/config; never edit a running user's model.
// Each test has its own backend (port 0), configuration folder, workspace copy and browser, so the tests run at the same time:
// E2E_CONCURRENCY of them (default 3). Most of a test is waiting for the backend and the page, not CPU.
// E2E_LIST=1 lists the scenario names and starts nothing. E2E_TEST=<exact name> runs one scenario. See scripts/e2e/harness.cjs.
// The scenarios are in scripts/e2e/; this order is the order of the run and of the list.
const { run } = require('./e2e/harness.cjs');
require('./e2e/rendering.cjs');
require('./e2e/clipboard-shapes.cjs');
require('./e2e/editors.cjs');
require('./e2e/panels-canvas.cjs');
run();
