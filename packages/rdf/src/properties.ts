// Properties reads shared thing, statement, label and connection queries. The shapes index supplies UI identities.

import type { NamedNode, Quad } from '@rdfjs/types';
import {
    Classes, ElementProperties, InstanceProperties, NS, PropertyShapeProperties, RelationEnd, ResultRow, TermJSON,
    lockedKey, searchKind, termKey as jsonKey, termToJSON
} from '@catenary/model';
import { ModelGraph, VALIDATION_GRAPH, cmp } from './graph';
import { elementId, elementTerm, relationTriple } from './ids';
import { formCandidates } from './queries';
import type { ShapesIndex } from './shapes-read';
import { NOT_REPORT, connections, construct, iri, labels, rows, statements, thingHead, thingTypes, things } from './sparql';
import { rdf, termKey } from './terms';
import { readResults } from './validate';

export interface PropertiesContext {
    g: ModelGraph;
    meta: Classes;
    idx: ShapesIndex;
    /** The file with most statements of this subject. */
    fileOf: (t: NamedNode) => string | undefined;
    /** The imported files of a statement of the model graph (manifest ws:imported). */
    importedFiles: (q: Quad) => string[];
}

/** Properties of an element. Without an ID, return workspace counts. */
export function properties(ctx: PropertiesContext, id?: string): ElementProperties | undefined {
    if (id === undefined) return workspace(ctx);
    if (relationTriple(id)) return relation(ctx, id);
    if (ctx.idx.property.has(id)) return propertyShape(ctx, id);
    const t = elementTerm(id);
    return t?.termType === 'NamedNode' && thingHead(ctx.g, t) ? instance(ctx, t) : undefined;
}

/** Labels and written types of relation endpoints. */
function ends(g: ModelGraph, terms: NamedNode[]): Map<string, RelationEnd> {
    const facts = statements(g, terms.map(t => t.value));
    const names = labels(g, terms.map(t => t.value));
    return new Map(terms.map(t => [t.value, {
        id: elementId(t), uri: t.value, label: names.get(t.value)!,
        types: facts.filter(q => q.subject.value === t.value && q.predicate.value === NS.rdf + 'type').map(q => q.object.value).sort(cmp)
    }]));
}

/** Display rows of the shared report query. */
function results(ctx: PropertiesContext, pattern: string): ResultRow[] {
    return readResults(ctx.g, ctx.meta, pattern).map(r => ({
        focus: r.focus, focusLabel: r.label ?? r.focus, pathName: r.pathName, severity: r.severity, message: r.message
    })).sort((a, b) => cmp(a.focus, b.focus) || cmp(a.pathName ?? '', b.pathName ?? '') || cmp(a.message, b.message));
}

function instance(ctx: PropertiesContext, t: NamedNode): InstanceProperties {
    const { g, idx } = ctx;
    const end = ends(g, [t]).get(t.value)!;
    const own = statements(g, [t.value]);
    const objects = [...new Set(own.filter(q => q.object.termType === 'NamedNode').map(q => q.object.value))];
    const targetFacts = objects.length ? construct(g, `CONSTRUCT { ?s rdf:type ?type } WHERE {
        VALUES ?s { ${objects.map(iri).join(' ')} } { ${things()} }
    }`) : [];
    const known = new Set(targetFacts.map(q => q.subject.value));
    const fields: Record<string, TermJSON[]> = {}, targets: Record<string, string[]> = {};
    for (const q of own) {
        const p = q.predicate.value;
        if (p === NS.rdf + 'type' || p === NS.rdfs + 'label') continue;
        if (q.object.termType === 'NamedNode' && known.has(q.object.value)) (targets[p] ??= []).push(q.object.value);
        else {
            const v = termToJSON(q.object);
            if (v) (fields[p] ??= []).push(v);
        }
    }
    for (const p of Object.keys(fields)) fields[p].sort((a, b) => cmp(jsonKey(a), jsonKey(b)));
    for (const p of Object.keys(targets)) targets[p].sort(cmp);
    const shapeIds = new Map([...idx.nodeShape].map(([id, n]) => [n.term.value, id]));
    const shapeFacts = end.types.length ? construct(g, `CONSTRUCT { ?n sh:targetClass ?c } WHERE {
        VALUES ?c { ${end.types.map(iri).join(' ')} }
        GRAPH ?g { ?n sh:targetClass ?c } FILTER (?g != ${NOT_REPORT})
    }`) : [];
    const shapeTerms = [...new Set(shapeFacts.map(q => q.subject.value))].filter(s => shapeIds.has(s));
    const shapeNames = labels(g, shapeTerms);
    const shapes = shapeTerms.map(s => ({ id: shapeIds.get(s)!, uri: s, label: shapeNames.get(s)! })).sort((a, b) => a.label.localeCompare(b.label));
    const candidates = rdf.dataset(formCandidates(g, t)).toString().split('\n').filter(Boolean).sort().join('\n');
    const file = ctx.fileOf(t);
    const locked: string[] = [], importedFiles = new Set<string>();
    for (const q of own) {
        const files = ctx.importedFiles(rdf.quad(q.subject, q.predicate, q.object, g.model));
        if (!files.length) continue;
        files.forEach(f => importedFiles.add(f));
        const v = termToJSON(q.object);
        if (v) locked.push(lockedKey(q.predicate.value, v));
    }
    return {
        kind: 'instance', ...end, fields, ...(file ? { file } : {}), targets, shapes,
        ...(locked.length ? { locked: locked.sort(cmp), importedFiles: [...importedFiles].sort(cmp) } : {}),
        results: results(ctx, `VALUES ?f { ${iri(t.value)} } ?r sh:focusNode ?f .`), candidates
    };
}

function relation(ctx: PropertiesContext, id: string): ElementProperties | undefined {
    const { s, p, o } = relationTriple(id)!;
    if (!construct(ctx.g, `CONSTRUCT { ${iri(s.value)} ${iri(p.value)} ${iri(o.value)} } WHERE {
        ${connections(iri(s.value), iri(p.value), iri(o.value))}
    }`).length) return undefined;
    const e = ends(ctx.g, [s, o]);
    return { kind: 'relation', id, predicate: p.value, subject: e.get(s.value)!, object: e.get(o.value)! };
}

function propertyShape(ctx: PropertiesContext, id: string): PropertyShapeProperties {
    const term = ctx.idx.property.get(id)!.term;
    const own = ctx.idx.byTerm.get(termKey(term)) === id;
    return { kind: 'propertyShape', id, results: own ? results(ctx, `?r sh:sourceShape ${iri(term.value)} .`) : [] };
}

function workspace(ctx: PropertiesContext): ElementProperties {
    const { g } = ctx;
    const types = new Map<string, string[]>();
    for (const q of thingTypes(g)) if (q.predicate.value === NS.rdf + 'type') types.set(q.subject.value, [...(types.get(q.subject.value) ?? []), q.object.value]);
    const count = (query: string) => Number(rows(g, query)[0]?.n.value ?? 0);
    return {
        kind: 'workspace',
        instances: [...types.values()].filter(ts => ['instance', 'valueSet'].includes(searchKind(ts))).length,
        relations: construct(g, `CONSTRUCT { ?s ?p ?o } WHERE { ${connections()} }`).length,
        views: count(`SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { GRAPH ?g { ?s a view:View } FILTER (?g != ${NOT_REPORT}) }`),
        violations: count(`SELECT (COUNT(DISTINCT ?r) AS ?n) WHERE { GRAPH <${VALIDATION_GRAPH}> { ?r sh:resultSeverity sh:Violation } }`)
    };
}
