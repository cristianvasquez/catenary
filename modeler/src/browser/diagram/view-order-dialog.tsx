// Dialog of Export Views as HTML: which views, in which order (ViewOrderList).

import { DialogError } from '@theia/core/lib/browser';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import React from '@theia/core/shared/react';
import { OrderRow, setAllChecked } from '../../common/view-order';
import { ViewOrderList } from './view-order-list';

export class ViewOrderDialog extends ReactDialog<string[]> {
    /** `order`: all view ids in view order (the order of the unchecked rows). */
    constructor(protected rows: OrderRow[], protected readonly order: string[]) {
        super({ title: 'Export Views as HTML' });
        this.contentNode.classList.add('catenary-view-order');
        this.appendCloseButton('Cancel');
        this.appendAcceptButton('Export…');
    }

    get value(): string[] {
        return this.rows.filter(r => r.checked).map(r => r.id);
    }

    protected override isValid(value: string[]): DialogError {
        return value.length ? '' : 'Select at least one view.';
    }

    protected set(rows: OrderRow[]): void {
        this.rows = rows;
        this.update();
        this.validate();
    }

    protected render(): React.ReactNode {
        const count = this.rows.filter(r => r.checked).length;
        return <>
            <div className='catenary-view-order-bar'>
                <span className='catenary-help'>{count} of {this.rows.length} views in the document. Drag a numbered row to move it.</span>
                <button className='theia-button secondary' onClick={() => this.set(setAllChecked(this.rows, true, this.order))}>All</button>
                <button className='theia-button secondary' onClick={() => this.set(setAllChecked(this.rows, false, this.order))}>None</button>
            </div>
            <ViewOrderList rows={this.rows} order={this.order} offHeading='Not in the document' onChange={rows => this.set(rows)} />
        </>;
    }
}
