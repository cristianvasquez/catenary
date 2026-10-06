// Font sizes of the view editors: user preferences, the same for all views and models (not stored in the model).
// Applied as CSS variables on the document root; modeler.css scales card, group, and note text with them.

import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Emitter } from '@theia/core';
import { PreferenceContribution, PreferenceScope, PreferenceService } from '@theia/core/lib/common/preferences';
import { inject, injectable } from '@theia/core/shared/inversify';

export const CARD_FONT_SIZE = 'catenary.cardFontSize';
export const GROUP_FONT_SIZE = 'catenary.groupFontSize';
export const NOTE_FONT_SIZE = 'catenary.noteFontSize';
/** Defaults: the sizes in modeler.css at scale 1. */
export const FONT_DEFAULTS: Record<string, number> = { [CARD_FONT_SIZE]: 22, [GROUP_FONT_SIZE]: 20, [NOTE_FONT_SIZE]: 16 };
export const FONT_MIN = 8;
export const FONT_MAX = 72;

/** Bound as a constant: a contribution that injects PreferenceService would be a dependency cycle. */
export const fontPreferences: PreferenceContribution = {
    schema: {
        properties: {
            [CARD_FONT_SIZE]: {
                type: 'number', default: FONT_DEFAULTS[CARD_FONT_SIZE], minimum: FONT_MIN, maximum: FONT_MAX,
                description: 'Font size (px) of the card name in view editors. The other card text scales with it.'
            },
            [GROUP_FONT_SIZE]: {
                type: 'number', default: FONT_DEFAULTS[GROUP_FONT_SIZE], minimum: FONT_MIN, maximum: FONT_MAX,
                description: 'Font size (px) of the group name in view editors.'
            },
            [NOTE_FONT_SIZE]: {
                type: 'number', default: FONT_DEFAULTS[NOTE_FONT_SIZE], minimum: FONT_MIN, maximum: FONT_MAX,
                description: 'Base font size (px) of Markdown notes on the canvas in all views. Does not change the note editor.'
            }
        }
    }
};

@injectable()
export class FontPreferences implements FrontendApplicationContribution {
    @inject(PreferenceService) protected readonly preferences: PreferenceService;
    protected readonly changed = new Emitter<void>();
    readonly onDidChange = this.changed.event;

    async onStart(): Promise<void> {
        await this.preferences.ready;
        this.apply();
        this.preferences.onPreferenceChanged(e => { if (e.preferenceName in FONT_DEFAULTS) { this.apply(); this.changed.fire(); } });
    }

    get(name: string): number {
        const n = Number(this.preferences.get(name, FONT_DEFAULTS[name]));
        return Number.isFinite(n) ? Math.min(FONT_MAX, Math.max(FONT_MIN, n)) : FONT_DEFAULTS[name];
    }

    /** Card text scale: the "Card text" size / its default. The GLSP server gets it (`catenarySetCardScale`) for the card heights. */
    get cardScale(): number {
        return this.get(CARD_FONT_SIZE) / FONT_DEFAULTS[CARD_FONT_SIZE];
    }

    /** User scope. `undefined` removes the setting: the default applies. */
    set(name: string, value: number | undefined): Promise<void> {
        return this.preferences.set(name, value, PreferenceScope.User);
    }

    /** Applies `value` to the views without saving it, e.g. while a slider moves. */
    preview(name: string, value: number): void {
        this.apply(n => n === name ? value : this.get(n));
    }

    protected apply(size: (name: string) => number = n => this.get(n)): void {
        const root = document.documentElement.style;
        root.setProperty('--catenary-card-scale', String(size(CARD_FONT_SIZE) / FONT_DEFAULTS[CARD_FONT_SIZE]));
        root.setProperty('--catenary-group-font-size', `${size(GROUP_FONT_SIZE)}px`);
        root.setProperty('--catenary-note-font-size', `${size(NOTE_FONT_SIZE)}px`);
    }
}
