import { bindAsService } from '@eclipse-glsp/protocol/lib/di';
import { GLSPServerContribution } from '@eclipse-glsp/theia-integration/lib/node';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { ContainerModule } from '@theia/core/shared/inversify';
import { MODEL_SERVICE_PATH, ModelClient } from '../common/protocol';
import { CLI_BRIDGE_PATH, CliBridgeClient, CliBridgeServer } from '../common/cli-protocol';
import { ViewGLSPServerContribution } from './glsp/server-contribution';
import { ModelServiceImpl } from './model-service';
import { CliEndpoint, CliWindows } from './cli-endpoint';
import { CliTokenValidator } from './cli-token-validator';
import { ElectronTokenValidator } from '@theia/core/lib/electron-node/token/electron-token-validator';
import { ModelStore, useValidationWorker } from '@catenary/rdf';
import { existsSync } from 'fs';
import * as path from 'path';

export default new ContainerModule((bind, _unbind, isBound, rebind) => {
    // The bundled backend has the validation worker next to it (scripts/esbuild-catenary.mjs): SHACL validation leaves this thread free.
    const worker = path.join(__dirname, 'validation-worker.js');
    if (existsSync(worker)) useValidationWorker(worker);
    bind(ModelStore).toConstantValue(new ModelStore());
    bind(ModelServiceImpl).toSelf();
    bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler<ModelClient>(MODEL_SERVICE_PATH, client => {
        const service = ctx.container.get(ModelServiceImpl);
        service.setClient(client);
        client.onDidCloseConnection?.(() => service.dispose());
        return service;
    })).inSingletonScope();
    bindAsService(bind, GLSPServerContribution, ViewGLSPServerContribution);

    // Command-line interface: HTTP endpoint, and each frontend window as RPC client that answers the UI requests.
    bind(CliWindows).toSelf().inSingletonScope();
    bind(CliEndpoint).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(CliEndpoint);
    // Electron only (its token module is loaded before this module): the CLI path passes the token check of the window.
    if (isBound(ElectronTokenValidator)) rebind(ElectronTokenValidator).to(CliTokenValidator).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler<CliBridgeClient>(CLI_BRIDGE_PATH, client => {
        const windows = ctx.container.get(CliWindows);
        windows.add(client);
        client.onDidCloseConnection?.(() => windows.remove(client));
        const server: CliBridgeServer = { hello: async () => undefined, setClient: () => undefined, dispose: () => windows.remove(client) };
        return server;
    })).inSingletonScope();
});
