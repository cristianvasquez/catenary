import { describe, expect, it } from 'vitest';
import {
    EXPORT_RESOURCES, ExportView, LinkTarget, isViewEmbed, localDestination, markdownRefs, planMarkdownExport, relativeLink, replaceRanges,
    resourceName, viewEmbed, viewSvgName
} from '../src';

const VIEWS = new Map<string, ExportView>([
    ['urn:name:Main', { id: 'n-main', label: 'Main' }],
    ['urn:name:Bookshop%20model', { id: 'n-model', label: 'Bookshop model' }],
    ['http://example.org/views/a', { id: 'n-a', label: 'A (web)' }]
]);
const noFiles = (): LinkTarget => ({ kind: 'missing' });

describe('Markdown references (spec/ui-manifest.hs §9)', () => {
    it('finds inline links, images and definitions with their ranges and lines', () => {
        const text = 'See [Data model](Data%20model.md).\n\n![Main](urn:name:Main "title")\n\n[logo]: <img/a b.png>\n';
        const refs = markdownRefs(text);
        expect(refs.map(r => [r.kind, r.destination, r.line])).toEqual([
            ['link', 'Data%20model.md', 1], ['image', 'urn:name:Main', 3], ['definition', 'img/a b.png', 5]
        ]);
        expect(text.slice(refs[1].start, refs[1].end)).toBe('![Main](urn:name:Main "title")');
        expect(text.slice(refs[2].destStart, refs[2].destEnd)).toBe('<img/a b.png>');
    });

    it('ignores code spans, fenced code and HTML comments', () => {
        const text = '`![a](urn:x:1)`\n\n```md\n![b](urn:x:2)\n```\n\n<!-- ![c](urn:x:3) -->\n~~~\n![d](urn:x:4)\n~~~\n![e](urn:x:5)';
        expect(markdownRefs(text).map(r => r.destination)).toEqual(['urn:x:5']);
    });

    it('reads an image inside link text, angle brackets, escapes and balanced parentheses', () => {
        const refs = markdownRefs('[![V](urn:name:Main)](page.md) ![x](<urn:a b>) ![y](a\\)b) ![z](f(1).png)');
        expect(refs.map(r => [r.kind, r.destination])).toEqual([
            ['link', 'page.md'], ['image', 'urn:name:Main'], ['image', 'urn:a b'], ['image', 'a)b'], ['image', 'f(1).png']
        ]);
    });

    it('law_embedKeepsIri: an embed keeps the complete view IRI; Insert View writes a standard image', () => {
        expect(viewEmbed('Bookshop model', 'urn:name:Bookshop%20model')).toBe('![Bookshop model](urn:name:Bookshop%20model)');
        expect(viewEmbed('A [draft]', 'urn:x:a (b)')).toBe('![A \\[draft\\]](<urn:x:a (b)>)');
        for (const [label, iri] of [['A [draft]', 'urn:x:a (b)'], ['Main', 'urn:name:Main'], ['x', 'urn:a<b>c']]) {
            const [ref] = markdownRefs(`Text ${viewEmbed(label, iri)} text`);
            expect(ref.kind).toBe('image');
            expect(ref.destination).toBe(iri);
        }
    });

    it('law_linkIsNoEmbed: an embed is an image with a view IRI or a non-document scheme; a link is never an embed', () => {
        const embed = (kind: 'image' | 'link' | 'definition', destination: string) => isViewEmbed({ kind, destination }, VIEWS);
        expect(embed('image', 'urn:name:Main')).toBe(true);
        expect(embed('image', 'http://example.org/views/a')).toBe(true);
        expect(embed('image', 'urn:name:Gone')).toBe(true);
        expect(embed('definition', 'urn:name:Main')).toBe(true);
        expect(embed('link', 'urn:name:Main')).toBe(false);
        expect(embed('image', 'https://example.org/a.png')).toBe(false);
        expect(embed('image', 'img/a.png')).toBe(false);
        expect(embed('image', 'C:/img/a.png')).toBe(false);
    });

    it('local destinations: decoded path and suffix; URIs, fragments and absolute paths', () => {
        expect(localDestination('Data%20model.md#part')).toEqual({ path: 'Data model.md', suffix: '#part' });
        expect(localDestination('../a/b.png?x=1')).toEqual({ path: '../a/b.png', suffix: '?x=1' });
        expect(localDestination('a%zz.png')).toEqual({ path: 'a%zz.png', suffix: '' });
        expect(localDestination('#top')).toBeUndefined();
        expect(localDestination('https://x.org/a')).toBeUndefined();
        expect(localDestination('//x.org/a')).toBeUndefined();
        expect(localDestination('/etc/passwd')).toBe('absolute');
        expect(localDestination('C:\\a.png')).toBe('absolute');
    });

    it('relative links and range replacement', () => {
        expect(relativeLink('Architecture.md', '_resources/v.svg')).toBe('_resources/v.svg');
        expect(relativeLink('a/b/Doc.md', '_resources/v.svg')).toBe('../../_resources/v.svg');
        expect(relativeLink('a/Doc.md', 'a/My file (1).png')).toBe('My%20file%20%281%29.png');
        expect(replaceRanges('abcdef', [{ start: 4, end: 5, text: 'E' }, { start: 1, end: 2, text: 'BB' }])).toBe('aBBcdEf');
    });
});

