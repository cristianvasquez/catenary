// Picker at a screen point (next to the element), instead of the Theia quick pick at the top of the window.
// Filter field, list with section headers, keys Up/Down/Enter/Escape. A click outside closes it.

export interface PopupItem { label: string; description?: string; run?: () => unknown }
export interface PopupSeparator { type: 'separator'; label: string }
export interface PopupCreator { label: string; run: (text: string) => Promise<unknown> }

export interface PopupOptions {
    at: { x: number; y: number };   // client coordinates of the top-left corner
    title: string;
    items: (PopupItem | PopupSeparator)[];
    creators?: PopupCreator[];      // with typed text: one entry "<label> "<text>"" each
}

const isSeparator = (i: PopupItem | PopupSeparator): i is PopupSeparator => (i as PopupSeparator).type === 'separator';

/** Resolves with the result of the chosen item's `run`, or undefined when closed. */
export function showPopupPicker(o: PopupOptions): Promise<unknown> {
    return new Promise(resolve => {
        const root = document.createElement('div');
        root.className = 'catenary-popup-picker';
        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = o.title;
        const input = document.createElement('input');
        input.className = 'theia-input';
        input.placeholder = 'Filter; the text is also the name of a new element';
        const list = document.createElement('div');
        list.className = 'list';
        root.append(title, input, list);
        document.body.appendChild(root);

        let rows: { el: HTMLElement; item: PopupItem }[] = [];
        let active = 0;
        let closed = false;
        const close = (result?: unknown) => {
            if (closed) return;
            closed = true;
            window.removeEventListener('mousedown', outside, true);
            root.remove();
            resolve(result);
        };
        const choose = async (item: PopupItem) => {
            if (closed) return;
            closed = true;
            window.removeEventListener('mousedown', outside, true);
            root.remove();
            resolve(item.run ? await item.run() : undefined);
        };
        const setActive = (i: number) => {
            if (!rows.length) return;
            rows[active]?.el.classList.remove('active');
            active = (i + rows.length) % rows.length;
            rows[active].el.classList.add('active');
            rows[active].el.scrollIntoView({ block: 'nearest' });
        };
        const render = () => {
            const text = input.value.trim();
            const f = text.toLowerCase();
            const match = (i: PopupItem) => !f || i.label.toLowerCase().includes(f) || !!i.description?.toLowerCase().includes(f);
            const shown: (PopupItem | PopupSeparator)[] = [];
            let header: PopupSeparator | undefined;
            for (const i of o.items) {
                if (isSeparator(i)) { header = i; continue; }
                if (!match(i)) continue;
                if (header) { shown.push(header); header = undefined; }
                shown.push(i);
            }
            if (text && o.creators?.length) {
                shown.push({ type: 'separator', label: 'Create' });
                for (const c of o.creators) shown.push({ label: `${c.label} "${text}"`, run: () => c.run(text) });
            }
            list.replaceChildren();
            rows = [];
            for (const i of shown) {
                const el = document.createElement('div');
                if (isSeparator(i)) {
                    el.className = 'separator';
                    el.textContent = i.label;
                } else {
                    el.className = 'item';
                    const label = document.createElement('span');
                    label.textContent = i.label;
                    el.appendChild(label);
                    if (i.description) {
                        const d = document.createElement('span');
                        d.className = 'description';
                        d.textContent = i.description;
                        el.appendChild(d);
                    }
                    const index = rows.length;
                    el.onmouseenter = () => setActive(index);
                    el.onmousedown = e => { e.preventDefault(); choose(i); };
                    rows.push({ el, item: i });
                }
                list.appendChild(el);
            }
            if (!rows.length) {
                const el = document.createElement('div');
                el.className = 'separator';
                el.textContent = 'No match';
                list.appendChild(el);
            }
            active = 0;
            setActive(0);
        };
        const outside = (e: MouseEvent) => { if (!root.contains(e.target as Node)) close(); };

        input.addEventListener('input', render);
        input.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown') setActive(active + 1);
            else if (e.key === 'ArrowUp') setActive(active - 1);
            else if (e.key === 'Enter') { if (rows[active]) choose(rows[active].item); }
            else if (e.key === 'Escape') close();
            else return;
            e.preventDefault();
            e.stopPropagation();
        });
        window.addEventListener('mousedown', outside, true);
        render();

        // Keep it in the window.
        const r = root.getBoundingClientRect();
        root.style.left = `${Math.max(8, Math.min(o.at.x, window.innerWidth - r.width - 8))}px`;
        root.style.top = `${Math.max(8, Math.min(o.at.y, window.innerHeight - r.height - 8))}px`;
        input.focus();
    });
}
