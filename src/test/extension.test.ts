import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as proxyquireLib from 'proxyquire';
import { createMockContext } from './testUtils';

const proxyquire = proxyquireLib.noPreserveCache().noCallThru();

function makeMockServer() {
    return {
        start: sinon.stub().resolves(),
        stop: sinon.stub().resolves(),
        setupTools: sinon.spy(),
        setFileListingCallback: sinon.spy(),
        attachDashboard: sinon.spy(),
        cluster: {
            getRole: sinon.stub().returns('standalone'),
            setOnStateChange: sinon.spy(),
            folderSetChanged: sinon.stub().resolves()
        }
    };
}

suite('Extension Test Suite', () => {
    let mockMCPServer: ReturnType<typeof makeMockServer>;
    let MockServerConstructor: sinon.SinonStub;
    let extension: any;
    let workspaceConfig: any;
    let statusBarItem: any;
    let context: any;
    let getConfigurationStub: sinon.SinonStub;
    let createStatusBarItemStub: sinon.SinonStub;
    let registerCommandStub: sinon.SinonStub;
    let onDidChangeConfigurationStub: sinon.SinonStub;
    let configListener: ((event: any) => Promise<void>) | undefined;
    let serverEnabled: boolean;

    setup(() => {

        serverEnabled = false;

        mockMCPServer = makeMockServer();
        MockServerConstructor = sinon.stub().returns(mockMCPServer);

        extension = proxyquire('../extension', {
            './server': { MCPServer: MockServerConstructor, refreshApiKeyCache: async () => undefined }
        });

        statusBarItem = {
            text: '',
            tooltip: '',
            command: '',
            show: sinon.spy(),
            dispose: sinon.spy()
        };

        createStatusBarItemStub = sinon.stub(vscode.window, 'createStatusBarItem').returns(statusBarItem);

        workspaceConfig = {
            get: sinon.stub().callsFake((key: string) => {
                if (key === 'port') { return 4321; }
                if (key === 'defaultEnabled') { return serverEnabled; }
                return undefined;
            })
        };
        getConfigurationStub = sinon.stub(vscode.workspace, 'getConfiguration').returns(workspaceConfig);

        context = createMockContext();

        registerCommandStub = sinon.stub(vscode.commands, 'registerCommand').returns({
            dispose: sinon.spy()
        });

        onDidChangeConfigurationStub = sinon.stub(vscode.workspace, 'onDidChangeConfiguration').callsFake((handler: any) => {
            configListener = handler;
            return { dispose: sinon.spy() };
        });

        sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
        sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    });

    teardown(() => {

        sinon.restore();
        configListener = undefined;
    });

    function enableServer() {
        serverEnabled = true;
        context.globalState.get = ((key: string) => key === 'mcpServerEnabled' ? true : undefined) as any;
    }

    function configEvent(key: string) {
        return { affectsConfiguration: (candidate: string) => candidate === key };
    }

    function commandNames(): string[] {
        return registerCommandStub.getCalls().map(call => call.args[0] as string);
    }

    test('Extension should read port from configuration', async () => {

        enableServer();
        await extension.activate(context);

        assert.strictEqual(getConfigurationStub.called, true, 'Configuration not accessed');
        assert.strictEqual(workspaceConfig.get.calledWith('port'), true, 'Port not read from configuration');

        assert.strictEqual(MockServerConstructor.calledWith(4321), true, 'MCPServer not created with configured port');
    });

    test('Status bar item should be created with proper attributes', async () => {

        enableServer();
        await extension.activate(context);

        assert.strictEqual(createStatusBarItemStub.called, true, 'Status bar item not created');

        assert.strictEqual(statusBarItem.command, 'vscode-mcp-server.toggleServer', 'Status bar command not set correctly');
        assert.strictEqual(statusBarItem.show.called, true, 'Status bar not shown');

        assert.strictEqual(statusBarItem.text.includes('4321'), true, 'Status bar does not show configured port');
    });

    test('Server info command should be registered', async () => {

        await extension.activate(context);

        assert.ok(commandNames().includes('vscode-mcp-server.showServerInfo'), 'Server info command not registered');
    });

    test('Configuration change listener should be registered', async () => {

        await extension.activate(context);

        assert.strictEqual(onDidChangeConfigurationStub.called, true, 'Configuration change listener not registered');
    });

    test('loading the module registers no command', () => {

        assert.deepStrictEqual(commandNames(), [], 'commands registered at import time, outside the activation lifecycle');
    });

    test('api key commands are registered during activation', async () => {

        await extension.activate(context);

        assert.ok(commandNames().includes('vscode-mcp-server.copyApiKey'), 'copyApiKey not registered');
        assert.ok(commandNames().includes('vscode-mcp-server.generateApiKey'), 'generateApiKey not registered');
    });

    test('activating twice registers the commands again without throwing', async () => {

        await extension.activate(context);
        const afterFirst = registerCommandStub.callCount;

        await extension.activate(context);

        assert.strictEqual(registerCommandStub.callCount, afterFirst * 2, 'second activation did not register its commands');
        for (const name of ['vscode-mcp-server.copyApiKey', 'vscode-mcp-server.generateApiKey']) {
            const count = registerCommandStub.getCalls().filter(call => call.args[0] === name).length;
            assert.strictEqual(count, 2, `${name} registered ${count} times across two activations`);
        }
    });

    test('concurrent configuration changes restart the server once', async () => {

        enableServer();
        await extension.activate(context);
        assert.strictEqual(MockServerConstructor.callCount, 1, 'server not started by activation');

        assert.ok(configListener, 'configuration listener was not captured');
        await Promise.all([
            configListener!(configEvent('vscode-mcp-server.port')),
            configListener!(configEvent('vscode-mcp-server.enabledTools'))
        ]);

        assert.strictEqual(MockServerConstructor.callCount, 2, `expected exactly one restart, got ${MockServerConstructor.callCount - 1}`);
    });

    test('a restart superseded while stopping leaves a single server', async () => {

        enableServer();
        await extension.activate(context);

        MockServerConstructor.onSecondCall().returns(makeMockServer());

        assert.ok(configListener, 'configuration listener was not captured');

        await Promise.all([
            configListener!(configEvent('vscode-mcp-server.port')),
            configListener!(configEvent('vscode-mcp-server.host'))
        ]);

        assert.strictEqual(MockServerConstructor.callCount, 2, `expected exactly one restart, got ${MockServerConstructor.callCount - 1}`);
    });

    test('Deactivate should clean up resources', async () => {

        enableServer();
        await extension.activate(context);

        await extension.deactivate();

        assert.strictEqual(statusBarItem.dispose.called, true, 'Status bar not disposed during deactivation');

        assert.strictEqual(mockMCPServer.stop.called, true, 'Server not stopped during deactivation');
    });
});