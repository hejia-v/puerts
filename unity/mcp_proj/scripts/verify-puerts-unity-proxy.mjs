import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const proxyScriptPath = path.join(__dirname, 'puerts-unity-proxy.mjs');

const defaultProjectRoot = process.env.PUERTS_UNITY_TEST_PROJECT ?? 'C:/Dev/BlockLoopShooter';
const defaultNodePath = process.env.PUERTS_UNITY_PROXY_NODE ?? process.execPath;
const defaultBaseUrl = process.env.PUERTS_UNITY_BASE_URL ?? 'http://127.0.0.1:3100/mcp';
const defaultWaitReadyTimeoutMs = parseInt(process.env.PUERTS_UNITY_VERIFY_WAIT_TIMEOUT_MS ?? '60000', 10);
const defaultWaitReadyPollMs = parseInt(process.env.PUERTS_UNITY_VERIFY_WAIT_POLL_MS ?? '250', 10);
const defaultDomainReloadSettledMs = parseInt(process.env.PUERTS_UNITY_VERIFY_SETTLED_MS ?? '8000', 10);

function parseArgs(argv) {
    const options = {
        projectRoot: defaultProjectRoot,
        nodePath: defaultNodePath,
        baseUrl: defaultBaseUrl,
        waitTimeoutMs: defaultWaitReadyTimeoutMs,
        waitPollMs: defaultWaitReadyPollMs,
        settledMs: defaultDomainReloadSettledMs,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const nextValue = argv[index + 1];

        switch (token) {
            case '--project':
                if (!nextValue) {
                    throw new Error('--project requires a value');
                }
                options.projectRoot = nextValue;
                index += 1;
                break;
            case '--node':
                if (!nextValue) {
                    throw new Error('--node requires a value');
                }
                options.nodePath = nextValue;
                index += 1;
                break;
            case '--base-url':
                if (!nextValue) {
                    throw new Error('--base-url requires a value');
                }
                options.baseUrl = nextValue;
                index += 1;
                break;
            case '--wait-timeout-ms':
                if (!nextValue) {
                    throw new Error('--wait-timeout-ms requires a value');
                }
                options.waitTimeoutMs = parseInt(nextValue, 10);
                index += 1;
                break;
            case '--wait-poll-ms':
                if (!nextValue) {
                    throw new Error('--wait-poll-ms requires a value');
                }
                options.waitPollMs = parseInt(nextValue, 10);
                index += 1;
                break;
            case '--settled-ms':
                if (!nextValue) {
                    throw new Error('--settled-ms requires a value');
                }
                options.settledMs = parseInt(nextValue, 10);
                index += 1;
                break;
            default:
                throw new Error(`Unknown argument: ${token}`);
        }
    }

    if (!Number.isFinite(options.waitTimeoutMs) || options.waitTimeoutMs <= 0) {
        throw new Error('wait timeout must be a positive integer');
    }

    if (!Number.isFinite(options.waitPollMs) || options.waitPollMs <= 0) {
        throw new Error('wait poll must be a positive integer');
    }

    if (!Number.isFinite(options.settledMs) || options.settledMs < 0) {
        throw new Error('settled delay must be zero or a positive integer');
    }

    return options;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCompanionUrl(baseUrl, pathSuffix) {
    const url = new URL(baseUrl);
    if (url.pathname.endsWith('/mcp')) {
        url.pathname = `${url.pathname.slice(0, -4)}${pathSuffix}`;
    } else {
        url.pathname = pathSuffix;
    }
    return url;
}

async function readJson(url, init) {
    const response = await fetch(url, init);
    const payload = await response.json();

    if (!response.ok) {
        throw new Error(`${init?.method ?? 'GET'} ${url} failed with ${response.status}: ${JSON.stringify(payload)}`);
    }

    return payload;
}

function isRecoverableFetchError(error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes('fetch failed')
        || message.includes('econnreset')
        || message.includes('econnrefused')
        || message.includes('socket hang up')
        || message.includes('unexpected end of json input');
}

async function readJsonWithRetry(url, init, retries = 5, delayMs = 500) {
    let lastError;

    for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
            return await readJson(url, init);
        } catch (error) {
            if (!isRecoverableFetchError(error) || attempt >= retries - 1) {
                throw error;
            }

            lastError = error;
            await sleep(delayMs);
        }
    }

    throw lastError ?? new Error(`Request failed: ${url}`);
}

async function health(baseUrl) {
    return readJsonWithRetry(buildCompanionUrl(baseUrl, '/health'), {
        method: 'GET',
        headers: {
            Accept: 'application/json',
        },
    });
}

async function waitReady(baseUrl, timeoutMs, pollMs) {
    const url = buildCompanionUrl(baseUrl, '/debug/wait-ready');
    url.searchParams.set('timeoutMs', String(timeoutMs));
    url.searchParams.set('pollMs', String(pollMs));
    const deadline = Date.now() + timeoutMs + 5000;
    let lastError;

    while (Date.now() < deadline) {
        try {
            return await readJson(url, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                },
            });
        } catch (error) {
            if (!isRecoverableFetchError(error)) {
                throw error;
            }

            lastError = error;
            await sleep(Math.min(Math.max(pollMs, 100), 1000));
        }
    }

    throw new Error(
        `Unity MCP companion did not become reachable/ready at ${url}. ` +
        `Make sure PuertsEditorAssistant/MCP Server is started in Unity. ` +
        `Last error: ${lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown')}`
    );
}

function normalizeToolText(result) {
    if (!result?.content || !Array.isArray(result.content)) {
        return '';
    }

    return result.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
}

