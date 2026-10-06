# Catenary RDF serialization

This package vendors the canonicalization and Turtle/TriG serialization code that Catenary needs. It does not include the `rdf-cli` command or pipeline.

The source comes from [`rdf-cli`](https://github.com/cristianvasquez/rdf-cli), commit `ee42d12dc15c4dadbc40d18b569d4978a451bcb8`, under the included MIT license. Catenary keeps the RDF 1.2 term support and removes helpers that Catenary does not use.

The Turtle serializer still uses `@rdfjs/serializer-turtle` 1.1.5. The workspace patch for its list serialization defect remains required and has a regression test in `packages/rdf/test/list-save.test.ts`.
