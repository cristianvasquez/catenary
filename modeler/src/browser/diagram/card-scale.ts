// The card text scale goes to the GLSP server of each view editor: the minimum heights of cards with rows (node shapes, schemes,
// collections) follow the font preference "Card text". Sent before the first model request; ViewEditors sends it again on a change.

import { IActionDispatcher, IDiagramStartup, TYPES } from '@eclipse-glsp/client';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FontPreferences } from './font-preferences';

export const SET_CARD_SCALE = 'catenarySetCardScale';

export function setCardScaleAction(scale: number): { kind: string; scale: number } {
    return { kind: SET_CARD_SCALE, scale };
}

@injectable()
export class CardScaleStartup implements IDiagramStartup {
    @inject(TYPES.IActionDispatcher) protected readonly dispatcher: IActionDispatcher;
    @inject(FontPreferences) protected readonly fonts: FontPreferences;

    preRequestModel(): Promise<void> {
        return this.dispatcher.dispatch(setCardScaleAction(this.fonts.cardScale) as never);
    }
}