describe('SVG and resource file names', () => {
    it('law_svgNamesDistinct: derive from the IRI, not the label; differ for different IRIs; stay in [a-z0-9-]', () => {
        const a = viewSvgName('urn:name:Bookshop%20model');
        expect(a).toMatch(/^bookshop-model-[0-9a-f]{12}\.svg$/);
        expect(viewSvgName('urn:name:Bookshop%20model')).toBe(a);
        expect(viewSvgName('urn:other:Bookshop%20model')).not.toBe(a);
        expect(viewSvgName('urn:name:../../etc')).toMatch(/^etc-[0-9a-f]{12}\.svg$/);
        expect(viewSvgName('urn:name:')).toMatch(/^name-[0-9a-f]{12}\.svg$/);
        expect(resourceName('/home/u/Logo Big.PNG')).toMatch(/^logo-big-[0-9a-f]{12}\.png$/);
        expect(resourceName('/a/x.png')).not.toBe(resourceName('/b/x.png'));
    });
});

describe('Markdown export plan', () => {
    const ARCH = '# Architecture\n\nThe system separates storage from presentation.\n\n![](urn:name:Main)\n\n## Components\n\n'
        + '![Model](urn:name:Bookshop%20model "The model")\n\nSee [Data model](Data%20model.md).\n';

    it('replaces each embed with a relative SVG link, in order; the other text does not change', () => {
        const plan = planMarkdownExport([{ path: 'Architecture.md', text: ARCH }], VIEWS, () => ({ kind: 'document' }));
        expect(plan.unresolved).toEqual([]);
        expect(plan.views.map(v => [v.iri, v.id])).toEqual([['urn:name:Main', 'n-main'], ['urn:name:Bookshop%20model', 'n-model']]);
        const [main, model] = plan.views.map(v => v.path);
        expect(plan.documents[0].text).toBe(ARCH.replace('![](urn:name:Main)', `![Main](${main})`)
            .replace('![Model](urn:name:Bookshop%20model "The model")', `![Model](${model})`));
        expect(main.startsWith(`${EXPORT_RESOURCES}/`)).toBe(true);
        expect(plan.problems).toEqual([]);
    });

    it('renders a view once for several embeds and documents; links from subfolders go up', () => {
        const plan = planMarkdownExport([
            { path: 'a.md', text: '![](urn:name:Main)\n![](urn:name:Main)' },
            { path: 'sub/b.md', text: '![](urn:name:Main)' }
        ], VIEWS, noFiles);
        expect(plan.views).toHaveLength(1);
        const svg = plan.views[0].path;
        expect(plan.documents[0].text).toBe(`![Main](${svg})\n![Main](${svg})`);
        expect(plan.documents[1].text).toBe(`![Main](../${svg})`);
    });

    it('an embed that names no view is unresolved, with the file, the line and the IRI', () => {
        const plan = planMarkdownExport([{ path: 'd/a.md', text: 'x\n\n![Old](urn:name:Renamed)\n![ok](urn:name:Main)' }], VIEWS, noFiles);
        expect(plan.unresolved).toEqual([{ file: 'd/a.md', line: 3, iri: 'urn:name:Renamed' }]);
    });

    it('resolves by IRI: the label of the view does not matter', () => {
        const relabeled = new Map([['urn:name:Main', { id: 'n-main', label: 'New label' }]]);
        const plan = planMarkdownExport([{ path: 'a.md', text: '![Main](urn:name:Main)' }], relabeled, noFiles);
        expect(plan.unresolved).toEqual([]);
        expect(plan.views[0].path).toBe(`${EXPORT_RESOURCES}/${viewSvgName('urn:name:Main')}`);
        expect(plan.documents[0].text).toBe(`![Main](${plan.views[0].path})`);
    });

    it('copies files: in the folder at their path, outside the folder to _resources with a changed link; reports the rest', () => {
        const targets: Record<string, LinkTarget> = {
            'img/a.png': { kind: 'file', from: '/src/img/a.png', path: 'img/a.png' },
            '../logo.png#x': { kind: 'file', from: '/logo.png' },
            'gone.png': { kind: 'missing' },
            'img': { kind: 'unsupported', reason: 'The target is a folder.' },
            'other.md': { kind: 'document' }
        };
        const text = '![a](img/a.png) ![l](../logo.png#x) ![g](gone.png) [f](img) [o](other.md) [w](https://x.org) [abs](/etc/hosts)';
        const plan = planMarkdownExport([{ path: 'doc.md', text }], VIEWS, (_d, dest) => targets[dest]);
        const logo = `${EXPORT_RESOURCES}/${resourceName('/logo.png')}`;
        expect(plan.copies).toEqual([{ from: '/src/img/a.png', path: 'img/a.png' }, { from: '/logo.png', path: logo }]);
        expect(plan.documents[0].text).toBe(text.replace('../logo.png#x', `${logo}#x`));
        expect(plan.problems.map(p => [p.target, p.message.split('.')[0]])).toEqual([
            ['gone.png', 'The target does not exist'], ['img', 'The target is a folder'], ['/etc/hosts', 'An absolute path is not exported']
        ]);
    });
});
