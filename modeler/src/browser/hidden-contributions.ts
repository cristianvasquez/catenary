// ADR 0004: the plugin host (Source Control, ADR 0003 step 6) brings Run and Debug, and Testing. The app has no use for them: their
// contributions (views, menus, commands) are removed. Task and Terminal menus are hidden separately; their services and commands stay for plugins.

import { ContributionFilterRegistry, FilterContribution } from '@theia/core/lib/common/contribution-filter';
import { MenuContribution } from '@theia/core/lib/common/menu';
import { TaskFrontendContribution } from '@theia/task/lib/browser/task-frontend-contribution';
import { TerminalFrontendContribution } from '@theia/terminal/lib/browser/terminal-frontend-contribution';
import { injectable } from '@theia/core/shared/inversify';
import { DebugConsoleContribution } from '@theia/debug/lib/browser/console/debug-console-contribution';
import { DebugFrontendApplicationContribution } from '@theia/debug/lib/browser/debug-frontend-application-contribution';
import { TestOutputViewContribution } from '@theia/test/lib/browser/view/test-output-view-contribution';
import { TestResultViewContribution } from '@theia/test/lib/browser/view/test-result-view-contribution';
import { TestRunViewContribution } from '@theia/test/lib/browser/view/test-run-view-contribution';
import { TestViewContribution } from '@theia/test/lib/browser/view/test-view-contribution';

const HIDDEN = [DebugFrontendApplicationContribution, DebugConsoleContribution, TestViewContribution, TestResultViewContribution, TestRunViewContribution, TestOutputViewContribution];

@injectable()
export class HiddenContributions implements FilterContribution {
    registerContributionFilters(registry: ContributionFilterRegistry): void {
        registry.addFilters('*', [c => !HIDDEN.some(h => c instanceof h)]);
        registry.addFilters([MenuContribution], [c => !(c instanceof TaskFrontendContribution || c instanceof TerminalFrontendContribution)]);
    }
}
