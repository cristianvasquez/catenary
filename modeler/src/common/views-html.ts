// Export of views as one HTML document: the SVG of each view, with its styles inline. No scripts, no external files.

export interface ViewFigure {
    label: string;
    /** SVG markup, with its styles inline. */
    svg: string;
}

export interface DocumentColors {
    background: string;
    foreground: string;
    muted: string;
}

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A title, the table of contents (numbered links to the sections), one numbered section for each view. */
export function viewsHtml(title: string, figures: ViewFigure[], colors: DocumentColors, date = new Date()): string {
    const id = (i: number) => `view-${i + 1}`;
    const contents = `<nav>\n<h2>Contents</h2>\n<ol>${figures.map((f, i) => `<li><a href="#${id(i)}">${escapeHtml(f.label)}</a></li>`).join('')}</ol>\n</nav>\n`;
    const sections = figures.map((f, i) => `<section id="${id(i)}">\n<h2>${i + 1}. ${escapeHtml(f.label)}</h2>\n<figure>${f.svg}</figure>\n</section>`).join('\n');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Catenary">
<title>${escapeHtml(title)}</title>
<style>
body { margin: 0 auto; padding: 24px 16px 48px; max-width: 1400px; background: ${colors.background}; color: ${colors.foreground}; font: 14px/1.5 system-ui, sans-serif; }
header p { color: ${colors.muted}; }
nav { break-after: page; }
nav ol { padding-left: 24px; }
nav li { margin: 2px 0; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 40px 0 12px; }
a { color: inherit; }
figure { margin: 0; overflow-x: auto; }
figure > svg { display: block; max-width: 100%; height: auto; }
@media print { section { break-inside: avoid; } a { text-decoration: none; } }
</style>
</head>
<body>
<header><h1>${escapeHtml(title)}</h1><p>${figures.length} view${figures.length === 1 ? '' : 's'} · ${date.toISOString().slice(0, 10)}</p></header>
${contents}${sections}
</body>
</html>
`;
}
