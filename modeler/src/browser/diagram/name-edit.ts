// Edit a canvas name in its rendered name slot, not in GLSP's floating label editor.
import type { GLSPDiagramWidget } from '@eclipse-glsp/theia-integration';
import { classIri } from '@catenary/model';
import { ModelFrontend } from '../model-client';
import type { ViewEditors } from './view-editors';

const SLOT = '.card-name, .shape-name, .vs-name, .group-label text';

/**
 * Edit the name of the card or group `id` of the view editor `w`. False: the view editor does not show it (yet).
 * `created`: the creation follow-up. A new node shape also gets the class with the typed name as its target class (one undo step).
 */
export function editCanvasName(w: GLSPDiagramWidget, id: string, view: string, editors: ViewEditors, model: ModelFrontend, created = false): boolean {
    const baseDiv = w.viewerOptions.baseDiv;
    // The DOM id of a card is the id of its placement (the diagram graph of the view editor); `id` can be the element.
    const card = document.getElementById(`${baseDiv}_${editors.placementOf(w, id)}`);
    const slot = card?.querySelector<HTMLElement | SVGTextElement>(SLOT);
    if (!slot) return false;
    const previous = slot.querySelector<HTMLInputElement>('input.catenary-name-input');
    if (previous) { previous.focus(); previous.select(); return true; }
    const original = slot.textContent ?? '';
    const input = document.createElement('input');
    input.className = 'catenary-name-input';
    input.value = original;
    input.setAttribute('aria-label', 'Name');
    const svg = slot instanceof SVGTextElement;
    let container: SVGForeignObjectElement | undefined;
    if (svg) {
        // The group text preference sets the label size: the input has the same size.
        const font = parseFloat(getComputedStyle(slot).fontSize) || 20;
        const width = slot.closest('.catenary-group')?.querySelector('.body')?.getAttribute('width');
        input.style.fontSize = `${font}px`;
        container = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
        container.setAttribute('x', '0');
        // The label center is at y = 26 - font / 2 (modeler.css .group-label text).
        container.setAttribute('y', String(26 - font / 2 - font * 0.75));
        container.setAttribute('width', String(Math.max(230, Number(width) || 0, slot.getComputedTextLength() + 4 * font)));
        container.setAttribute('height', String(Math.ceil(font * 1.5)));
        slot.style.visibility = 'hidden';
        slot.parentElement?.appendChild(container);
        container.appendChild(input);
    } else slot.replaceChildren(input);
    let done = false;
    const outside = (e: PointerEvent) => { if (e.target !== input) close(true); };
    const close = (save: boolean) => {
        if (done) return;
        done = true;
        document.removeEventListener('pointerdown', outside, true);
        const text = input.value;
        if (svg) { container?.remove(); slot.style.visibility = ''; }
        else slot.textContent = original;
        if (save && text !== original) {
            // The name slot of a group is its label: a view element, not a model label.
            if (slot.closest('.group-label')) void model.execute({ kind: 'setViewElements', view, ids: [id], patch: { label: text } });
            else if (created && slot.classList.contains('shape-name')) void renameWithClass(model, id, text);
            else void model.execute({ kind: 'rename', id, label: text });
        }
    };
    input.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key !== 'Enter' && e.key !== 'Tab' && e.key !== 'Escape') return;
        e.preventDefault();
        close(e.key !== 'Escape');
        // Give the focus back to the diagram: else the view editor is no longer the active widget and a click selects nothing in Properties.
        document.getElementById(baseDiv)?.querySelector<HTMLElement | SVGElement>('[aria-label="Diagram"][tabindex], svg.sprotty-graph[tabindex]')?.focus();
    });
    // A GLSP redraw can move the card in the DOM (seen after a double-click on a node shape name): the input loses focus, the user did not leave it.
    // Close on a press outside, or when focus goes to another element or window; after a move, focus the input again.
    document.addEventListener('pointerdown', outside, true);
    input.addEventListener('blur', () => requestAnimationFrame(() => {
        if (done) return;
        const focusGone = !document.hasFocus() || (document.activeElement && document.activeElement !== document.body);
        if (input.isConnected && !focusGone) input.focus();
        else close(true);
    }));
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'keyup', 'keypress']) input.addEventListener(type, e => e.stopPropagation());
    input.focus();
    input.select();
    return true;
}

/** Rename the new node shape `id` and set its target class: the known class with that name, else a new class IRI from the name. */
async function renameWithClass(model: ModelFrontend, id: string, label: string): Promise<void> {
    const r = classIri(label, await model.service.knownClasses());
    await model.execute({ kind: 'rename', id, label, targetClass: r && 'iri' in r ? r.iri : undefined });
}
