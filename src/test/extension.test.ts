import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as proxyquireLib from 'proxyquire';
import { createMockContext } from './testUtils';

const proxyquire = proxyquireLib.noPreserveCache().noCallThru();

suite('Extension Test Suite', () => {
    let mockMCPServer: any;
    let MockServerConstructor: sinon.SinonStub;
    let extension: any;
    let workspaceConfig: any;
    let statusBarItem: any;
    let context: any;
    let getConfigurationStub: sinon.SinonStub;
    let createStatusBarItemStub: sinon.SinonStub;
    let registerCommandStub: sinon.SinonStub;
    let onDidChangeConfigurationStub: sinon.SinonStub;

    setup(() => {

        mockMCPServer = {
            start: sinon.stub().resolves(),
            stop: sinon.stub().resolves(),
            setFileListingCallback: sinon.spy()
        };

        MockServerConstructor = sinon.stub().returns(mockMCPServer);

        extension = proxyquire('../extension', {
            './server': { MCPServer: MockServerConstructor }
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
            get: sinon.stub().withArgs('port').returns(4321)
        };
        getConfigurationStub = sinon.stub(vscode.workspace, 'getConfiguration').returns(workspaceConfig);

        context = createMockContext();

        registerCommandStub = sinon.stub(vscode.commands, 'registerCommand').returns({
            dispose: sinon.spy()
        });

        onDidChangeConfigurationStub = sinon.stub(vscode.workspace, 'onDidChangeConfiguration').returns({
            dispose: sinon.spy()
        });
    });

    teardown(() => {

        sinon.restore();
    });

    test('Extension should read port from configuration', async () => {

        await extension.activate(context);

        assert.strictEqual(getConfigurationStub.called, true, 'Configuration not accessed');
        assert.strictEqual(workspaceConfig.get.calledWith('port'), true, 'Port not read from configuration');

        assert.strictEqual(MockServerConstructor.calledWith(4321), true, 'MCPServer not created with configured port');
    });

    test('Status bar item should be created with proper attributes', async () => {

        await extension.activate(context);

        assert.strictEqual(createStatusBarItemStub.called, true, 'Status bar item not created');

        assert.strictEqual(statusBarItem.command, 'vscode-mcp-server.showServerInfo', 'Status bar command not set correctly');
        assert.strictEqual(statusBarItem.show.called, true, 'Status bar not shown');

        assert.strictEqual(statusBarItem.text.includes('4321'), true, 'Status bar does not show configured port');
    });

    test('Server info command should be registered', async () => {

        await extension.activate(context);

        const showServerInfoCall = registerCommandStub.getCalls().find(
            call => call.args[0] === 'vscode-mcp-server.showServerInfo'
        );
        assert.strictEqual(showServerInfoCall !== undefined, true, 'Server info command not registered');
    });

    test('Configuration change listener should be registered', async () => {

        await extension.activate(context);

        assert.strictEqual(onDidChangeConfigurationStub.called, true, 'Configuration change listener not registered');
    });

    test('Deactivate should clean up resources', async () => {

        await extension.activate(context);

        await extension.deactivate();

        assert.strictEqual(statusBarItem.dispose.called, true, 'Status bar not disposed during deactivation');

        assert.strictEqual(mockMCPServer.stop.called, true, 'Server not stopped during deactivation');
    });
});