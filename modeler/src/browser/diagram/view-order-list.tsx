// The views of an export, in order: the checked views on top, numbered in export order; the other views below, in view order.
// Drag a checked row (pointer events: the row moves while the pointer moves), use ↑/↓, or Alt+↑/Alt+↓ on a focused row.
// A drag shows its order locally and calls `onChange` once, at the drop. Used by the export dialog and by the Workspace settings.

import React from '@theia/core/shared/react';
import { OrderRow, moveRow, setChecked } from '../../common/view-order';

interface Drag { id: string; pointerId: number; rowHeight: number; moved: boolean }

/** `order`: all view ids in view order (the order of the unchecked rows). `offHeading`: the heading of the unchecked rows. */
export function ViewOrderList(p: { rows: OrderRow[]; order: string[]; offHeading: string; onChange: (rows: OrderRow[]) => void }) {
    const [drag, setDrag] = React.useState<Drag>();
    /** The rows while a drag moves them; undefined: `p.rows`. */
    const [dragRows, setDragRows] = React.useState<OrderRow[]>();
    /** The row to focus after a keyboard move. */
    const [focusId, setFocusId] = React.useState<string>();
    const list = React.useRef<HTMLOListElement>(null);
    /** A drag that moved a row ended: the click that follows must not toggle the checkbox. */
    const dropped = React.useRef(false);
    const rows = dragRows ?? p.rows;
    const on = rows.filter(r => r.checked), off = rows.filter(r => !r.checked);

    React.useEffect(() => {
        if (focusId) list.current?.querySelector<HTMLElement>(`[data-view="${CSS.escape(focusId)}"]`)?.focus();
    }, [focusId, p.rows]);

    const move = (from: number, to: number) => {
        if (to < 0 || to >= on.length) return;
        setFocusId(rows[from].id);
        p.onChange(moveRow(rows, from, to));
    };

    const onPointerDown = (e: React.PointerEvent<HTMLLIElement>, id: string) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('input, .catenary-icon-button')) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dropped.current = false;
        setDrag({ id, pointerId: e.pointerId, rowHeight: e.currentTarget.getBoundingClientRect().height, moved: false });
        setDragRows(p.rows);
    };

    /** The dragged row takes the index under the pointer. Near the top or bottom edge of a scrolling list, the list scrolls. */
    const onPointerMove = (e: React.PointerEvent<HTMLLIElement>) => {
        if (!drag || e.pointerId !== drag.pointerId || !list.current) return;
        const scroller = list.current.parentElement!, box = scroller.getBoundingClientRect();
        if (e.clientY < box.top + 20) scroller.scrollTop -= 8;
        else if (e.clientY > box.bottom - 20) scroller.scrollTop += 8;
        const to = Math.max(0, Math.min(on.length - 1, Math.floor((e.clientY - list.current.getBoundingClientRect().top) / drag.rowHeight)));
        const from = rows.findIndex(r => r.id === drag.id);
        if (from === to) return;
        drag.moved = true;
        setDragRows(moveRow(rows, from, to));
    };

    const onPointerEnd = (e: React.PointerEvent<HTMLLIElement>) => {
        if (drag?.pointerId !== e.pointerId) return;
        dropped.current = drag.moved;
        if (drag.moved && dragRows) p.onChange(dragRows);
        setDrag(undefined);
        setDragRows(undefined);
    };

    const name = (r: OrderRow) => <label>
        <input type='checkbox' checked={r.checked} onChange={() => p.onChange(setChecked(rows, r.id, !r.checked, p.order))} />
        <span className='label'>{r.label}</span>
        {r.folder ? <span className='folder'>{r.folder}</span> : undefined}
    </label>;

    return <div className='catenary-view-order-scroll'>
        <ol className={`catenary-view-order-list${drag ? ' dragging' : ''}`} ref={list}>
            {on.map((r, i) => <li key={r.id} data-view={r.id} tabIndex={0} className={drag?.id === r.id ? 'checked dragged' : 'checked'}
                title='Drag to move. Alt+↑ or Alt+↓ moves the focused row.'
                onPointerDown={e => onPointerDown(e, r.id)} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
                onKeyDown={e => {
                    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                    e.preventDefault();
                    move(i, e.key === 'ArrowUp' ? i - 1 : i + 1);
                }}
                onClickCapture={e => { if (dropped.current) { e.preventDefault(); e.stopPropagation(); dropped.current = false; } }}>
                <span className='codicon codicon-gripper' />
                <span className='number'>{i + 1}.</span>
                {name(r)}
                <span className={`codicon codicon-arrow-up catenary-icon-button${i === 0 ? ' disabled' : ''}`} title='Move up (Alt+↑)' onClick={() => move(i, i - 1)} />
                <span className={`codicon codicon-arrow-down catenary-icon-button${i === on.length - 1 ? ' disabled' : ''}`} title='Move down (Alt+↓)'
                    onClick={() => move(i, i + 1)} />
            </li>)}
        </ol>
        {off.length ? <>
            <div className='catenary-view-order-heading'>{p.offHeading}</div>
            <ul className='catenary-view-order-list'>{off.map(r => <li key={r.id}>{name(r)}</li>)}</ul>
        </> : undefined}
    </div>;
}
