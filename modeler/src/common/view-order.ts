// Order of the views of an export: checked rows first, in the chosen order; then the other views in view order.

export interface OrderRow {
    id: string;
    label: string;
    folder?: string;
    checked: boolean;
}

/** Checked rows first, in the order of `checked`; then the other views in the order of `views`. */
export function initialRows(views: { id: string; label: string; folder?: string }[], checked: string[]): OrderRow[] {
    const byId = new Map(views.map(v => [v.id, v]));
    const first = [...new Set(checked)].filter(id => byId.has(id)).map(id => ({ ...byId.get(id)!, checked: true }));
    const done = new Set(checked);
    return [...first, ...views.filter(v => !done.has(v.id)).map(v => ({ ...v, checked: false }))];
}

/** `rows` with the row at `from` moved to index `to`. */
export function moveRow<T>(rows: T[], from: number, to: number): T[] {
    if (from === to || to < 0 || to >= rows.length) return rows;
    const next = [...rows];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    return next;
}

/**
 * `rows` with the row `id` checked or unchecked. A checked row goes to the end of the checked rows (the export order);
 * an unchecked row goes back among the other unchecked rows, in the order of `order` (all view ids).
 */
export function setChecked(rows: OrderRow[], id: string, checked: boolean, order: string[]): OrderRow[] {
    const row = rows.find(r => r.id === id);
    if (!row || row.checked === checked) return rows;
    const rest = rows.filter(r => r !== row);
    const on = rest.filter(r => r.checked), off = rest.filter(r => !r.checked);
    if (checked) return [...on, { ...row, checked }, ...off];
    const rank = (r: OrderRow) => order.indexOf(r.id);
    return [...on, ...[...off, { ...row, checked }].sort((a, b) => rank(a) - rank(b))];
}

/** All rows checked (the checked rows keep their order, the others follow in their order) or none (all in the order of `order`). */
export function setAllChecked(rows: OrderRow[], checked: boolean, order: string[]): OrderRow[] {
    if (checked) return [...rows.filter(r => r.checked), ...rows.filter(r => !r.checked)].map(r => ({ ...r, checked }));
    return [...rows].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).map(r => ({ ...r, checked }));
}
