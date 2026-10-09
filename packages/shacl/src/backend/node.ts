import type { FocusNode, TargetMatch, TargetReason } from '../common';
import { focus, iri, term, targetMatches } from './targets';
import type { TargetQueryPort, TargetScope, TargetSelection } from './targets';

const SH = 'http://www.w3.org/ns/shacl#', RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

export interface NodeReference {
    source: string;
    target: string;
    property?: string;
    /** A compiled SPARQL property path. Only the shape reader produces this value. */
    path?: string;
}

/** Read shape structure once per shape revision. Paths can cross source files. */
export function readNodeReferences(port: TargetQueryPort, graphs: readonly string[]): NodeReference[] {
    if (!graphs.length) return [];
    const rows = port.select(`SELECT ?s ?p ?o ${graphs.map(g => `FROM ${iri(g)}`).join(' ')} WHERE { ?s ?p ?o }`);
    const values = (s: string, p: string) => rows.filter(r => r.s.value === s && r.p.value === p).map(r => r.o);
    const path = (id: string, seen = new Set<string>()): string => {
        if (seen.has(id)) throw new Error('Cyclic SHACL property path.');
        const next = new Set([...seen, id]);
        const list = (head: string): string[] => {
            const result: string[] = [], cells = new Set<string>();
            for (let cell = head; cell !== RDF + 'nil';) {
                if (cells.has(cell)) throw new Error('Cyclic SHACL path list.');
                cells.add(cell);
                const first = values(cell, RDF + 'first')[0], rest = values(cell, RDF + 'rest')[0];
                if (!first || !rest) throw new Error('Incomplete SHACL path list.');
                result.push(path(first.value, next)); cell = rest.value;
            }
            return result;
        };
        if (values(id, RDF + 'first').length) return `(${list(id).join('/')})`;
        for (const [name, suffix] of [['inversePath', ''], ['zeroOrMorePath', '*'], ['oneOrMorePath', '+'], ['zeroOrOnePath', '?']]) {
            const inner = values(id, SH + name)[0];
            if (inner) return name === 'inversePath' ? `^(${path(inner.value, next)})` : `(${path(inner.value, next)})${suffix}`;
        }
        const alt = values(id, SH + 'alternativePath')[0];
        return alt ? `(${list(alt.value).join('|')})` : iri(id);
    };
    const refs: NodeReference[] = [];
    for (const r of rows.filter(r => r.p.value === SH + 'node' && r.o.termType === 'NamedNode')) {
        const p = values(r.s.value, SH + 'path')[0];
        if (!p) { refs.push({ source: r.s.value, target: r.o.value }); continue; }
        const owners = rows.filter(o => o.p.value === SH + 'property' && o.o.value === r.s.value).map(o => o.s.value);
        for (const source of new Set([r.s.value, ...owners])) refs.push({ source, target: r.o.value, property: r.s.value, path: path(p.value) });
    }
    return refs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Applicable means checked, not conforming. Node constraints never add an rdf:type statement. */
export function applicableMatches(port: TargetQueryPort, scope: TargetScope, refs: readonly NodeReference[], selection: TargetSelection): TargetMatch[] {
    if (selection.nodes?.length === 0 || selection.shapes?.length === 0) return [];
    const dataset = scope.data.map(g => `FROM ${iri(g)}`).join(' ');
    const paths = new Map<string, FocusNode[]>();
    const values = (ref: NodeReference, node: FocusNode, reverse: boolean): FocusNode[] => {
        if (!ref.path) return [node];
        const key = JSON.stringify([ref.path, node, reverse]);
        if (!paths.has(key)) paths.set(key, port.select(`SELECT DISTINCT ?value ${dataset} WHERE {
            ${reverse ? `?value ${ref.path} ${term(node)}` : `${term(node)} ${ref.path} ?value`}
        }`).map(r => focus(r.value)));
        return paths.get(key)!;
    };
    const reason = (ref: NodeReference, sourceNode: FocusNode): TargetReason => ({
        kind: 'node', target: { termType: 'NamedNode', value: ref.target }, sourceShape: ref.source, sourceNode,
        ...(ref.property ? { property: ref.property } : {})
    });
    const found = new Map<string, TargetMatch>();
    const add = (shape: string, node: FocusNode, reasons: TargetReason[]) => {
        const key = JSON.stringify([shape, node]), match = found.get(key) ?? { shape, node, reasons: [] };
        for (const r of reasons) if (!match.reasons.some(x => JSON.stringify(x) === JSON.stringify(r))) match.reasons.push(r);
        found.set(key, match);
    };
    if (selection.nodes) {
        // Walk toward root targets for each requested node. Never read all instances for an instance request.
        for (const direct of targetMatches(port, scope, selection)) add(direct.shape, direct.node, direct.reasons);
        const targets = [...new Set(refs.map(r => r.target))].filter(s => !selection.shapes || selection.shapes.includes(s));
        const directCache = new Map<string, boolean>();
        for (const node of selection.nodes) for (const target of targets) {
            const queue: { shape: string; node: FocusNode; first?: TargetReason }[] = [{ shape: target, node }];
            const seen = new Set<string>();
            for (let i = 0; i < queue.length; i++) {
                const state = queue[i], key = JSON.stringify(state);
                if (seen.has(key)) continue;
                seen.add(key);
                const pair = JSON.stringify([state.shape, state.node]);
                if (!directCache.has(pair)) directCache.set(pair, targetMatches(port, scope, { nodes: [state.node], shapes: [state.shape] }).length > 0);
                if (state.first && directCache.get(pair)) add(target, node, [state.first]);
                for (const ref of refs.filter(r => r.target === state.shape)) for (const parent of values(ref, state.node, true))
                    queue.push({ shape: ref.source, node: parent, first: state.first ?? reason(ref, parent) });
            }
        }
    } else if (selection.shapes) {
        const ancestors = new Set(selection.shapes);
        for (let changed = true; changed;) {
            changed = false;
            for (const ref of refs) if (ancestors.has(ref.target) && !ancestors.has(ref.source)) { ancestors.add(ref.source); changed = true; }
        }
        const queue = targetMatches(port, scope, { shapes: [...ancestors] });
        const seen = new Set<string>();
        for (let i = 0; i < queue.length; i++) {
            const state = queue[i];
            add(state.shape, state.node, state.reasons);
            const key = JSON.stringify([state.shape, state.node]);
            if (seen.has(key)) continue;
            seen.add(key);
            for (const ref of refs.filter(r => r.source === state.shape && ancestors.has(r.target))) for (const node of values(ref, state.node, false))
                queue.push({ shape: ref.target, node, reasons: [reason(ref, state.node)] });
        }
    }
    return [...found.values()].filter(m => !selection.shapes || selection.shapes.includes(m.shape))
        .map(m => ({ ...m, reasons: m.reasons.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }))
        .sort((a, b) => a.shape.localeCompare(b.shape) || JSON.stringify(a.node).localeCompare(JSON.stringify(b.node)));
}
