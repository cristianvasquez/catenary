import { expect, it } from 'vitest';
import { initialRows, moveRow, setAllChecked, setChecked } from '../src/common/view-order';
import { viewsHtml } from '../src/common/views-html';

const colors = { background: '#fff', foreground: '#000', muted: '#666' };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"></svg>';

it('table of contents first, then one numbered section for each view, in order, with escaped labels and no scripts', () => {
    const html = viewsHtml('a <b> & c', [{ label: 'One', svg }, { label: 'Two "2"', svg }], colors, new Date('2026-09-28T12:00:00Z'));
    expect(html).toContain('<title>a &lt;b&gt; &amp; c</title>');
    expect([...html.matchAll(/<h2>(.*?)<\/h2>/g)].map(m => m[1])).toEqual(['Contents', '1. One', '2. Two &quot;2&quot;']);
    expect(html.indexOf('<nav>')).toBeLessThan(html.indexOf('<section'));
    expect([...html.matchAll(/<section id="([^"]+)">/g)].map(m => m[1])).toEqual(['view-1', 'view-2']);
    expect([...html.matchAll(/<a href="#([^"]+)">(.*?)<\/a>/g)].map(m => [m[1], m[2]])).toEqual([['view-1', 'One'], ['view-2', 'Two &quot;2&quot;']]);
    expect(html.split(svg).length - 1).toBe(2);
    expect(html).toContain('2 views · 2026-09-28');
    expect(html).not.toMatch(/<script|<link|@import|src="http/i);
});

it('table of contents also for one view', () => {
    const html = viewsHtml('t', [{ label: 'Only', svg }], colors);
    expect(html).toContain('<a href="#view-1">Only</a>');
    expect(html).toContain('<h2>1. Only</h2>');
    expect(html).toContain('1 view ·');
});

const views = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', folder: 'f' }, { id: 'c', label: 'C' }];

it('initial rows: checked ids first in their order (unknown ids and repeats dropped), then the others in view order', () => {
    expect(initialRows(views, ['c', 'gone', 'a', 'c']).map(r => [r.id, r.checked])).toEqual([['c', true], ['a', true], ['b', false]]);
    expect(initialRows(views, []).map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(initialRows(views, ['b'])[0]).toEqual({ id: 'b', label: 'B', folder: 'f', checked: true });
});

it('moveRow moves one row; out of range: no change', () => {
    expect(moveRow(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveRow(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    const rows = ['a', 'b'];
    expect(moveRow(rows, 0, -1)).toBe(rows);
    expect(moveRow(rows, 1, 2)).toBe(rows);
});

it('setChecked: a checked row goes to the end of the checked rows; an unchecked row goes back in view order', () => {
    const order = ['a', 'b', 'c', 'd'];
    const rows = initialRows([...views, { id: 'd', label: 'D' }], ['c']);
    const state = (r: ReturnType<typeof initialRows>) => r.map(x => `${x.id}${x.checked ? '+' : ''}`).join(' ');
    expect(state(rows)).toBe('c+ a b d');
    const two = setChecked(rows, 'd', true, order);
    expect(state(two)).toBe('c+ d+ a b');
    expect(state(setChecked(two, 'c', false, order))).toBe('d+ a b c');
    expect(setChecked(rows, 'c', true, order)).toBe(rows);
    expect(setChecked(rows, 'gone', true, order)).toBe(rows);
});

it('setAllChecked: all keeps the checked order first; none returns to view order', () => {
    const order = ['a', 'b', 'c'];
    const rows = initialRows(views, ['c', 'a']);
    expect(setAllChecked(rows, true, order).map(r => `${r.id}${r.checked ? '+' : ''}`)).toEqual(['c+', 'a+', 'b+']);
    expect(setAllChecked(rows, false, order).map(r => `${r.id}${r.checked ? '+' : ''}`)).toEqual(['a', 'b', 'c']);
});
