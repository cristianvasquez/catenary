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
    // Each walk below goes one level at a time. A level asks one query per path and one target query, never one query per node.
    const paths = new Map<string, FocusNode[]>();
    const fetch = (wanted: readonly { ref: NodeReference; node: FocusNode }[], reverse: boolean) => {
        const byPath = new Map<string, Map<string, FocusNode>>();
        for (const { ref, node } of wanted) {
            if (!ref.path || paths.has(JSON.stringify([ref.path, node, reverse]))) continue;
            const nodes = byPath.get(ref.path) ?? byPath.set(ref.path, new Map()).get(ref.path)!;
            nodes.set(JSON.stringify(node), node);
        }
        for (const [path, nodes] of byPath) {
            for (const node of nodes.values()) paths.set(JSON.stringify([path, node, reverse]), []);
            const seen = new Set<string>();
            for (const r of port.select(`SELECT ?node ?value ${dataset} WHERE { VALUES ?node { ${[...nodes.values()].map(term).join(' ')} }
                ${reverse ? `?value ${path} ?node` : `?node ${path} ?value`} }`)) {
                const node = focus(r.node), value = focus(r.value), key = JSON.stringify([path, node, reverse]);
                if (seen.has(key + JSON.stringify(value))) continue;
                seen.add(key + JSON.stringify(value));
                paths.get(key)!.push(value);
            }
        }
    };
    const values = (ref: NodeReference, node: FocusNode, reverse: boolean): FocusNode[] =>
        ref.path ? paths.get(JSON.stringify([ref.path, node, reverse]))! : [node];
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
        const direct = new Map<string, boolean>();
        type State = { origin: FocusNode; target: string; shape: string; node: FocusNode; first?: TargetReason };
        let level: State[] = selection.nodes.flatMap(origin => targets.map(target => ({ origin, target, shape: target, node: origin })));
        const seen = new Set<string>();
        while (level.length) {
            level = level.filter(state => { const key = JSON.stringify(state); return !seen.has(key) && !!seen.add(key); });
            const open = level.filter(s => s.first && !direct.has(JSON.stringify([s.shape, s.node])));
            if (open.length) {
                const shapes = [...new Set(open.map(s => s.shape))], nodes = [...new Map(open.map(s => [JSON.stringify(s.node), s.node])).values()];
                for (const s of open) direct.set(JSON.stringify([s.shape, s.node]), false);
                for (const m of targetMatches(port, scope, { nodes, shapes })) direct.set(JSON.stringify([m.shape, m.node]), true);
            }
            for (const s of level) if (s.first && direct.get(JSON.stringify([s.shape, s.node]))) add(s.target, s.origin, [s.first]);
            const steps = level.flatMap(state => refs.filter(r => r.target === state.shape).map(ref => ({ state, ref, node: state.node })));
            fetch(steps, true);
            level = steps.flatMap(({ state, ref }) => values(ref, state.node, true).map(parent =>
                ({ origin: state.origin, target: state.target, shape: ref.source, node: parent, first: state.first ?? reason(ref, parent) })));
        }
    } else if (selection.shapes) {
        const ancestors = new Set(selection.shapes);
        for (let changed = true; changed;) {
            changed = false;
            for (const ref of refs) if (ancestors.has(ref.target) && !ancestors.has(ref.source)) { ancestors.add(ref.source); changed = true; }
        }
        let level = targetMatches(port, scope, { shapes: [...ancestors] });
        const seen = new Set<string>();
        while (level.length) {
            for (const state of level) add(state.shape, state.node, state.reasons);
            level = level.filter(state => { const key = JSON.stringify([state.shape, state.node]); return !seen.has(key) && !!seen.add(key); });
            const steps = level.flatMap(state => refs.filter(r => r.source === state.shape && ancestors.has(r.target)).map(ref => ({ state, ref, node: state.node })));
            fetch(steps, false);
            level = steps.flatMap(({ state, ref }) => values(ref, state.node, false).map(node => ({ shape: ref.target, node, reasons: [reason(ref, state.node)] })));
        }
    }
    return [...found.values()].filter(m => !selection.shapes || selection.shapes.includes(m.shape))
        .map(m => ({ ...m, reasons: m.reasons.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }))
        .sort((a, b) => a.shape.localeCompare(b.shape) || JSON.stringify(a.node).localeCompare(JSON.stringify(b.node)));
}
