// The language of the labels (manifest ws:language, spec/manifest.hs §2 and §6.2 pickLabel). Checks law_oneLabelRule: the label of an
// instance in a Doc (viewDoc card, instanceLabels) equals labels() of its IRI.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelGraph } from '../src/graph';
import { elementId } from '../src/ids';
import { ModelStore } from '../src/model-store';
import { WS, manifestQuads, readManifest, NEAR } from '../src/files';
import { instanceLabels } from '../src/scoped-doc';
import { labels } from '../src/sparql';
import { rdf } from '../src/terms';
import { parseTrig } from '../src/trig';
import { openStore, tempWorkspace, workspaceTrig } from './helpers';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

const VIEW = 'urn:ex:view', CONCEPT = 'urn:ex:sensitive';

/** A concept with prefLabels in Finnish, Swedish and Slovenian, on a view; `language`: the manifest value, if any. */
function workspace(language?: string) {
    const w = tempWorkspace({
        'data.ttl': `@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
<${CONCEPT}> a skos:Concept ; skos:prefLabel "arkaluonteinen"@fi, "känslig"@sv, "občutljiv"@sl .\n`,
        'main.view.trig': `@prefix view: <https://cristianvasquez.github.io/catenary/vocab/view#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<${VIEW}> { <${VIEW}> a view:View ; rdfs:label "Main" .
  <${VIEW}/p/1> a view:Placement ; view:element <${CONCEPT}> ; view:view <${VIEW}> ; view:x 0 ; view:y 0 . }\n`,
        'workspace.trig': workspaceTrig({ defaultFile: 'data.ttl', language })
    }, 'catenary-language-');
    return { path: w.path('workspace.trig'), read: () => w.read('workspace.trig') };
}

/** The ws:language values of a workspace file text. */
const stored = async (text: string) => (await parseTrig(text)).quads.filter(q => q.predicate.equals(WS.language)).map(q => q.object.value);

const ok = (r: { ok: boolean; error?: string }) => { if (!r.ok) throw new Error(r.error); };

/** The label of the concept from labels(), the card of the view and instanceLabels (law_oneLabelRule: all three are equal). */
function shown(store: ModelStore): string[] {
    const g = (store as unknown as { graph: ModelGraph }).graph;
    return [
        labels(g, [CONCEPT]).get(CONCEPT)!,
        store.viewDoc(elementId(rdf.namedNode(VIEW))).instances[elementId(rdf.namedNode(CONCEPT))].label,
        instanceLabels(g).get(CONCEPT)!
    ];
}

describe('label language (ws:language)', () => {
    it('the manifest stores the language; not set: not written', () => {
        const m = { placement: { shapes: NEAR, concepts: NEAR, instances: NEAR }, exclude: [], imported: [] };
        const values = (language?: string) => manifestQuads({ ...m, language }, '/ws/w.trig').filter(q => q.predicate.equals(WS.language)).map(q => q.object.value);
        expect(values()).toEqual([]);
        expect(values('sv')).toEqual(['sv']);
        expect(readManifest(manifestQuads({ ...m, language: 'sv' }, '/ws/w.trig'), '/ws/w.trig').language).toBe('sv');
    });

    it('law_oneLabelRule: labels(), the card and instanceLabels give the label in the language of the setting', async () => {
        const ws = workspace('sv');
        const store = await openStore(ws.path);
        expect(store.files.language).toBe('sv');
        expect(shown(store)).toEqual(['känslig', 'känslig', 'känslig']);

        ok(await store.setSettings({ language: ' sl ' }));
        expect(store.files.language).toBe('sl');
        expect(await stored(ws.read())).toEqual(['sl']);
        expect(shown(store)).toEqual(['občutljiv', 'občutljiv', 'občutljiv']);

        // Empty clears the setting: no literal without a language, so the smallest.
        ok(await store.setSettings({ language: '' }));
        expect(store.files.language).toBeUndefined();
        expect(await stored(ws.read())).toEqual([]);
        expect(shown(store)).toEqual(['arkaluonteinen', 'arkaluonteinen', 'arkaluonteinen']);
    });
});
