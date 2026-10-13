// Browser rendering checks without a backend: a page with the stylesheet or the SHACL form bundle only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { test, root } = require('./harness.cjs');

test('browser: law_edgeStrokeScales: visible edge strokes scale, hit strokes stay fixed', { timeout: 45000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<svg width="400" height="200"><g class="catenary-edge" style="--c: black"><path class="hit" d="M20 100 H300"/><path class="line" d="M20 100 H300"/></g></svg>');
  await page.addStyleTag({ path: path.join(root, 'modeler/css/modeler.css') });
  for (const state of ['', 'mouseover', 'selected']) {
    for (const zoom of [1, 0.25, 2]) {
      const strokes = await page.evaluate(({ state, zoom }) => {
        const edge = document.querySelector('.catenary-edge');
        edge.setAttribute('class', `catenary-edge ${state}`);
        edge.setAttribute('transform', `scale(${zoom})`);
        return ['line', 'hit'].map(name => {
          const path = edge.querySelector(`.${name}`), style = getComputedStyle(path);
          return { effect: style.vectorEffect, width: parseFloat(style.strokeWidth), scale: path.getScreenCTM().a };
        });
      }, { state, zoom });
      const width = state ? 2.5 : 1.5;
      assert.equal(strokes[0].effect, 'none', `${state}: visible stroke uses the canvas transform`);
      assert.equal(strokes[0].width * strokes[0].scale, width * zoom, `${state}: screen width follows zoom`);
      assert.equal(strokes[1].effect, 'non-scaling-stroke', 'hit area stays fixed on screen');
      assert.equal(strokes[1].width, 16);
    }
  }
});

// 45 s: the first browser start of a CI runner takes about 15 s (launch and first page, Chromium 154 on ubuntu-latest).
test('browser: node OR selector stays visible in a narrow Properties form', { timeout: 45000 }, async t => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const bundle = path.join(root, 'node_modules/@ulb-darmstadt/shacl-form/dist/bundle.js');
  await page.route('http://form.test/**', route => route.fulfill(
    new URL(route.request().url()).pathname !== '/'
      ? { contentType: 'text/javascript', body: fs.readFileSync(path.join(path.dirname(bundle), new URL(route.request().url()).pathname)) }
      : { contentType: 'text/html', body: '<div class="catenary-shacl-form" style="width: 320px"></div><script type="module" src="/bundle.js"></script>' }
  ));
  await page.goto('http://form.test/');
  await page.addStyleTag({ path: path.join(root, 'modeler/css/modeler.css') });
  await page.evaluate(async () => {
    await customElements.whenDefined('shacl-form');
    const form = document.createElement('shacl-form');
    form.setAttribute('data-shapes', `
      @prefix sh: <http://www.w3.org/ns/shacl#> .
      @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      <urn:test:Shape> a sh:NodeShape; sh:targetClass <urn:test:Role>; sh:or <urn:test:list1> .
      <urn:test:list1> rdf:first <urn:test:owns>; rdf:rest <urn:test:list2> .
      <urn:test:list2> rdf:first <urn:test:stewards>; rdf:rest rdf:nil .
      <urn:test:owns> a sh:PropertyShape; sh:path <urn:test:owns>; sh:name "owns"; sh:datatype <http://www.w3.org/2001/XMLSchema#string>; sh:minCount 1 .
      <urn:test:stewards> a sh:PropertyShape; sh:path <urn:test:stewards>; sh:name "stewards"; sh:datatype <http://www.w3.org/2001/XMLSchema#string>; sh:minCount 1 .
    `);
    form.setAttribute('data-shape-subject', 'urn:test:Shape');
    form.setAttribute('data-values-subject', 'urn:test:role');
    document.querySelector('.catenary-shacl-form').append(form);
  });
  const selector = page.locator('shacl-form [part="constraint-editor"] rokit-select');
  await selector.waitFor();
  const bounds = await selector.boundingBox();
  const container = await page.locator('.catenary-shacl-form').boundingBox();
  assert.ok(bounds.width > 100, `OR selector has usable width: ${bounds.width}`);
  assert.ok(bounds.x + bounds.width <= container.x + container.width + 1, 'OR selector fits inside the panel');
  await selector.click();
  await selector.getByRole('option', { name: 'owns', exact: true }).click();
  await page.locator('shacl-form label').filter({ hasText: /^owns$/ }).waitFor();
  assert.equal(await selector.count(), 0, 'choosing a branch replaces the selector with its field');
});
