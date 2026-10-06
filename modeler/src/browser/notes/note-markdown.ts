// Shared, untrusted Markdown rendering for the note dialog and the diagram.
import { DisposableCollection } from '@theia/core';
import { MarkdownRenderer, MarkdownRenderResult, MarkdownRenderOptions } from '@theia/core/lib/browser/markdown-rendering/markdown-renderer';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { MarkdownSanitizerConfig } from '@theia/monaco-editor-core/esm/vs/base/browser/markdownRenderer';

@injectable()
export class NoteMarkdown {
    @inject(MarkdownRenderer) protected readonly renderer: MarkdownRenderer;

    render(text: string): MarkdownRenderResult {
        const disposables = new DisposableCollection();
        // Monaco's renderer accepts these sanitizer options through Theia's renderer adapter.
        // Exclude media before insertion into the DOM: even detached images can issue network requests.
        const options: MarkdownRenderOptions & { sanitizerConfig: MarkdownSanitizerConfig } = {
            sanitizerConfig: {
                allowedTags: { override: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
                    'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span'] }
            },
            actionHandler: {
                disposables,
                callback: href => {
                    // No command, file, relative, or script URLs. Canvas content has pointer-events disabled.
                    if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
                }
            }
        };
        const rendered = this.renderer.render({ value: text, isTrusted: false, supportHtml: false, supportThemeIcons: false }, options);
        rendered.element.classList.add('catenary-markdown');
        disposables.push(rendered);
        return { element: rendered.element, dispose: () => disposables.dispose() };
    }
}
