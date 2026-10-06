// Electron (ADR 0005): Theia refuses every HTTP request without the token of its window (ElectronTokenValidator). The command-line
// endpoint has its own token (cli-endpoint.ts: a random token in a file of mode 0600), so its path is let through here.

import { ElectronTokenValidator } from '@theia/core/lib/electron-node/token/electron-token-validator';
import { injectable } from '@theia/core/shared/inversify';
import type * as http from 'http';
import { CLI_HTTP_PATH } from '../common/cli-protocol';

@injectable()
export class CliTokenValidator extends ElectronTokenValidator {
    override allowRequest(request: http.IncomingMessage): boolean {
        return (request.method === 'POST' && request.url?.split('?')[0] === CLI_HTTP_PATH) || super.allowRequest(request);
    }
}
