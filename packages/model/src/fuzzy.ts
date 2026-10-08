/** Ordered-character matching with bonuses for word starts and consecutive characters. Not the fzf query language. */
export function fuzzyMatch(text: string, query: string): { score: number; indices: number[] } | undefined {
    const needle = query.trim().toLowerCase();
    if (!needle) return { score: 0, indices: [] };
    const hay = text.toLowerCase();
    let states = new Map<number, { score: number; indices: number[] }>();
    for (let n = 0; n < needle.length; n++) {
        const next = new Map<number, { score: number; indices: number[] }>();
        for (let i = 0; i < hay.length; i++) {
            if (hay[i] !== needle[n]) continue;
            const boundary = i === 0 || /[\s_\-/:.#]/.test(text[i - 1]) || /[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]);
            const bonus = 10 + (boundary ? 12 : 0);
            if (!n) next.set(i, { score: bonus - i, indices: [i] });
            else for (const [j, previous] of states) {
                if (j >= i) continue;
                const score = previous.score + bonus + (j === i - 1 ? 18 : -(i - j - 1));
                if (!next.has(i) || score > next.get(i)!.score) next.set(i, { score, indices: [...previous.indices, i] });
            }
        }
        states = next;
        if (!states.size) return undefined;
    }
    return [...states.values()].sort((a, b) => b.score - a.score)[0];
}
