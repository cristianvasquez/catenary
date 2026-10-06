import type { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import { rdfLanguage, rdfLanguageConfiguration } from './rdf-language';

@injectable()
export class RdfLanguageContribution implements FrontendApplicationContribution {
    initialize(): void {
        for (const language of [
            { id: 'turtle', extensions: ['.ttl'], aliases: ['Turtle', 'turtle'], mimetypes: ['text/turtle'] },
            { id: 'trig', extensions: ['.trig'], aliases: ['TriG', 'trig'], mimetypes: ['application/trig'] }
        ]) {
            monaco.languages.register(language);
            monaco.languages.setMonarchTokensProvider(language.id, rdfLanguage);
            monaco.languages.setLanguageConfiguration(language.id, rdfLanguageConfiguration);
        }
    }
}
