// Edge style and vocabulary color of the view editors: user preferences, the same for all views and models (not stored in the model).
// See edge-route.ts and vocabulary-color.ts. The views read them with `edgeStyle()` and `vocabularyColor()`; a change redraws the open view editors.

import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Emitter } from '@theia/core';
import { PreferenceContribution, PreferenceScope, PreferenceService } from '@theia/core/lib/common/preferences';
import { inject, injectable } from '@theia/core/shared/inversify';
import { SetViewportAction, isViewport } from '@eclipse-glsp/client';
import { EDGE_STYLES, EdgeStyle } from './edge-route';
import { ViewEditors } from './view-editors';
import { VOCABULARY_COLORS, VOCABULARY_COLOR_DEFAULT, VocabularyColor, setVocabularyColor } from './vocabulary-color';

export const EDGE_STYLE = 'catenary.edgeStyle';
export const EDGE_STYLE_DEFAULT: EdgeStyle = 'curved';
export const VOCABULARY_COLOR = 'catenary.vocabularyColor';

let current: EdgeStyle = EDGE_STYLE_DEFAULT;
/** The edge style that the edge views draw with. */
export const edgeStyle = (): EdgeStyle => current;

/** Bound as a constant, as fontPreferences. */
export const edgePreferences: PreferenceContribution = {
    schema: {
        properties: {
            [EDGE_STYLE]: {
                type: 'string', enum: [...EDGE_STYLES], default: EDGE_STYLE_DEFAULT,
                description: 'Edges in view editors. curved: a smooth curve from card to card through the bends of the edge. direct: straight segments. '
                    + 'Drag an edge to bend it; double-click a bend to remove it.'
            },
            [VOCABULARY_COLOR]: {
                type: 'string', enum: [...VOCABULARY_COLORS], default: VOCABULARY_COLOR_DEFAULT,
                description: 'Vocabulary color of property paths in view editors. name: the local name in the color of its namespace, the prefix gray. '
                    + 'prefix: the prefix in the color, the local name plain. off: no color.'
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
        setVocabularyColor(this.vocabulary());
        this.preferences.onPreferenceChanged(e => {
            if (e.preferenceName !== EDGE_STYLE && e.preferenceName !== VOCABULARY_COLOR) return;
            current = this.get();
            setVocabularyColor(this.vocabulary());
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

    vocabulary(): VocabularyColor {
        const v = this.preferences.get(VOCABULARY_COLOR, VOCABULARY_COLOR_DEFAULT);
        return (VOCABULARY_COLORS as readonly string[]).includes(v) ? v as VocabularyColor : VOCABULARY_COLOR_DEFAULT;
    }

    /** User scope. The default removes the setting. */
    setVocabulary(mode: VocabularyColor): Promise<void> {
        return this.preferences.set(VOCABULARY_COLOR, mode === VOCABULARY_COLOR_DEFAULT ? undefined : mode, PreferenceScope.User);
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
