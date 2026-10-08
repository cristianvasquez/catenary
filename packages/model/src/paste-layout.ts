// Pack only arriving boxes. Existing boxes stay fixed; a copied frame moves with its contents.
import { Point, Rect } from './commands';

export interface PasteBox extends Rect { id: string; group?: boolean; membership?: Rect }
const contains = (a: Rect, b: Rect) => b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
const overlaps = (a: Rect, b: Rect, gap: number) => a.x < b.x + b.width + gap && b.x < a.x + a.width + gap
    && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

/** New top-left positions. Frames preserve their contents, dimensions and relative positions. */
export function layoutPastedBoxes(added: PasteBox[], fixed: Rect[], at: Point, gap = 60): (Rect & { id: string })[] {
    const groups = added.filter(b => b.group);
    const bounds = (b: PasteBox) => b.membership ?? b;
    const area = (b: PasteBox) => bounds(b).width * bounds(b).height;
    const parent = (b: PasteBox) => groups.filter(g => g.id !== b.id && contains(bounds(g), bounds(b))
        && (area(g) > area(b) || !b.group || g.id < b.id)).sort((a, c) => area(a) - area(c))[0];
    const rootOf = (b: PasteBox): PasteBox => { const p = parent(b); return p ? rootOf(p) : b; };
    const roots = added.filter(b => !parent(b));
    if (!roots.length) return [];
    // A frame keeps its stored membership, including cards whose drawn rows or private pills extend past its border.
    const extent = (b: PasteBox) => {
        const contents = added.filter(c => rootOf(c).id === b.id);
        return { ...b, width: Math.max(...contents.map(c => c.x + c.width - b.x)), height: Math.max(...contents.map(c => c.y + c.height - b.y)) };
    };
    const columns = Math.ceil(Math.sqrt(roots.length));
    const cellWidth = Math.max(...roots.map(b => extent(b).width)) + gap;
    const cellHeight = Math.max(...roots.map(b => extent(b).height)) + gap;
    const occupied = [...fixed];
    const positions = new Map<string, Rect>();
    roots.forEach((b, i) => {
        const p = { ...extent(b), x: at.x + i % columns * cellWidth, y: at.y + Math.floor(i / columns) * cellHeight };
        // Each move passes an obstacle's right or bottom edge. Coordinates only increase, so the search terminates.
        for (let hit = occupied.find(r => overlaps(p, r, gap)); hit; hit = occupied.find(r => overlaps(p, r, gap))) {
            const dx = hit.x + hit.width + gap - p.x, dy = hit.y + hit.height + gap - p.y;
            if (dx <= dy) p.x += dx; else p.y += dy;
        }
        positions.set(b.id, p);
        occupied.push(p);
    });
    const position = (b: PasteBox): Rect => {
        const known = positions.get(b.id);
        if (known) return known;
        const owner = parent(b)!;
        const p = position(owner);
        const result = { ...b, x: b.x + p.x - owner.x, y: b.y + p.y - owner.y };
        positions.set(b.id, result);
        return result;
    };
    return added.map(b => ({ id: b.id, ...position(b), width: b.width, height: b.height }));
}
