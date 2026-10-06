// Runs the GLSP server inside the Theia backend process, so that it shares the ModelStore.

import { LogLevel, ServerModule, createAppModule } from '@eclipse-glsp/server/node';
import { GLSPNodeServerContribution } from '@eclipse-glsp/theia-integration/lib/node';
import { ContainerModule, injectable } from '@theia/core/shared/inversify';
import { CONTRIBUTION_ID } from '../../common/protocol';
import { ViewDiagramModule } from './diagram-module';

@injectable()
export class ViewGLSPServerContribution extends GLSPNodeServerContribution {
    readonly id = CONTRIBUTION_ID;

    protected override createServerModules(): ContainerModule[] {
        const appModule = createAppModule({ logLevel: LogLevel.warn, consoleLog: true, fileLog: false });
        const mainModule = new ServerModule().configureDiagramModule(new ViewDiagramModule());
        return [appModule, mainModule];
    }
}
