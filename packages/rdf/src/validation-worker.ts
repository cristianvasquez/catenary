// The worker thread of the SHACL validation (validation-runner.ts): it runs the validator (validate.ts) so that the backend thread stays
// free for edits and requests. Message in: { id, data, shapes } (plain quads, a full copy for each run); out: { id, results, report }
// or { id, error }.

import { parentPort } from 'worker_threads';
import { PlainTerm, plainToQuads, quadsToPlain } from './plain-quads';
import { validate } from './validate';

parentPort?.on('message', async (m: { id: number; data: PlainTerm[]; shapes: PlainTerm[] }) => {
    try {
        const { results, report } = await validate(plainToQuads(m.data), plainToQuads(m.shapes));
        parentPort!.postMessage({ id: m.id, results, report: quadsToPlain(report) });
    } catch (e) {
        parentPort!.postMessage({ id: m.id, error: (e as Error).message });
    }
});
