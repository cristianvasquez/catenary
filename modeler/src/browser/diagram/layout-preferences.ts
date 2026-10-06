// Space between boxes of Apply Layout: a user preference, the same for all views and models (not stored in the model). The value goes
// with each layout request (LayoutViewAction.spacing); the backend lays out with it.

import { Emitter } from '@theia/core';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { PreferenceContribution, PreferenceScope, PreferenceService } from '@theia/core/lib/common/preferences';
import { inject, injectable } from '@theia/core/shared/inversify';
import { LAYOUT_SPACING, layoutSpacing } from '../../common/protocol';

export const LAYOUT_SPACING_PREF = 'catenary.layoutSpacing';

/** Bound as a constant, as fontPreferences. */
export const layoutPreferences: PreferenceContribution = {
    schema: {
        properties: {
            [LAYOUT_SPACING_PREF]: {
                type: 'number', default: LAYOUT_SPACING.default, minimum: LAYOUT_SPACING.min, maximum: LAYOUT_SPACING.max,
                description: 'Space (px) between boxes when Apply Layout places them. Layered: twice this between columns.'
            }
        }
    }
};

@injectable()
export class LayoutPreferences implements FrontendApplicationContribution {
    @inject(PreferenceService) protected readonly preferences: PreferenceService;
    protected readonly changed = new Emitter<void>();
    readonly onDidChange = this.changed.event;

    async onStart(): Promise<void> {
        await this.preferences.ready;
        this.preferences.onPreferenceChanged(e => { if (e.preferenceName === LAYOUT_SPACING_PREF) this.changed.fire(); });
    }

    get spacing(): number {
        return layoutSpacing(this.preferences.get(LAYOUT_SPACING_PREF, LAYOUT_SPACING.default));
    }

    /** User scope. The default removes the setting. */
    setSpacing(value: number): Promise<void> {
        const v = layoutSpacing(value);
        return this.preferences.set(LAYOUT_SPACING_PREF, v === LAYOUT_SPACING.default ? undefined : v, PreferenceScope.User);
    }
}
