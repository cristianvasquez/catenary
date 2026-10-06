import type { languages } from '@theia/monaco-editor-core';

/** Lexical highlighting only; RDF parsing and validation stay in the backend. */
export const rdfLanguage: languages.IMonarchLanguage = {
    defaultToken: '',
    tokenPostfix: '.rdf',
    unicode: true,
    // Turtle PN_CHARS_BASE, PN_CHARS and escaped local-name characters.
    base: /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}]/u,
    pn: /(?:@base|[_0-9\-\u00B7\u0300-\u036F\u203F-\u2040])/,
    escaped: /(?:%[0-9A-Fa-f]{2}|\\[_~.\-!$&'()*+,;=/?#@%])/,
    localStart: /(?:@base|[_0-9:]|@escaped)/,
    localEnd: /(?:@pn|:|@escaped)/,
    escape: /\\(?:[tbnrf"'\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    tokenizer: {
        root: [
            [/[ \t\r\n]+/, ''],
            [/#.*$/, 'comment'],
            [/<[^<>"{}|^`\\\x00-\x20]*(?:\\[uU][0-9A-Fa-f]+[^<>"{}|^`\\\x00-\x20]*)*>/, 'string.link'],
            [/"""/, 'string', '@longDouble'],
            [/'''/, 'string', '@longSingle'],
            [/"/, 'string', '@double'],
            [/'/, 'string', '@single'],
            [/@(?:prefix|base)\b/, 'keyword'],
            [/@[a-zA-Z]+(?:-[a-zA-Z0-9]+)*/, 'type'],
            // Names precede keywords: ex:true and GRAPH:item are names, not keywords.
            [/_:(?:@base|[_0-9])(?:(?:@pn|\.)*@pn)?/, 'identifier'],
            [/(?:@base(?:(?:@pn|\.)*@pn)?)?:(?:@localStart(?:(?:@localEnd|\.)*@localEnd)?)?/, 'type.identifier'],
            [/(?:[Pp][Rr][Ee][Ff][Ii][Xx]|[Bb][Aa][Ss][Ee]|[Gg][Rr][Aa][Pp][Hh])\b|a\b/, 'keyword'],
            [/(?:true|false)\b/, 'constant'],
            [/[+-]?(?:(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)[eE][+-]?[0-9]+|[0-9]*\.[0-9]+|[0-9]+)/, 'number'],
            [/\^\^/, 'operator'],
            [/[{}()[\]]/, '@brackets'],
            [/[;,.]/, 'delimiter']
        ],
        double: [
            [/@escape/, 'string.escape'],
            [/[^"\\]+/, 'string'],
            [/"/, 'string', '@pop'],
            [/\\./, 'string.escape.invalid'],
            [/$/, '', '@pop']
        ],
        single: [
            [/@escape/, 'string.escape'],
            [/[^'\\]+/, 'string'],
            [/'/, 'string', '@pop'],
            [/\\./, 'string.escape.invalid'],
            [/$/, '', '@pop']
        ],
        longDouble: [
            [/@escape/, 'string.escape'],
            [/"""/, 'string', '@pop'],
            [/[^"\\]+/, 'string'],
            [/"/, 'string'],
            [/\\./, 'string.escape.invalid']
        ],
        longSingle: [
            [/@escape/, 'string.escape'],
            [/'''/, 'string', '@pop'],
            [/[^'\\]+/, 'string'],
            [/'/, 'string'],
            [/\\./, 'string.escape.invalid']
        ]
    }
};

export const rdfLanguageConfiguration: languages.LanguageConfiguration = {
    comments: { lineComment: '#' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
        { open: '{', close: '}', notIn: ['string', 'comment'] },
        { open: '[', close: ']', notIn: ['string', 'comment'] },
        { open: '(', close: ')', notIn: ['string', 'comment'] },
        { open: '"', close: '"', notIn: ['string', 'comment'] },
        { open: "'", close: "'", notIn: ['string', 'comment'] }
    ]
};
