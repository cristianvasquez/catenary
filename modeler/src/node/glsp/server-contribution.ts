// Runs the GLSP server inside the Theia backend process, so that it shares the ModelStore.

import { ActionMessage, DefaultGLSPServer, GLSPServerError, MessageAction } from '@eclipse-glsp/server';
import { LogLevel, ServerModule, createAppModule } from '@eclipse-glsp/server/node';
import { GLSPNodeServerContribution } from '@eclipse-glsp/theia-integration/lib/node';
import { ContainerModule, injectable } from '@theia/core/shared/inversify';
import { CONTRIBUTION_ID } from '../../common/protocol';
import { ViewDiagramModule } from './diagram-module';

/** Characters of a failed action kept in the log. */
const MAX_ACTION = 2000;

/**
 * An error outside an edit (a handler bug, an unknown action): the GLSP error path (spec/ui-manifest.hs §4.9). The default logs the
 * message and the reason on two lines and sends one error message. This server logs one line with the action and the stack, and
 * sends the same one message. An error of an edit never reaches this path: ViewSession.edit sends its warning itself.
 */
@injectable()
export class LoggingGLSPServer extends DefaultGLSPServer {
    protected override handleProcessError(message: ActionMessage, reason: unknown): void {
        console.error(`[catenary] GLSP action "${message.action.kind}" failed (client ${message.clientId}): ${JSON.stringify(message.action).slice(0, MAX_ACTION)}\n`,
            reason instanceof Error ? reason.stack : reason);
        const cause = reason instanceof GLSPServerError ? reason.cause : reason;
        const errorMsg = reason instanceof GLSPServerError ? reason.message : `Could not process action: '${message.action.kind}'`;
        this.sendToClient({ clientId: message.clientId, action: MessageAction.create(errorMsg, { severity: 'ERROR', details: String(cause) }) });
    }
}

class CatenaryServerModule extends ServerModule {
    protected override bindGLSPServer() { return LoggingGLSPServer; }
}

@injectable()
export class ViewGLSPServerContribution extends GLSPNodeServerContribution {
    readonly id = CONTRIBUTION_ID;

    protected override createServerModules(): ContainerModule[] {
        const appModule = createAppModule({ logLevel: LogLevel.warn, consoleLog: true, fileLog: false });
        const mainModule = new CatenaryServerModule().configureDiagramModule(new ViewDiagramModule());
        return [appModule, mainModule];
    }
}
