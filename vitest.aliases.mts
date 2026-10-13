// The source entry of each workspace package: tests and the worker build of the tests (vitest.global-setup.mts) use current source,
// never a stale package build in lib/.
import { fileURLToPath } from 'node:url';

const src = (path: string) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

export const sourceAliases: Record<string, string> = {
    '@catenary/shacl/common': src('shacl/src/common/index.ts'),
    '@catenary/shacl/backend': src('shacl/src/backend/index.ts'),
    '@catenary/contracts': src('contracts/src/index.ts'),
    '@catenary/rdfs': src('rdfs/src/index.ts'),
    '@catenary/model': src('model/src/index.ts'),
    '@catenary/rdf': src('rdf/src/index.ts'),
    'rdf-files': src('rdf-files/src/index.ts'),
    'rdf-core': src('rdf-core/src/index.ts')
};
