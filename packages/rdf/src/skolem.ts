// The skolem IRIs of Catenary: rdf-core skolemizer with the prefix urn:skolem: (manifest §1, skolemPrefix).

import { skolemizer } from 'rdf-core';

export const SKOLEM_BASE = 'urn:skolem:';
export const { isSkolem, skolemize, skolemIri } = skolemizer(SKOLEM_BASE);
