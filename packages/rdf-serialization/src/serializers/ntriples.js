// Vendored from rdf-cli commit ee42d12dc15c4dadbc40d18b569d4978a451bcb8 (MIT).
// These RDF 1.2 term helpers are shared by canonical.js and triplify.js.
import toNT from '@rdfjs/to-ntriples'
import rdf from 'rdf-ext'

// RDF 1.2 triple terms and directional literals need syntax extensions.
export function isDirectional (term) {
  return term.termType === 'Literal' && Boolean(term.direction)
}

export function directionalToNT (term, toText = toNT) {
  return `${toText(rdf.literal(term.value, term.language))}--${term.direction}`
}

export function termToNT (term) {
  if (term.termType === 'Quad') {
    return `<<( ${termToNT(term.subject)} ${termToNT(term.predicate)} ${termToNT(term.object)} )>>`
  }
  if (isDirectional(term)) return directionalToNT(term)
  return toNT(term)
}
