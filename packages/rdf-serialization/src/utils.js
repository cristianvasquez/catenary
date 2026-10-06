// Vendored from rdf-cli commit ee42d12dc15c4dadbc40d18b569d4978a451bcb8 (MIT).
// Keep only the helper used by canonical.js.
// The terms of a quad, with the terms inside triple terms (depth first).
export function * termsOf (quad) {
  for (const term of [quad.subject, quad.predicate, quad.object, quad.graph]) {
    yield term
    if (term.termType === 'Quad') yield * termsOf(term)
  }
}
