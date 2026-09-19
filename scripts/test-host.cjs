const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const net = require('node:net');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');

async function verifyPreferenceRestart(executablePath, root, workspace, temporary) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VSCODE_IPC_HOOK_CLI;
    for (const phase of ['set', 'verify']) {
        const app = await electron.launch({ executablePath, env, args: [workspace,
            `--extensionDevelopmentPath=${root}`, '--disable-extensions', '--disable-workspace-trust',
            '--skip-welcome', '--skip-release-notes', '--disable-updates',
            `--user-data-dir=${path.join(temporary, 'normal-profile')}`,
            `--extensions-dir=${path.join(temporary, 'normal-extensions')}`] });
        try {
            const page = await app.firstWindow();
            const command = async title => {
                await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
                await page.locator('.quick-input-widget input').fill(`>${title}`);
                await page.getByRole('option').filter({ hasText: title }).first().click();
            };
            await page.getByText('Agent Read Coverage', { exact: true }).waitFor();
            const header = page.locator('.pane-header').filter({ hasText: 'Agent Read Coverage' }).first();
            if (await header.getAttribute('aria-expanded') !== 'true') { await header.click(); }
            const frameName = await page.locator('iframe.webview').getAttribute('name');
            assert.ok(frameName);
            const coverage = page.frameLocator(`iframe[name="${frameName}"]`).frameLocator('#active-frame').locator('#coverage-count');
            await coverage.filter({ hasText: phase === 'set' ? 'Colors on' : 'Colors off' }).waitFor();
            if (phase === 'set') {
                await command('Agent Context Trace: Toggle Read Colors');
                await coverage.filter({ hasText: 'Colors off' }).waitFor();
            }
            assert.match(await coverage.textContent(), /Colors off/);
        } finally { await app.close(); }
    }
    console.log('PASS: file-color preference persisted across two normal VS Code process launches');
}

async function main() {
    const root = path.resolve(__dirname, '..');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'act-host-'));
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    try {
        const folders = [path.join(temporary, 'repo-one'), path.join(temporary, 'repo-two')];
        for (const folder of folders) {
            await fs.mkdir(folder);
            await fs.writeFile(path.join(folder, 'source.ts'), 'first\nsecond\nthird\nfourth\n');
            await fs.writeFile(path.join(folder, 'neutral.ts'), 'not recorded\n');
            await fs.writeFile(path.join(folder, '.env'), 'SYNTHETIC_SECRET_MARKER');
        }
        const workspace = path.join(temporary, 'fixture.code-workspace');
        await fs.writeFile(workspace, JSON.stringify({ folders: folders.map(folder => ({ path: folder })) }));
        const screenshots = path.join(root, '.vscode-test', 'screenshots');
        await fs.mkdir(screenshots, { recursive: true });
        const quotedPath = value => process.platform === 'win32' ? `"${value}"` : value;
        const executablePath = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode('1.100.0');
        for (const phase of ['capture', 'restore']) {
            await runTests({
            vscodeExecutablePath: executablePath,
                extensionDevelopmentPath: quotedPath(root),
                extensionTestsPath: quotedPath(path.join(root, 'out', 'test', 'extension.test.js')),
                reuseMachineInstall: true,
                extensionTestsEnv: { ACT_TEST_PHASE: phase, ACT_CDP_PORT: String(port), ACT_SCREENSHOTS: screenshots },
                launchArgs: [quotedPath(workspace), '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
                    '--user-data-dir', quotedPath(path.join(temporary, 'profile')), '--extensions-dir', quotedPath(path.join(temporary, 'extensions')),
                    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1']
            });
        }
        await verifyPreferenceRestart(executablePath, root, workspace, temporary);
    } finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });