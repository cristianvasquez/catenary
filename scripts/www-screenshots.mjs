// Pictures of the site (www/public/images). Starts the built browser app, drives it with Playwright and the catenary CLI, and
// writes one PNG per picture. Needs `pnpm build:browser` and Chromium (CHROMIUM overrides /usr/bin/chromium).
// Two sets: `bookshop` opens examples/bookshop (reference pages); `scratch` builds a bookshop from an empty folder, one step per
// tutorial page, so each picture shows the state after that step. Usage: pnpm www:screenshots [bookshop|scratch ...]
import { fork, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { iriId } from '../packages/model/lib/ids.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'www/public/images');
const viewport = { width: 1440, height: 900 };
const file = name => path.join(out, `${name}.png`);

function startBackend(workspace, config) {
  const entry = path.join(root, 'app/lib/backend/main.js');
  if (!fs.existsSync(entry)) throw new Error('Run pnpm build:browser before pnpm www:screenshots.');
  const proc = fork(entry, [workspace, '--hostname', '127.0.0.1', '--port', '0', '--plugins=local-dir:plugins'], {
    cwd: path.join(root, 'app'),
    env: { ...process.env, THEIA_CONFIG_DIR: config },
    detached: true,
    stdio: ['ignore', 'ignore', process.env.VERBOSE ? 'inherit' : 'ignore', 'ipc']
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend did not listen within 20 seconds')), 20000);
    proc.once('error', e => { clearTimeout(timer); reject(e); });
    proc.once('exit', code => { clearTimeout(timer); reject(new Error(`Backend exited before readiness (${code})`)); });
    proc.once('message', address => { clearTimeout(timer); resolve(`http://127.0.0.1:${address.port}`); });
  });
  return { proc, ready };
}

function stopBackend(proc) {
  const kill = signal => { try { process.kill(-proc.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
  kill('SIGTERM');
  setTimeout(() => kill('SIGKILL'), 2000).unref();
}

/** Run one app set: start a backend on `workspace`, open a page, then run `steps` in order. */
async function session(workspace, config, steps) {
  const started = startBackend(workspace, config);
  let browser;
  try {
    const url = await started.ready;
    // Exit 3 (a prompt is open) is a result, not an error.
    const cli = (...args) => {
      try {
        return JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/catenary.mjs'), '--port', new URL(url).port, ...args], { encoding: 'utf8', timeout: 15000 }));
      } catch (e) { if (e.status === 3 && e.stdout) return JSON.parse(e.stdout); throw e; }
    };
    const exec = command => {
      const r = cli('exec', JSON.stringify(command));
      if (!r.result?.ok) throw new Error(`${command.kind}: ${JSON.stringify(r.result ?? r)}`);
      return r.result;
    };
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium' });
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    page.setDefaultTimeout(15000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('#theia-main-content-panel').waitFor();
    const canvas = page.locator('svg.sprotty-graph:visible');
    const settle = (ms = 1200) => page.waitForTimeout(ms);
    const ctx = {
      page, cli, exec, canvas, settle, workspace,
      shot: name => page.screenshot({ path: file(name) }).then(() => console.log(`wrote ${path.relative(root, file(name))}`)),
      // Apply Layout (Layered) on the active canvas: it also fits the view to its content.
      // Fit the active canvas to its content.
      fit: async () => { cli('eval', 'await ctx.editors.fit(ctx.shell.activeWidget); return true'); await settle(800); },
      layout: async () => { cli('run', 'catenary.layoutView', 'null', '"layered"'); await settle(1500); },
      openView: async id => { cli('eval', `await ctx.editors.open(${JSON.stringify(id)}); return true`); await canvas.waitFor(); await settle(); },
      card: name => canvas.locator('g.card').filter({ has: page.locator('.card-name', { hasText: new RegExp('^' + name + '$') }) }),
      navNode: name => page.locator('#files .theia-TreeNode').filter({ has: page.locator('.theia-TreeNodeSegmentGrow', { hasText: new RegExp(`^${name.replace(/[.]/g, '\\.')}$`) }) })
    };
    for (const step of steps) await step(ctx);
  } finally {
    await browser?.close();
    stopBackend(started.proc);
  }
}

// --- The bookshop example: the reference pages. ---
const bookshopViews = { bookshop: 'n-urn_3aname_3aBookshop', model: 'n-urn_3aname_3aBookshop_2520model' };

async function bookshop(dir) {
  const workspace = path.join(dir, 'bookshop');
  fs.cpSync(path.join(root, 'examples/bookshop'), workspace, { recursive: true });
  await session(workspace, path.join(dir, 'config'), [
    async ({ cli, openView, shot, canvas }) => {
      cli('rpc', 'open', JSON.stringify(path.join(workspace, 'workspace.trig')));
      await openView(bookshopViews.model);
      await shot('bookshop-model');
      await openView(bookshopViews.bookshop);
      await shot('bookshop-view');
      await canvas.screenshot({ path: file('bookshop-canvas') });
    },
    async ({ page, card, settle, shot }) => {
      await card('Animal Farm').click();
      await settle();
      await shot('properties');
      await page.keyboard.press('Escape');
    },
    async ({ page, navNode, settle, shot }) => {
      // A model file of the navigator opens as its Model explorer. Expand its folders.
      await navNode('data.ttl').click();
      await settle();
      const tree = page.locator('.catenary-file-tree:visible').first();
      for (let i = 0; i < 6; i++) {
        const toggle = tree.locator('.theia-ExpansionToggle.theia-mod-collapsed').first();
        if (!await toggle.count()) break;
        await toggle.click();
        await settle(500);
      }
      await shot('model-explorer');
    }
  ]);
}

// --- A bookshop from scratch: the tutorial. ---
const P = {
  scheme: 'http://example.org/cities#Cities',
  rdfType: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
  xsd: t => `http://www.w3.org/2001/XMLSchema#${t}`
};

async function scratch(dir) {
  const workspace = path.join(dir, 'bookshop');
  fs.mkdirSync(workspace);
  const external = path.join(dir, 'downloads', 'cities.ttl');
  fs.mkdirSync(path.dirname(external));
  fs.writeFileSync(external, `@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix cities: <http://example.org/cities#> .

cities:Cities a skos:ConceptScheme ; skos:prefLabel "Cities" .
cities:Tangamandapio a skos:Concept ; skos:prefLabel "Tangamandapio" ; skos:inScheme cities:Cities .
cities:Macondo a skos:Concept ; skos:prefLabel "Macondo" ; skos:inScheme cities:Cities .
cities:Comala a skos:Concept ; skos:prefLabel "Comala" ; skos:inScheme cities:Cities .
`);
  const state = {};
  await session(workspace, path.join(dir, 'config'), [
    // 1. New workspace: File → New Workspace… creates the workspace file, the shapes and SKOS files and views/main.view.trig.
    async ({ cli, openView, shot, page, settle }) => {
      const r = cli('rpc', 'create', JSON.stringify(path.join(workspace, 'workspace.catenary.trig')));
      if (!r.result?.ok) throw new Error('create: ' + JSON.stringify(r));
      state.main = cli('model', 'views', '--keys')[0];
      await openView(state.main);
      // The first open of a folder without settings asks once where new subjects go.
      const setUp = page.locator('.dialogBlock', { hasText: 'Set Up Workspace' });
      if (await setUp.isVisible()) { await setUp.getByRole('button', { name: 'Cancel' }).click(); await settle(); }
      await shot('scratch-new-workspace');
    },
    // 2. Import: File → Import RDF Files… copies the file to imported/ and locks it. Place the scheme on the canvas.
    async ({ cli, exec, openView, shot, settle, layout }) => {
      const r = cli('rpc', 'importFiles', JSON.stringify([external]));
      if (r.error) throw new Error('importFiles: ' + JSON.stringify(r));
      await settle(2000);
      await openView(state.main);
      exec({ kind: 'addToView', view: state.main, ids: [iriId(P.scheme)], at: { x: 620, y: 80 } });
      await layout();
      await shot('scratch-import');
    },
    // 3. Shapes: the Shape tool, + attribute, and a property to another shape.
    async ({ exec, shot, fit }) => {
      state.book = exec({ kind: 'createNodeShape', label: 'Book', targetClass: 'urn:name:Book', view: state.main, at: { x: 80, y: 80 } }).id;
      exec({ kind: 'createPropertyShape', shape: state.book, path: { kind: 'iri', iri: 'urn:name:title' }, range: { kind: 'datatype', datatype: P.xsd('string') }, minCount: 1, maxCount: 1, view: state.main });
      exec({ kind: 'createPropertyShape', shape: state.book, path: { kind: 'iri', iri: 'urn:name:publicationYear', name: 'publication year' }, range: { kind: 'datatype', datatype: P.xsd('integer') }, maxCount: 1, view: state.main });
      state.author = exec({ kind: 'createNodeShape', label: 'Author', targetClass: 'urn:name:Author', view: state.main, at: { x: 620, y: 420 } }).id;
      exec({ kind: 'createPropertyShape', shape: state.author, path: { kind: 'iri', iri: 'urn:name:born' }, range: { kind: 'datatype', datatype: P.xsd('date') }, maxCount: 1, view: state.main });
      exec({ kind: 'createPropertyShape', shape: state.author, path: { kind: 'iri', iri: 'urn:name:city' }, range: { kind: 'scheme', schemes: [P.scheme] }, maxCount: 1, view: state.main });
      state.authorProperty = exec({ kind: 'createPropertyShape', shape: state.book, path: { kind: 'iri', iri: 'urn:name:author' }, range: { kind: 'node', shape: state.author }, view: state.main }).id;
      await fit();
      await shot('scratch-shapes');
    },
    // 4. Instances on a second view: the Book and Author tools of the palette, and a relation with +.
    async ({ exec, openView, shot, layout }) => {
      state.books = exec({ kind: 'createView', label: 'Books' }).id;
      await openView(state.books);
      state.farm = exec({ kind: 'createInstance', classIri: 'urn:name:Book', label: 'Animal Farm', view: state.books, at: { x: 80, y: 80 } }).id;
      state.nef = exec({ kind: 'createInstance', classIri: 'urn:name:Book', label: 'Nineteen Eighty-Four', view: state.books, at: { x: 80, y: 300 } }).id;
      const literal = (value, datatype) => ({ termType: 'Literal', value, ...(datatype ? { datatype: P.xsd(datatype) } : {}) });
      exec({ kind: 'setStatements', id: state.farm, values: { 'urn:name:title': [literal('Animal Farm')], 'urn:name:publicationYear': [literal('1945', 'integer')] } });
      exec({ kind: 'setStatements', id: state.nef, values: { 'urn:name:title': [literal('Nineteen Eighty-Four')], 'urn:name:publicationYear': [literal('1949', 'integer')] } });
      exec({ kind: 'createRelation', subject: state.farm, predicate: 'urn:name:author', object: { classIri: 'urn:name:Author', label: 'George Orwell' }, view: state.books, at: { x: 520, y: 180 } });
      await layout();
      await shot('scratch-instances');
    },
    // 5. Update the shape: author becomes required. The book without an author is a violation.
    async ({ exec, cli, shot, settle, page }) => {
      exec({ kind: 'setPropertyShape', id: state.authorProperty, patch: { minCount: 1 } });
      // The toggle does not report back to the CLI: ignore its "waits for an answer" result.
      try { cli('run', 'problemsView:toggle'); } catch {}
      await settle(2000);
      await shot('scratch-update-shape');
    },
    // 6. A document with a view, and its export.
    async ({ navNode, shot, settle, cli, page, workspace }) => {
      fs.writeFileSync(path.join(workspace, 'notes.md'), `# A small bookshop

Each book has a title, a publication year and at least one author.

![Books](urn:name:Books)

An author was born in a city of the Cities scheme.
`);
      await settle(1500);
      await navNode('notes.md').click();
      await settle(1500);
      await shot('scratch-document');
      cli('run', 'catenary.exportMarkdown', JSON.stringify(path.join(workspace, 'notes.md')));
      await settle(1500);
      await shot('scratch-export');
      await page.keyboard.press('Escape');
    }
  ]);
}

const sets = { bookshop, scratch };

async function main() {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(sets);
  for (const name of names) if (!sets[name]) throw new Error(`Unknown set: ${name}. Known: ${Object.keys(sets).join(', ')}`);
  fs.mkdirSync(out, { recursive: true });
  for (const name of names) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `catenary-www-${name}-`));
    fs.mkdirSync(path.join(dir, 'config'));
    try { await sets[name](dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
