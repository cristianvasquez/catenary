// Edge style of the view editors: a user preference, the same for all views and models (not stored in the model). See edge-route.ts.
// The edge views read the style with `edgeStyle()`; a change redraws the open view editors.

import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Emitter } from '@theia/core';
import { PreferenceContribution, PreferenceScope, PreferenceService } from '@theia/core/lib/common/preferences';
import { inject, injectable } from '@theia/core/shared/inversify';
import { SetViewportAction, isViewport } from '@eclipse-glsp/client';
import { EDGE_STYLES, EdgeStyle } from './edge-route';
import { ViewEditors } from './view-editors';

export const EDGE_STYLE = 'catenary.edgeStyle';
export const EDGE_STYLE_DEFAULT: EdgeStyle = 'orthogonal';

let current: EdgeStyle = EDGE_STYLE_DEFAULT;
/** The edge style that the edge views draw with. */
export const edgeStyle = (): EdgeStyle => current;

/** Bound as a constant, as fontPreferences. */
export const edgePreferences: PreferenceContribution = {
    schema: {
        properties: {
            [EDGE_STYLE]: {
                type: 'string', enum: [...EDGE_STYLES], default: EDGE_STYLE_DEFAULT,
                description: 'Edges in view editors. orthogonal: around the cards, right angles. polyline: around the cards, straight segments. '
                    + 'curved: around the cards, a smooth curve. direct: a curve from card to card, over other cards.'
            }
        }
    }
};

@injectable()
export class EdgePreferences implements FrontendApplicationContribution {
    @inject(PreferenceService) protected readonly preferences: PreferenceService;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    protected readonly changed = new Emitter<void>();
    readonly onDidChange = this.changed.event;

    async onStart(): Promise<void> {
        await this.preferences.ready;
        current = this.get();
        this.preferences.onPreferenceChanged(e => {
            if (e.preferenceName !== EDGE_STYLE) return;
            current = this.get();
            this.redraw();
            this.changed.fire();
        });
    }

    get(): EdgeStyle {
        const v = this.preferences.get(EDGE_STYLE, EDGE_STYLE_DEFAULT);
        return (EDGE_STYLES as readonly string[]).includes(v) ? v as EdgeStyle : EDGE_STYLE_DEFAULT;
    }

    /** User scope. The default removes the setting. */
    set(style: EdgeStyle): Promise<void> {
        return this.preferences.set(EDGE_STYLE, style === EDGE_STYLE_DEFAULT ? undefined : style, PreferenceScope.User);
    }

    /** A viewport action with the same viewport makes GLSP render the diagram again. */
    protected redraw(): void {
        for (const w of this.editors.all()) {
            let root;
            try { root = w.editorContext.modelRoot; } catch { continue; }
            if (isViewport(root)) w.actionDispatcher.dispatch(SetViewportAction.create(root.id, { scroll: root.scroll, zoom: root.zoom }, { animate: false }));
        }
    }
}
