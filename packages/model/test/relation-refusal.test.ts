// The refusal of a relation (spec/manifest.hs §6.2 law_refusalNamesShapes).
import { describe, expect, it } from 'vitest';
import { iriId } from '../src/ids';
import type { ClassDef, Classes, RelationDef } from '../src/metamodel';
import { relationRefusal, relationRefusalData } from '../src/relation-refusal';
import { emptyShapes, type NodeShape, type ShapesModel } from '../src/shapes-doc';

const cls = (iri: string, shapes: string[], relations: RelationDef[] = []): ClassDef =>
    ({ iri, name: iri, shapes, fields: [], relations, unsupported: [], color: '', labelInShape: false });
const shape = (uri: string, label: string, targetClass: string): NodeShape =>
    ({ id: iriId(uri), uri, label, targetClass, file: 'shapes.ttl', properties: [], constraints: [], raw: [] });
const KNOWS: RelationDef = { path: 'urn:knows', name: 'knows', targetClass: 'urn:Person' };
const meta: Classes = { classes: [
    cls('urn:Person', ['urn:PersonShape', 'urn:AgentShape'], [KNOWS]),
    cls('urn:Employee', ['urn:AgentShape', 'urn:EmployeeShape']),
    cls('urn:Book', [])
] };
const shapes: ShapesModel = emptyShapes();
for (const s of [shape('urn:PersonShape', 'Person', 'urn:Person'), shape('urn:AgentShape', 'Agent', 'urn:Person')]) shapes.nodeShapes[s.id] = s;

describe('relationRefusal', () => {
    it('names the predicate, both ends with their classes, the shapes of the subject and what it permits', () => {
        const data = relationRefusalData(meta, shapes, { label: 'Ann', classes: ['urn:Person'] }, { label: 'Dune', classes: ['urn:Book'] }, 'urn:wrote');
        expect(data.shapes).toEqual([
            { id: iriId('urn:PersonShape'), label: 'Person', targetClass: 'urn:Person' },
            { id: iriId('urn:AgentShape'), label: 'Agent', targetClass: 'urn:Person' }
        ]);
        expect(data.permitted).toEqual([KNOWS]);
        expect(relationRefusal(data)).toBe('No shape or RDFS rule permits <urn:wrote> from "Ann" (<urn:Person>) to "Dune" (<urn:Book>).'
            + ' Shapes of the subject: "Person", "Agent". Permitted from "Ann": "knows" (<urn:knows>) to <urn:Person>.');
    });

    it('a subject without a class or a shape: "no class" and "none"; a shape outside the shapes model: its compact IRI', () => {
        const none = relationRefusalData(meta, shapes, { label: 'X', classes: [] }, { label: 'Y', classes: ['urn:Book'] }, 'urn:p');
        expect(relationRefusal(none)).toBe('No shape or RDFS rule permits <urn:p> from "X" (no class) to "Y" (<urn:Book>).'
            + ' Shapes of the subject: none. Permitted from "X": none.');
        const employee = relationRefusalData(meta, shapes, { label: 'E', classes: ['urn:Employee'] }, { label: 'Y', classes: [] }, 'urn:p');
        expect(employee.shapes.map(s => s.label)).toEqual(['Agent', '<urn:EmployeeShape>']);
    });

    it('law_refusalNamesShapes: a refusal names every node shape that targets a subject class, once', () => {
        for (const classes of [['urn:Person'], ['urn:Employee'], ['urn:Person', 'urn:Employee'], ['urn:Employee', 'urn:Person', 'urn:Book'], ['urn:Book']]) {
            const data = relationRefusalData(meta, shapes, { label: 'S', classes }, { label: 'O', classes: [] }, 'urn:p');
            const targeting = [...new Set(classes.flatMap(c => meta.classes.find(d => d.iri === c)!.shapes))];
            expect(data.shapes.map(s => s.id).sort()).toEqual(targeting.map(iriId).sort());
            const text = relationRefusal(data);
            for (const s of data.shapes) expect(text).toContain(`"${s.label}"`);
        }
    });

    it('the order of the classes does not change the text', () => {
        const text = (classes: string[]) => relationRefusal(relationRefusalData(meta, shapes, { label: 'S', classes }, { label: 'O', classes: [...classes].reverse() }, 'urn:p'));
        expect(text(['urn:Person', 'urn:Employee'])).toBe(text(['urn:Employee', 'urn:Person']));
    });
});
