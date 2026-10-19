import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EditCommand } from '../src';

// The kinds of EditCommand. A Record makes the compiler check that the list is complete (as KINDS in packages/rdf/src/commands.ts).
const KINDS: Record<EditCommand['kind'], true> = {
    createInstance: true, moveElementsToFile: true, placeExplorerElements: true, rename: true, setUri: true, setStatements: true,
    setTypes: true, delete: true, addToView: true, showRelations: true, showAsEdge: true, removeFromView: true, setBounds: true,
    setLayout: true, setEdgeLayout: true, hideEdges: true, setViewDescription: true, setViewElements: true, createRelation: true,
    reconnectRelation: true, createView: true, createNodeShape: true, proposeShapes: true, setNodeShape: true,
    createPropertyShape: true, setPropertyShape: true, groupProperties: true, setConstraint: true, ungroup: true,
    takeOutOfConstraint: true, createValueSet: true, addConcept: true, setConceptBroader: true, removeConcept: true,
    migrateData: true, duplicateView: true, createGroup: true, createNote: true, addViewReference: true, addFileReference: true,
    createArrow: true, collect: true, addToCollection: true, uncollect: true, pasteIntoView: true, moveBetweenViews: true,
    duplicate: true, pasteRdf: true
};

type Schema = { commands: { kind: string; doc: string; fields: { name: string; type: string; optional: boolean }[] }[]; types: Record<string, string> };
const schema: Schema = JSON.parse(readFileSync(new URL('../src/command-schema.json', import.meta.url), 'utf8'));

describe('command-schema.json (manifest §12)', () => {
    it('law_schemaCoversEveryKind: one entry per kind of EditCommand', () => {
        expect(schema.commands.map(c => c.kind).sort()).toEqual(Object.keys(KINDS).sort());
    });

    it('gives the fields of createInstance in source order', () => {
        const c = schema.commands.find(x => x.kind === 'createInstance')!;
        expect(c.fields.map(f => f.name)).toEqual(['classIri', 'label', 'view', 'at']);
        expect(c.fields.map(f => f.optional)).toEqual([false, false, true, true]);
        expect(schema.types.Point).toBe('{ x: number; y: number }');
    });
});
