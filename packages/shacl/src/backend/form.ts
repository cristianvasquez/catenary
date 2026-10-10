import { RDF, SH } from '@catenary/query';
import { iri } from './targets';
import type { TargetQueryPort } from './targets';

/** Predicates edited on the focus node. A property-level sh:node checks its values instead. */
export function shapePredicates(port: TargetQueryPort, graphs: readonly string[], shape: string): string[] {
    if (!graphs.length) return [];
    const steps = 'sh:node|sh:and/rdf:rest*/rdf:first|sh:or/rdf:rest*/rdf:first|sh:xone/rdf:rest*/rdf:first';
    return port.select(`PREFIX sh: <${SH}> PREFIX rdf: <${RDF}>
        SELECT DISTINCT ?p ${graphs.map(g => `FROM ${iri(g)}`).join(' ')} WHERE {
            { ${iri(shape)} (${steps})*/sh:property ?ps }
            UNION { ${iri(shape)} (${steps})+ ?ps }
            ?ps sh:path ?p . FILTER (isIRI(?p) && ?p != rdf:type)
            FILTER NOT EXISTS { ?p ?op ?value . VALUES ?op { sh:inversePath sh:alternativePath sh:zeroOrMorePath sh:oneOrMorePath sh:zeroOrOnePath rdf:first } }
        }`).map(r => r.p.value).sort();
}