async function callToolJson(client, name, args) {
    return JSON.parse(normalizeToolText(await client.callTool({
        name,
        arguments: args,
    })));
}

async function callEval(client, code, timeout = 30) {
    return client.callTool({
        name: 'evalJsCode',
        arguments: {
            code: `async function execute() { ${code} }`,
            timeout,
        },
    });
}

function buildSmokeScript(marker) {
    return `using UnityEditor;

namespace BlockLoopShooter.Editor
{
    internal static class CodexProxyReloadSmoke
    {
        private const string Marker = "${marker}";

        [InitializeOnLoadMethod]
        private static void Touch()
        {
            SessionState.SetString("CodexProxyReloadSmoke", Marker);
        }
    }
}
`;
}

function createProxyTransport(options) {
    const transport = new StdioClientTransport({
        command: options.nodePath,
        args: [proxyScriptPath],
        cwd: path.dirname(proxyScriptPath),
        env: {
            ...process.env,
            PUERTS_UNITY_BASE_URL: options.baseUrl,
        },
        stderr: 'pipe',
    });

    if (transport.stderr) {
        transport.stderr.on('data', (chunk) => {
            process.stderr.write(`[proxy-stderr] ${chunk}`);
        });
    }

    return transport;
}

async function connectProxyClient(options, name) {
    const transport = createProxyTransport(options);
    const client = new Client({
        name,
        version: '1.0.0',
    });
    await client.connect(transport);
    return client;
}

async function ensureProject(projectRoot) {
    const assetsGamePath = path.join(projectRoot, 'Assets', 'Game');
    const stat = await fs.stat(assetsGamePath).catch(() => null);
    if (!stat?.isDirectory()) {
        throw new Error(`Unity project path is invalid: ${projectRoot}`);
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    await ensureProject(options.projectRoot);

    const smokeFilePath = path.join(options.projectRoot, 'Assets', 'Game', 'Editor', '__CodexProxyReloadSmoke.cs');
    const marker = `codex-proxy-reload-smoke-${Date.now()}`;

    const report = {
        projectRoot: options.projectRoot,
        smokeFilePath,
        marker,
        baseUrl: options.baseUrl,
    };
    let client;

    try {
        report.waitReadyBeforeStart = await waitReady(options.baseUrl, options.waitTimeoutMs, options.waitPollMs);
        report.healthBefore = await health(options.baseUrl);
        client = await connectProxyClient(options, 'puerts-unity-proxy-verify');
        report.tools = await client.listTools();
        report.builtinSearch = await callToolJson(client, 'searchBuiltins', {
            query: 'log',
            limit: 3,
        });
        report.builtinRunBeforeReload = await callToolJson(client, 'runBuiltin', {
            name: 'unity-log.getUnityLogSummary',
        });

        report.firstCall = JSON.parse(normalizeToolText(await callEval(client, `
            return {
                marker: CS.UnityEditor.SessionState.GetString('CodexProxyReloadSmoke', 'missing'),
                scene: CS.UnityEditor.SceneManagement.EditorSceneManager.GetActiveScene().path,
                isCompiling: CS.UnityEditor.EditorApplication.isCompiling,
                isUpdating: CS.UnityEditor.EditorApplication.isUpdating,
            };
        `)));

        await fs.mkdir(path.dirname(smokeFilePath), { recursive: true });
        await fs.writeFile(smokeFilePath, buildSmokeScript(marker), 'utf8');
        report.wroteSmokeFile = true;

        report.refreshCall = normalizeToolText(await callEval(client, `
            CS.UnityEditor.AssetDatabase.Refresh();
            return 'refresh-triggered';
        `, 120));

        if (options.settledMs > 0) {
            await sleep(options.settledMs);
        }

        report.waitReadyAfterReload = await waitReady(options.baseUrl, options.waitTimeoutMs, options.waitPollMs);
        report.healthAfterReload = await health(options.baseUrl);

        report.secondCall = JSON.parse(normalizeToolText(await callEval(client, `
            return {
                marker: CS.UnityEditor.SessionState.GetString('CodexProxyReloadSmoke', 'missing'),
                scene: CS.UnityEditor.SceneManagement.EditorSceneManager.GetActiveScene().path,
                isCompiling: CS.UnityEditor.EditorApplication.isCompiling,
                isUpdating: CS.UnityEditor.EditorApplication.isUpdating,
            };
        `, 120)));
        report.builtinRunAfterReload = await callToolJson(client, 'runBuiltin', {
            name: 'unity-log.getUnityLogSummary',
        });

        if (report.secondCall.marker !== marker) {
            throw new Error(`Domain reload verification failed: expected marker ${marker}, got ${report.secondCall.marker}`);
        }

        report.status = 'ok';
        console.log(JSON.stringify(report, null, 2));
    } finally {
        if (await fs.stat(smokeFilePath).catch(() => null)) {
            try {
                await fs.unlink(smokeFilePath);
                report.cleanedSmokeFile = true;
                console.error(`[verify-puerts-unity-proxy] cleaned ${smokeFilePath}`);
                await sleep(500);
                report.waitReadyAfterCleanup = await waitReady(options.baseUrl, options.waitTimeoutMs, options.waitPollMs);
            } catch (cleanupError) {
                console.error(`[verify-puerts-unity-proxy] cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
            }
        }

        if (client) {
            try {
                await client.close();
            } catch {
                // Ignore shutdown errors after the test result has been captured.
            }
        }
    }
}

main().catch((error) => {
    const payload = {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
    };

    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
});
