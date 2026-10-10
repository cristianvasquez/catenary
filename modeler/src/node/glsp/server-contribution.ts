// Runs the GLSP server inside the Theia backend process, so that it shares the ModelStore.

import { ActionMessage, DefaultGLSPServer } from '@eclipse-glsp/server';
import { LogLevel, ServerModule, createAppModule } from '@eclipse-glsp/server/node';
import { GLSPNodeServerContribution } from '@eclipse-glsp/theia-integration/lib/node';
import { ContainerModule, injectable } from '@theia/core/shared/inversify';
import { CONTRIBUTION_ID } from '../../common/protocol';
import { ViewDiagramModule } from './diagram-module';

/** Characters of a failed action kept in the log. */
const MAX_ACTION = 2000;

/** The default logs only the message of a failed action. This server also logs the action and the stack. */
@injectable()
export class LoggingGLSPServer extends DefaultGLSPServer {
    protected override handleProcessError(message: ActionMessage, reason: unknown): void | PromiseLike<void> {
        console.error(`[catenary] GLSP action "${message.action.kind}" failed (client ${message.clientId}): ${JSON.stringify(message.action).slice(0, MAX_ACTION)}\n`,
            reason instanceof Error ? reason.stack : reason);
        return super.handleProcessError(message, reason);
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
