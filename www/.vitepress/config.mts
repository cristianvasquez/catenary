import { defineConfig } from 'vitepress';

// The site of Catenary: what the tool is, and a tutorial on the bookshop example.
// Pictures come from `pnpm www:screenshots` (scripts/www-screenshots.mjs). Regenerate them after a change of the user interface.
export default defineConfig({
  title: 'Catenary',
  description: 'An editor of RDF models with SHACL shapes and diagrams. The files on disk are the model.',
  base: process.env.WWW_BASE || '/catenary/',
  lastUpdated: false,
  themeConfig: {
    nav: [
      { text: 'What is Catenary', link: '/what-is-catenary' },
      { text: 'Tutorial', link: '/tutorial/01-new-workspace' },
      { text: 'Reference', link: '/reference/workspace' }
    ],
    sidebar: [
      { text: 'What is Catenary', link: '/what-is-catenary' },
      {
        text: 'Tutorial: a bookshop from scratch',
        items: [
          { text: '1. A new workspace', link: '/tutorial/01-new-workspace' },
          { text: '2. Import a file', link: '/tutorial/02-import' },
          { text: '3. Draw the shapes', link: '/tutorial/03-shapes' },
          { text: '4. Create instances', link: '/tutorial/04-instances' },
          { text: '5. Update the shape', link: '/tutorial/05-update-shape' },
          { text: '6. Write it up', link: '/tutorial/06-document' }
        ]
      },
      {
        text: 'Reference',
        items: [
          { text: 'Workspace and files', link: '/reference/workspace' },
          { text: 'Canvas', link: '/reference/canvas' },
          { text: 'Model explorer', link: '/reference/model-explorer' },
          { text: 'Properties and side panels', link: '/reference/properties' },
          { text: 'Shapes', link: '/reference/shapes' },
          { text: 'Documents and export', link: '/reference/documents' },
          { text: 'Keys', link: '/reference/keys' }
        ]
      }
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/cristianvasquez/catenary' }],
    search: { provider: 'local' },
    footer: { message: 'AGPL-3.0-or-later' }
  }
});
