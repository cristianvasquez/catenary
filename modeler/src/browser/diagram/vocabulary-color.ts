// Vocabulary colour of path labels (rows and property edges): a user preference, the same for all views (UI §7.2 Preferences).
// The parts come from pathParts (@catenary/model): a prefix part "p:" without a color, then the local name in the color of its namespace.
// No dependencies, so the row and edge views can import it.

export const VOCABULARY_COLORS = ['name', 'prefix', 'off'] as const;
export type VocabularyColor = typeof VOCABULARY_COLORS[number];
export const VOCABULARY_COLOR_DEFAULT: VocabularyColor = 'name';

let current: VocabularyColor = VOCABULARY_COLOR_DEFAULT;
/** The mode that the row and edge views draw with. */
export const vocabularyColor = (): VocabularyColor => current;
export const setVocabularyColor = (mode: VocabularyColor): void => { current = mode; };

export interface DrawnPart { text: string; color?: string; muted: boolean }

/**
 * The drawn parts of a path label. name: the local name in the namespace color, the prefix muted. prefix: the prefix in the namespace color,
 * the local name plain. off: no color, the prefix muted. Operators stay muted. An IRI without a prefix keeps its color, except with off.
 */
export function vocabularyParts(parts: readonly { text: string; color?: string }[], mode: VocabularyColor = current): DrawnPart[] {
    const isPrefix = (i: number) => !parts[i]?.color && !!parts[i]?.text.endsWith(':') && !!parts[i + 1]?.color;
    return parts.map((x, i) => {
        if (mode === 'prefix' && isPrefix(i)) return { text: x.text, color: parts[i + 1].color, muted: false };
        if ((mode === 'prefix' && isPrefix(i - 1)) || (mode === 'off' && x.color)) return { text: x.text, muted: false };
        return { text: x.text, color: x.color, muted: !x.color };
    });
}
