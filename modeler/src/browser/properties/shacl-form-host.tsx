// <shacl-form> (ULB Darmstadt) inside the React properties panel.
// The element builds its own DOM. React owns only the container, and this component builds the form
// again only when the data that the form shows is out of date. Each rebuild resets focus and cursor.
// A rebuild does not empty the panel: shacl-form shows a loading text and builds 200 ms later (its initTimeout). The new form
// builds hidden behind the shown one and replaces it at its `ready` event.

import '@ulb-darmstadt/shacl-form';
import type { ShaclForm } from '@ulb-darmstadt/shacl-form';
import React from '@theia/core/shared/react';

export interface ShaclFormHostProps {
    /** Shapes as N-Triples. */
    shapes: string;
    /** IRI of the instance. */
    subject: string;
    /** Root node shape. Undefined: the form finds it from rdf:type. */
    shapeSubject?: string;
    /** State of the data in the model that the form shows. A different key causes a rebuild. */
    dataKey: string;
    /** Do not rebuild (an edit from this form is not yet in the model). */
    hold: boolean;
    /** Data graph as N-Triples. Read only at a rebuild. */
    values: () => string;
    /** The user changed the form. Returns the data key that the form shows now. */
    onFormChange: (form: ShaclForm) => string;
}

/** A form that does not fire `ready` (for example after a build error) replaces the shown one after this time. */
const READY_TIMEOUT = 3000;

export class ShaclFormHost extends React.Component<ShaclFormHostProps> {
    protected readonly container = React.createRef<HTMLDivElement>();
    /** The shown form. */
    protected form?: ShaclForm;
    /** The form that builds hidden; it replaces `form` when ready. */
    protected next?: ShaclForm;
    protected timer?: ReturnType<typeof setTimeout>;
    /** Props of the last rebuild, with dataKey updated to what the form shows after user edits. */
    protected shown?: { shapes: string; subject: string; shapeSubject?: string; dataKey: string };

    override componentDidMount(): void { this.sync(); }
    override componentDidUpdate(): void { this.sync(); }
    override componentWillUnmount(): void {
        clearTimeout(this.timer);
        this.next?.remove();
        this.form?.remove();
    }

    protected sync(): void {
        const p = this.props, s = this.shown;
        if (p.hold && this.form) return;
        if (s && s.shapes === p.shapes && s.subject === p.subject && s.shapeSubject === p.shapeSubject && s.dataKey === p.dataKey) return;
        this.rebuild();
    }

    protected rebuild(): void {
        const p = this.props;
        this.dropNext();
        const form = document.createElement('shacl-form') as ShaclForm;
        // Keep the default shadow root: in light DOM the form's stylesheet applies to the whole page (form, a, h3).
        // modeler.css styles the form through --shacl-* / --rokit-* variables and ::part().
        form.setAttribute('data-shapes', p.shapes);
        form.setAttribute('data-values', p.values());
        form.setAttribute('data-values-subject', p.subject);
        if (p.shapeSubject) form.setAttribute('data-shape-subject', p.shapeSubject);
        // No dct:conformsTo triple in the output; the model is not a record of a form.
        form.setAttribute('data-generate-node-shape-reference', '');
        form.setAttribute('data-ignore-owl-imports', '');
        form.addEventListener('change', () => {
            if (this.form !== form || !this.shown) return;
            // An edit in the shown form: the hidden form has older data. The next update builds again.
            this.dropNext();
            this.shown.dataKey = this.props.onFormChange(form);
        });
        this.shown = { shapes: p.shapes, subject: p.subject, shapeSubject: p.shapeSubject, dataKey: p.dataKey };
        if (!this.form) {
            this.form = form;
            this.container.current?.appendChild(form);
            return;
        }
        // Hidden and out of the flow: the panel keeps the height of the shown form.
        Object.assign(form.style, { position: 'absolute', top: '0', left: '0', width: '100%', visibility: 'hidden', pointerEvents: 'none' });
        const swap = () => {
            if (this.next !== form) return;
            clearTimeout(this.timer);
            this.next = undefined;
            this.form?.remove();
            form.removeAttribute('style');
            this.form = form;
        };
        form.addEventListener('ready', swap, { once: true });
        this.timer = setTimeout(swap, READY_TIMEOUT);
        this.next = form;
        this.container.current?.appendChild(form);
    }

    protected dropNext(): void {
        clearTimeout(this.timer);
        this.next?.remove();
        this.next = undefined;
    }

    override render(): React.ReactNode {
        return <div className='catenary-shacl-form' style={{ position: 'relative' }} ref={this.container} />;
    }
}
