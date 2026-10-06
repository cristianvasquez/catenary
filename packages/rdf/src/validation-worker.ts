// The worker thread of the SHACL validation (validation-runner.ts): it runs shacl-engine so that the backend thread stays free for
// edits and requests. Message in: { id, shapes, data } (plain quads); out: { id, results, report } or { id, error }.

import { parentPort } from 'worker_threads';
import { PlainTerm, plainToQuads, quadsToPlain } from './plain-quads';
import { shaclReport } from './validate';

parentPort?.on('message', async (m: { id: number; shapes: PlainTerm[]; data: PlainTerm[] }) => {
    try {
        const { results, report } = await shaclReport(plainToQuads(m.shapes), plainToQuads(m.data));
        parentPort!.postMessage({ id: m.id, results, report: quadsToPlain(report) });
    } catch (e) {
        parentPort!.postMessage({ id: m.id, error: (e as Error).message });
    }
});
