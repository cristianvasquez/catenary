// A text input over the canvas, at a client point: for a path, a target or a class, typed in place. Enter, Tab or a click outside
// commits (`how` tells which), Escape cancels. `options`: completions (a datalist); a promise fills the list when it resolves.

let open: HTMLInputElement | undefined;

export function inlineInput(o: {
    at: { x: number; y: number }; inside?: Element; value?: string; placeholder: string; options?: string[] | Promise<string[]>; width?: number;
    onCommit: (text: string, how: 'enter' | 'tab' | 'blur') => void; onCancel?: () => void
}): void {
    open?.remove();
    const input = document.createElement('input');
    input.className = o.inside ? 'catenary-embedded-input theia-input' : 'catenary-inline-input theia-input';
    input.value = o.value ?? '';
    input.placeholder = o.placeholder;
    if (o.width && !o.inside) input.style.width = `${o.width}px`;
    if (!o.inside) {
        input.style.left = `${Math.max(4, Math.min(o.at.x, window.innerWidth - (o.width ?? 320) - 4))}px`;
        input.style.top = `${Math.max(4, Math.min(o.at.y - 14, window.innerHeight - 40))}px`;
    }
    let svgHost: SVGForeignObjectElement | undefined;
    const original = o.inside ? [...o.inside.childNodes] : [];
    if (o.inside instanceof SVGElement) {
        const box = (o.inside as SVGGraphicsElement).getBBox();
        // The input has the font size of the text that it replaces (group text preference), in model units.
        const font = parseFloat(getComputedStyle(o.inside).fontSize) || 14;
        const height = Math.ceil(font * 1.5);
        input.style.fontSize = `${font}px`;
        svgHost = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
        svgHost.setAttribute('x', String(box.x));
        svgHost.setAttribute('y', String(box.y + (box.height - height) / 2));
        svgHost.setAttribute('width', String(Math.max(160, box.width + 4 * font)));
        svgHost.setAttribute('height', String(height));
        o.inside.setAttribute('visibility', 'hidden');
        o.inside.parentElement?.appendChild(svgHost);
    }
    const fill = (options: string[]) => {
        if (!options.length || !input.isConnected) return;
        const list = document.createElement('datalist');
        list.id = 'catenary-inline-options';
        document.getElementById(list.id)?.remove();
        for (const v of options) list.appendChild(Object.assign(document.createElement('option'), { value: v }));
        document.body.appendChild(list);
        input.setAttribute('list', list.id);
    };
    if (Array.isArray(o.options)) queueMicrotask(() => fill(o.options as string[]));
    else void o.options?.then(fill, () => undefined);
    let done = false;
    const close = (commit: boolean, how: 'enter' | 'tab' | 'blur' = 'blur') => {
        if (done) return;
        done = true;
        const text = input.value;
        input.remove();
        if (svgHost) { svgHost.remove(); o.inside?.removeAttribute('visibility'); }
        else if (o.inside?.isConnected) o.inside.replaceChildren(...original);
        document.getElementById('catenary-inline-options')?.remove();
        if (open === input) open = undefined;
        if (commit && text.trim() && text !== o.value) o.onCommit(text, how);
        else o.onCancel?.();
    };
    input.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') close(true, 'enter');
        if (e.key === 'Tab') { e.preventDefault(); close(true, 'tab'); }
        if (e.key === 'Escape') close(false);
    });
    input.addEventListener('blur', () => close(true));
    // The canvas must not see the keys or the clicks of the input.
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'keyup', 'keypress']) input.addEventListener(type, e => e.stopPropagation());
    if (svgHost) svgHost.appendChild(input);
    else if (o.inside) o.inside.replaceChildren(input);
    else document.body.appendChild(input);
    open = input;
    input.focus();
    input.select();
}
