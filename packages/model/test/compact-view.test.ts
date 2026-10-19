// A view as text lines (spec/manifest.hs §11.1 law_compactLinesCoverBoxes).
import { describe, expect, it } from 'vitest';
import { compactView } from '../src/compact-view';
import { emptyDoc, type Doc } from '../src/doc';

const DCAT = 'http://www.w3.org/ns/dcat#';

function doc(): Doc {
    const d = emptyDoc();
    d.instances.a = { id: 'a', label: 'Sales data', types: [DCAT + 'Dataset'], uri: 'urn:name:Sales%20data', fields: {} };
    d.instances.b = { id: 'b', label: 'API', types: [DCAT + 'DataService'], uri: 'urn:name:API', fields: {} };
    d.relations.r = { id: 'r', subject: 'a', predicate: DCAT + 'servesDataset', object: 'b' };
    d.views.v = {
        id: 'v', label: 'Product context', uri: 'urn:name:Product%20context',
        boxes: [
            { kind: 'group', id: 'g', label: 'Team', x: 0, y: 0, width: 800.4, height: 600 },
            { kind: 'note', id: 'n', text: 'first\nsecond', x: 10.6, y: 20 },
            { kind: 'card', id: 'pa', element: 'a', x: 100.2, y: 100.7, width: 640, height: 320 },
            { kind: 'card', id: 'pb', element: 'b', x: 900, y: 100, width: 640, height: 320 }
        ].map(b => ({ width: 320, height: 180, ...b })) as Doc['views'][string]['boxes'],
        edges: [{ relation: 'r', hidden: true }],
        arrows: [{ id: 'w', from: 'n', to: 'pa' }]
    };
    return d;
}

describe('compactView', () => {
    it('gives the view, then a line per box in view order, per edge and per arrow', () => {
        expect(compactView(doc(), 'v')).toEqual([
            'view "Product context" urn:name:Product%20context',
            'group Team 0 0 800 600',
            'note 11 20: first\\nsecond',
            'card "Sales data" dcat:Dataset urn:name:Sales%20data 100 101 640 320',
            'card API dcat:DataService urn:name:API 900 100 640 320',
            'edge "Sales data" dcat:servesDataset API hidden',
            'arrow first\\nsecond "Sales data"'
        ]);
        expect(compactView(doc(), 'missing')).toEqual([]);
    });

    it('law_compactLinesCoverBoxes: the lines after the first are the boxes, the edges and the arrows', () => {
        const d = doc(), v = d.views.v;
        v.boxes.push({ kind: 'reference', id: 'ref', target: 'v', x: 0, y: 700, width: 280, height: 96 },
            { kind: 'collection', id: 'c', members: ['a', 'b'], x: 0, y: 900, width: 320, height: 240 });
        v.edges.push({ relation: 'unknown' });
        const lines = compactView(d, 'v');
        expect(lines.length - 1).toBe(v.boxes.length + v.edges.length + v.arrows.length);
        expect(lines).toContain('reference "Product context" 0 700');
        expect(lines).toContain('collection "Sales data, API" 0 900 320 240');
        expect(lines).toContain('edge unknown - -');
    });

    it('a card of a shapes view: a node shape and a property shape with their label, class and IRI', () => {
        const d = doc(), v = d.views.v;
        d.shapes.nodeShapes.s = { id: 's', uri: 'urn:DatasetShape', label: 'Dataset', targetClass: DCAT + 'Dataset', file: 'shapes.ttl', properties: ['p'], constraints: [], raw: [] } as unknown as Doc['shapes']['nodeShapes'][string];
        d.shapes.properties.p = { id: 'p', uri: 'urn:DatasetShape-theme', owner: 's', path: { kind: 'iri', iri: DCAT + 'theme' } } as unknown as Doc['shapes']['properties'][string];
        v.boxes = [
            { kind: 'card', id: 'ps', element: 's', x: 0, y: 0, width: 640, height: 320 },
            { kind: 'card', id: 'pp', element: 'p', x: 0, y: 400, width: 320, height: 100 }
        ];
        v.edges = []; v.arrows = [];
        expect(compactView(d, 'v').slice(1)).toEqual([
            'card Dataset sh:NodeShape urn:DatasetShape 0 0 640 320',
            'card "Dataset — dcat:theme" sh:PropertyShape urn:DatasetShape-theme 0 400 320 100'
        ]);
    });
});
