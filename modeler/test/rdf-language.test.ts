import { describe, expect, it } from 'vitest';
// Use the real Monarch lexer without a DOM.
import { compile } from '@theia/monaco-editor-core/esm/vs/editor/standalone/common/monarch/monarchCompile.js';
import { MonarchTokenizer } from '@theia/monaco-editor-core/esm/vs/editor/standalone/common/monarch/monarchLexer.js';
import { rdfLanguage } from '../src/browser/rdf-language';

function tokenize(text: string) {
    type Services = ConstructorParameters<typeof MonarchTokenizer>;
    // Classic tokenization uses neither theme colors nor embedded-language services.
    const lexer = new MonarchTokenizer({} as Services[0], {} as Services[1], 'turtle', compile('turtle', rdfLanguage), {
        getValue: () => 20000,
        onDidChangeConfiguration: () => ({ dispose() {} })
    } as unknown as Services[4]);
    let state = lexer.getInitialState();
    try {
        return text.split('\n').map(line => {
            const result = lexer.tokenize(line, true, state);
            state = result.endState;
            const tokens = result.tokens as { offset: number; type: string }[];
            return tokens.map((token, i) => ({
                text: line.slice(token.offset, tokens[i + 1]?.offset),
                type: token.type.replace(/\.rdf$/, '')
            })).filter(token => token.text.trim());
        });
    } finally {
        lexer.dispose();
    }
}

const token = (text: string, type: string) => ({ text, type });

describe('RDF source highlighting', () => {
    it('recognizes directives, IRIs with fragments, and comments', () => {
        expect(tokenize('@prefix ex: <https://example.org/#> . # comment')[0]).toEqual([
            token('@prefix', 'keyword'), token('ex:', 'type.identifier'),
            token('<https://example.org/#>', 'string.link'), token('.', 'delimiter'), token('# comment', 'comment')
        ]);
    });

    it('recognizes graph blocks, default prefixes, blank nodes, lists and the type shorthand', () => {
        expect(tokenize('GRAPH :g { _:b a :Thing; :p (true false) . }')[0]).toEqual([
            token('GRAPH', 'keyword'), token(':g', 'type.identifier'), token('{', 'delimiter.curly'),
            token('_:b', 'identifier'), token('a', 'keyword'), token(':Thing', 'type.identifier'), token(';', 'delimiter'),
            token(':p', 'type.identifier'), token('(', 'delimiter.parenthesis'), token('true', 'constant'),
            token('false', 'constant'), token(')', 'delimiter.parenthesis'), token('.', 'delimiter'), token('}', 'delimiter.curly')
        ]);
    });

    it('does not split Unicode, escaped or dotted local names, or swallow a final dot', () => {
        for (const name of ['ex:café', 'ex:a.b', 'ex:a\\#b', 'ex:a%20b', ':name', 'ex:true', 'GRAPH:item']) {
            expect(tokenize(`${name}.`)[0]).toEqual([token(name, 'type.identifier'), token('.', 'delimiter')]);
        }
    });

    it('recognizes numeric forms without swallowing an integer terminator', () => {
        for (const value of ['42', '-1', '+2', '.5', '-0.25', '1e3', '1.e-2', '+.5E2']) {
            expect(tokenize(`${value}.`)[0]).toEqual([token(value, 'number'), token('.', 'delimiter')]);
        }
    });

    it('keeps hashes in strings and recognizes language tags and datatypes', () => {
        expect(tokenize('"# text"@en-US "42"^^xsd:integer')[0]).toEqual([
            token('"# text"', 'string'), token('@en-US', 'type'), token('"42"', 'string'),
            token('^^', 'operator'), token('xsd:integer', 'type.identifier')
        ]);
    });

    it.each(['"""', "'''"])('keeps %s strings across lines and returns to RDF tokens', quote => {
        expect(tokenize(`${quote}first\n# still a string\nlast${quote} . # end`)).toEqual([
            [token(`${quote}first`, 'string')], [token('# still a string', 'string')],
            [token(`last${quote}`, 'string'), token('.', 'delimiter'), token('# end', 'comment')]
        ]);
    });

    it.each(['"', "'"])('handles escaped quotes in %s strings', quote => {
        expect(tokenize(`${quote}a\\${quote}b${quote}`)[0]).toEqual([
            token(`${quote}a`, 'string'), token(`\\${quote}`, 'string.escape'), token(`b${quote}`, 'string')
        ]);
    });
});
