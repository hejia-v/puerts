import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const baseUrl = new URL(process.env.PUERTS_UNITY_BASE_URL ?? 'http://127.0.0.1:3100/mcp');
const waitReadyTimeoutMs = parseInt(process.env.PUERTS_UNITY_WAIT_READY_TIMEOUT_MS ?? '15000', 10);
const waitReadyPollMs = parseInt(process.env.PUERTS_UNITY_WAIT_READY_POLL_MS ?? '250', 10);

function buildCompanionUrl(pathSuffix) {
    const url = new URL(baseUrl);
    if (url.pathname.endsWith('/mcp')) {
        url.pathname = `${url.pathname.slice(0, -4)}${pathSuffix}`;
    } else {
        url.pathname = pathSuffix;
    }
    return url;
}

function toErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function extractResultText(result) {
    if (!result?.content || !Array.isArray(result.content)) {
        return '';
    }

    return result.content
        .filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n');
}

class UnityUpstreamClient {
    constructor() {
        this.client = undefined;
        this.transport = undefined;
        this.connectPromise = undefined;
    }

    async disconnect() {
        const client = this.client;
        this.client = undefined;
        this.transport = undefined;

        if (client) {
            try {
                await client.close();
            } catch {
                // Ignore shutdown errors during recovery.
            }
        }
    }

    async connectFresh() {
        await this.disconnect();

        const client = new Client({
            name: 'puerts-unity-proxy-upstream',
            version: '1.0.0',
        });

        const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
            reconnectionOptions: {
                maxRetries: 0,
                initialReconnectionDelay: 250,
                maxReconnectionDelay: 1000,
                reconnectionDelayGrowFactor: 1.5,
            },
        });

        transport.onclose = () => {
            if (this.transport === transport) {
                this.client = undefined;
                this.transport = undefined;
            }
        };

        transport.onerror = (error) => {
            console.error(`[puerts-unity-proxy] upstream transport error: ${toErrorMessage(error)}`);
        };

        await client.connect(transport);
        this.client = client;
        this.transport = transport;
        return client;
    }

    async waitUntilReady(reason) {
        const waitReadyUrl = buildCompanionUrl('/debug/wait-ready');
        waitReadyUrl.searchParams.set('timeoutMs', String(waitReadyTimeoutMs));
        waitReadyUrl.searchParams.set('pollMs', String(waitReadyPollMs));

        const response = await fetch(waitReadyUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`wait-ready failed (${response.status}) while recovering from ${reason}`);
        }

        const payload = await response.json();
        if (!payload.ready) {
            throw new Error(`Unity MCP did not become ready within ${waitReadyTimeoutMs}ms while recovering from ${reason}`);
        }

        return payload;
    }

    async resetUpstreamSessions(reason) {
        const resetUrl = buildCompanionUrl('/debug/reset');
        const response = await fetch(resetUrl, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`reset failed (${response.status}) while recovering from ${reason}`);
        }

        return await response.json();
    }

    async ensureConnected() {
        if (this.client) {
            return this.client;
        }

        if (this.connectPromise) {
            return this.connectPromise;
        }

        this.connectPromise = (async () => {
            try {
                return await this.connectFresh();
            } catch (error) {
                await this.waitUntilReady(`initial connect: ${toErrorMessage(error)}`);
                return await this.connectFresh();
            } finally {
                this.connectPromise = undefined;
            }
        })();

        return this.connectPromise;
    }

    isRecoverableError(error) {
        const message = toErrorMessage(error).toLowerCase();
        return message.includes('session not found')
            || message.includes('server not initialized')
            || message.includes('server is starting')
            || message.includes('econnreset')
            || message.includes('econnrefused')
            || message.includes('fetch failed')
            || message.includes('socket hang up')
            || message.includes('transport')
            || message.includes('not connected');
    }

    isRecoverableToolResult(result) {
        if (!result?.isError) {
            return false;
        }

        const message = extractResultText(result).toLowerCase();
        return this.isRecoverableError(message);
    }

    async callTool(name, args) {
        let lastError = null;

        for (let attempt = 0; attempt < 3; attempt += 1) {
            let client;

            if (attempt === 0) {
                client = await this.ensureConnected();
            } else {
                await this.resetUpstreamSessions(`tool call recovery for ${name}, attempt ${attempt}`);
                await this.waitUntilReady(`tool call recovery for ${name}, attempt ${attempt}`);
                client = await this.connectFresh();
                await client.ping();
            }

            try {
                const result = await client.callTool({
                    name,
                    arguments: args,
                });

                if (!this.isRecoverableToolResult(result)) {
                    return result;
                }

                lastError = new Error(extractResultText(result) || `recoverable tool error on attempt ${attempt + 1}`);
                console.error(`[puerts-unity-proxy] recoverable upstream tool result: ${extractResultText(result)}`);
            } catch (error) {
                if (!this.isRecoverableError(error)) {
                    throw error;
                }

                lastError = error instanceof Error ? error : new Error(toErrorMessage(error));
                console.error(`[puerts-unity-proxy] recoverable upstream error: ${toErrorMessage(error)}`);
            }

            if (attempt >= 2) {
                break;
            }
        }

        if (lastError) {
            throw lastError;
        }

        throw new Error(`Failed to call tool ${name}`);
    }
}

const upstream = new UnityUpstreamClient();

const server = new McpServer({
    name: 'puerts-unity-proxy',
    version: '1.0.0',
});

server.tool(
    'evalJsCode',
    'Forward `evalJsCode` to the Unity Editor PuerTS MCP endpoint. ' +
    'This proxy keeps a local stdio MCP session for Codex and automatically waits for Unity domain reload recovery, ' +
    'reinitializes the upstream MCP session, and retries one recoverable call when the Unity-side connection was invalidated.',
    {
        code: z.string().describe(
            'An async function declaration named `execute`. Example: "async function execute() { return CS.UnityEditor.EditorApplication.isCompiling; }"'
        ),
        timeout: z.number().optional().default(30).describe(
            'Execution timeout in seconds. Default is 30s.'
        ),
    },
    async ({ code, timeout }) => {
        return await upstream.callTool('evalJsCode', {
            code,
            timeout,
        });
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

async function shutdown() {
    await upstream.disconnect();
    await server.close();
}

process.on('SIGINT', async () => {
    await shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
});

main().catch((error) => {
    console.error(`[puerts-unity-proxy] fatal error: ${toErrorMessage(error)}`);
    process.exit(1);
});
