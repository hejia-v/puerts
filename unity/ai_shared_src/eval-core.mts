/**
 * Eval Core - shared execution logic for evalJsCode and builtin dispatch.
 *
 * This module contains the SDK-agnostic core: Eval VM management,
 * builtins initialisation, builtin discovery/invocation, and code execution.
 * Both agent_proj (AI SDK) and mcp_proj (MCP SDK) import from here.
 */
import { getResourceRoot } from './resource-root.mjs';

// ---------------------------------------------------------------------------
// Eval VM & Builtins state (lazily initialised via initBuiltins)
// ---------------------------------------------------------------------------

/** The eval VM instance. Created once in initBuiltins(). */
let jsEnv: CS.Puerts.ScriptEnv | null = null;

/** Short routing text injected into tool descriptions. */
export let builtinSummariesText: string = '';

export interface BuiltinFunctionInfo {
    id: string;
    moduleName: string;
    exportName: string;
    signature: string;
    summary: string;
    tags: string[];
    searchText: string;
}

export interface BuiltinModuleInfo {
    moduleName: string;
    specifier: string;
    summary: string;
    description: string;
    tags: string[];
    functions: BuiltinFunctionInfo[];
}

export interface BuiltinSearchResult {
    name: string;
    moduleName: string;
    exportName: string;
    signature: string;
    summary: string;
    tags: string[];
}

let builtinModules: BuiltinModuleInfo[] = [];
let builtinFunctions: BuiltinFunctionInfo[] = [];
let builtinFunctionMap = new Map<string, BuiltinFunctionInfo>();
let builtinModuleMap = new Map<string, BuiltinModuleInfo>();

/**
 * Get or create the eval VM.
 * On first creation, starts a periodic Tick from the main VM to drive
 * the eval VM's timer queue (setTimeout / setInterval).
 */
export function getJsEnv(): CS.Puerts.ScriptEnv {
    if (!jsEnv) {
        jsEnv = CS.LLMAgent.ScriptEnvBridge.CreateJavaScriptEnv();

        // Drive the eval VM's timer queue from the main VM.
        // The main VM's setInterval is powered by EditorApplication.update,
        // so this keeps the eval VM's setTimeout/setInterval working.
        const envRef = jsEnv;
        setInterval(() => {
            try {
                CS.LLMAgent.ScriptEnvBridge.Tick(envRef);
            } catch (_) {
                // Ignore tick errors to avoid crashing the main VM loop.
            }
        }, 20); // ~50 ticks/sec, enough for responsive timers
    }
    return jsEnv;
}

function splitSearchTokens(value: string): string[] {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function uniqueTokens(values: string[]): string[] {
    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const value of values) {
        if (!seen.has(value)) {
            seen.add(value);
            tokens.push(value);
        }
    }
    return tokens;
}

function buildTags(...values: string[]): string[] {
    return uniqueTokens(values.flatMap(splitSearchTokens));
}

function normalizeText(value: string): string {
    return value.trim().toLowerCase();
}

function normalizeCompact(value: string): string {
    return normalizeText(value).replace(/[^a-z0-9]+/g, '');
}

function extractFunctionDocs(description: string): Map<string, { signature: string; summary: string }> {
    const docs = new Map<string, { signature: string; summary: string }>();
    const lines = description.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('- **`')) {
            continue;
        }

        const tickStart = line.indexOf('`');
        const tickEnd = line.indexOf('`', tickStart + 1);
        if (tickStart === -1 || tickEnd === -1) {
            continue;
        }

        const signature = line.slice(tickStart + 1, tickEnd).trim();
        const exportName = signature.split('(')[0].trim();
        if (!exportName) {
            continue;
        }

        const summary = line
            .slice(tickEnd + 4)
            .replace(/^[^A-Za-z0-9]+/, '')
            .trim();

        docs.set(exportName, {
            signature,
            summary,
        });
    }
    return docs;
}

function rebuildBuiltinIndexes(): void {
    builtinModules = [...builtinModules].sort((a, b) => a.moduleName.localeCompare(b.moduleName));
    builtinFunctions = builtinModules.flatMap(moduleInfo => moduleInfo.functions)
        .sort((a, b) => a.id.localeCompare(b.id));

    builtinFunctionMap = new Map(builtinFunctions.map(info => [info.id, info]));
    builtinModuleMap = new Map(builtinModules.map(info => [info.moduleName, info]));
}

function buildBuiltinPromptText(root: string, modules: BuiltinModuleInfo[]): string {
    if (modules.length === 0) {
        return '';
    }

    const moduleNames = modules.map(moduleInfo => `\`${moduleInfo.moduleName}\``).join(', ');
    return (
        '\n\n### Builtins\n\n' +
        `Preloaded helper modules are available under \`${root}/builtins/*.mjs\`.\n\n` +
        'Prefer `runBuiltin` for known helper calls and `searchBuiltins` when you need to discover the right helper first. ' +
        'Use `evalJsCode` as the fallback for custom or multi-step logic that is not covered by a builtin.\n\n' +
        `Builtin modules currently loaded: ${moduleNames}`
    );
}

function toSearchResult(info: BuiltinFunctionInfo): BuiltinSearchResult {
    return {
        name: info.id,
        moduleName: info.moduleName,
        exportName: info.exportName,
        signature: info.signature,
        summary: info.summary,
        tags: [...info.tags],
    };
}

function scoreBuiltin(info: BuiltinFunctionInfo, query: string, queryCompact: string): number {
    if (!query) {
        return 1;
    }

    const idLower = normalizeText(info.id);
    const exportLower = normalizeText(info.exportName);
    const moduleLower = normalizeText(info.moduleName);
    const signatureLower = normalizeText(info.signature);
    const searchText = info.searchText;
    let score = 0;

    if (normalizeCompact(info.id) === queryCompact) score += 200;
    if (normalizeCompact(info.exportName) === queryCompact) score += 180;
    if (normalizeCompact(info.moduleName) === queryCompact) score += 140;
    if (idLower === query) score += 120;
    if (exportLower === query) score += 100;
    if (moduleLower === query) score += 80;
    if (idLower.startsWith(query)) score += 50;
    if (exportLower.startsWith(query)) score += 40;
    if (moduleLower.startsWith(query)) score += 30;
    if (signatureLower.includes(query)) score += 20;
    if (searchText.includes(query)) score += 10;

    for (const token of splitSearchTokens(query)) {
        if (info.tags.includes(token)) score += 12;
        else if (searchText.includes(token)) score += 4;
    }

    return score;
}

function resolveBuiltin(name: string): { moduleName: string; exportName: string; info: BuiltinFunctionInfo } | null {
    const trimmed = name.trim();
    if (!trimmed) {
        return null;
    }

    const direct = builtinFunctionMap.get(trimmed);
    if (direct) {
        return {
            moduleName: direct.moduleName,
            exportName: direct.exportName,
            info: direct,
        };
    }

    const compactName = normalizeCompact(trimmed);
    const exactByExport = builtinFunctions.filter(info => normalizeCompact(info.exportName) === compactName);
    if (exactByExport.length === 1) {
        const info = exactByExport[0];
        return {
            moduleName: info.moduleName,
            exportName: info.exportName,
            info,
        };
    }

    const dotIndex = trimmed.lastIndexOf('.');
    if (dotIndex <= 0 || dotIndex >= trimmed.length - 1) {
        return null;
    }

    const moduleName = trimmed.slice(0, dotIndex);
    const exportName = trimmed.slice(dotIndex + 1);
    const moduleInfo = builtinModuleMap.get(moduleName);
    if (!moduleInfo) {
        return null;
    }

    const info = moduleInfo.functions.find(item => item.exportName === exportName);
    if (!info) {
        return null;
    }

    return {
        moduleName,
        exportName,
        info,
    };
}

function buildBuiltinRunnerCode(moduleName: string, exportName: string, args: unknown): string {
    const root = getResourceRoot();
    if (!root) {
        throw new Error('Resource root not set. Builtins are unavailable until initialization completes.');
    }

    const moduleSpecifier = `${root}/builtins/${moduleName}.mjs`;
    let serializedArgs: string;
    try {
        serializedArgs = JSON.stringify(args === undefined ? [] : (Array.isArray(args) ? args : [args]));
    } catch (error: any) {
        throw new Error(`runBuiltin args must be JSON-serializable: ${error?.message || String(error)}`);
    }

    return (
        'async function execute() {\n' +
        `    const moduleName = ${JSON.stringify(moduleName)};\n` +
        `    const exportName = ${JSON.stringify(exportName)};\n` +
        `    const mod = await import(${JSON.stringify(moduleSpecifier)});\n` +
        '    const fn = mod[exportName];\n' +
        "    if (typeof fn !== 'function') {\n" +
        "        throw new Error(`Builtin '${moduleName}.${exportName}' is not callable.`);\n" +
        '    }\n' +
        `    const args = ${serializedArgs};\n` +
        '    return await fn.apply(mod, args);\n' +
        '}\n'
    );
}

export function getBuiltinModules(): BuiltinModuleInfo[] {
    return builtinModules.map(moduleInfo => ({
        ...moduleInfo,
        tags: [...moduleInfo.tags],
        functions: moduleInfo.functions.map(fn => ({ ...fn, tags: [...fn.tags] })),
    }));
}

export function searchBuiltins(query: string = '', tags?: string[], limit: number = 8): BuiltinSearchResult[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 8;
    const normalizedQuery = normalizeText(query || '');
    const queryCompact = normalizeCompact(query || '');
    const requestedTags = uniqueTokens((tags ?? []).flatMap(splitSearchTokens));

    const matches = builtinFunctions
        .map(info => {
            const score = scoreBuiltin(info, normalizedQuery, queryCompact);
            const tagMatch = requestedTags.length === 0
                || requestedTags.every(tag => info.tags.includes(tag) || info.searchText.includes(tag));
            return { info, score, tagMatch };
        })
        .filter(entry => entry.tagMatch && (normalizedQuery === '' || entry.score > 0))
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.info.id.localeCompare(b.info.id);
        })
        .slice(0, safeLimit)
        .map(entry => toSearchResult(entry.info));

    return matches;
}

export async function runBuiltin(name: string, args?: unknown, timeoutSeconds: number = 30): Promise<EvalResult> {
    const target = resolveBuiltin(name);
    if (!target) {
        const suggestions = searchBuiltins(name, undefined, 5).map(item => item.name);
        const suffix = suggestions.length > 0
            ? ` Closest matches: ${suggestions.join(', ')}.`
            : '';
        return {
            success: false,
            error: `Builtin '${name}' was not found.${suffix}`,
        };
    }

    try {
        const code = buildBuiltinRunnerCode(target.moduleName, target.exportName, args);
        return await executeCode(code, timeoutSeconds);
    } catch (error: any) {
        return {
            success: false,
            error: error?.message || String(error),
            stack: error?.stack || '',
        };
    }
}

// ---------------------------------------------------------------------------
// Builtins initialisation via dynamic import()
// ---------------------------------------------------------------------------

/**
 * Initialise builtin helper modules by discovering `.mjs` assets under
 * `<resourceRoot>/builtins/` and dynamically importing each one in the
 * eval VM to extract summary + callable metadata.
 *
 * Dynamic import() supports top-level await inside the builtin modules.
 *
 * Must be called after setResourceRoot().
 * Returns a promise that resolves when all builtins have been loaded.
 */
export async function initBuiltins(): Promise<void> {
    builtinModules = [];
    builtinFunctions = [];
    builtinFunctionMap = new Map();
    builtinModuleMap = new Map();
    builtinSummariesText = '';

    const root = getResourceRoot();
    if (!root) {
        console.warn('[EvalCore] Resource root not set, skipping builtins loading.');
        return;
    }

    const env = getJsEnv();
    const builtinPath = `${root}/builtins`;
    const assets = CS.UnityEngine.Resources.LoadAll(builtinPath, puer.$typeof(CS.UnityEngine.TextAsset));
    if (!assets || assets.Length === 0) {
        console.log(`[EvalCore] No builtins assets found at Resources/${builtinPath}/`);
        return;
    }

    const modules: Array<{ moduleName: string; specifier: string }> = [];
    for (let i = 0; i < assets.Length; i++) {
        const asset = assets.get_Item(i) as CS.UnityEngine.TextAsset;
        modules.push({
            moduleName: asset.name,
            specifier: `${builtinPath}/${asset.name}.mjs`,
        });
    }

    const importEntries = modules.map((entry, index) => (
        `import(${JSON.stringify(entry.specifier)}).then(function(m) {\n` +
        '    return {\n' +
        `        index: ${index},\n` +
        `        moduleName: ${JSON.stringify(entry.moduleName)},\n` +
        `        specifier: ${JSON.stringify(entry.specifier)},\n` +
        "        summary: typeof m.summary === 'string' ? m.summary : '',\n" +
        "        description: typeof m.description === 'string' ? m.description : '',\n" +
        "        tags: Array.isArray(m.tags) ? m.tags.map(function(value) { return String(value); }) : [],\n" +
        "        functionNames: Object.keys(m).filter(function(key) { return typeof m[key] === 'function'; }),\n" +
        '        error: null\n' +
        '    };\n' +
        '}).catch(function(e) {\n' +
        '    return {\n' +
        `        index: ${index},\n` +
        `        moduleName: ${JSON.stringify(entry.moduleName)},\n` +
        `        specifier: ${JSON.stringify(entry.specifier)},\n` +
        "        summary: '',\n" +
        "        description: '',\n" +
        '        tags: [],\n' +
        '        functionNames: [],\n' +
        "        error: String(e.message || e)\n" +
        '    };\n' +
        '})'
    )).join(',\n        ');

    const batchScript = `(function(onFinish) {
    Promise.all([
        ${importEntries}
    ]).then(function(results) {
        onFinish.Invoke(JSON.stringify(results));
    });
})`;

    const results = await new Promise<Array<{
        index: number;
        moduleName: string;
        specifier: string;
        summary: string;
        description: string;
        tags: string[];
        functionNames: string[];
        error: string | null;
    }>>((resolve, reject) => {
        CS.LLMAgent.ScriptEnvBridge.Eval(env, batchScript, (resultJson: string) => {
            try {
                resolve(JSON.parse(resultJson));
            } catch (e) {
                reject(e);
            }
        });
    });

    const loadedModules: BuiltinModuleInfo[] = [];
    for (const entry of results) {
        if (entry.error) {
            console.warn(`[EvalCore] Failed to load builtins module '${entry.specifier}': ${entry.error}`);
            continue;
        }

        const functionDocs = extractFunctionDocs(entry.description);
        const moduleTags = uniqueTokens([
            ...buildTags(entry.moduleName, entry.summary, entry.description),
            ...(entry.tags ?? []).flatMap(splitSearchTokens),
        ]);

        const functions: BuiltinFunctionInfo[] = entry.functionNames.map(exportName => {
            const doc = functionDocs.get(exportName);
            const signature = doc?.signature || `${exportName}(...)`;
            const summary = doc?.summary || `Call ${entry.moduleName}.${exportName}.`;
            const tags = uniqueTokens([
                ...moduleTags,
                ...buildTags(exportName, signature, summary),
            ]);

            return {
                id: `${entry.moduleName}.${exportName}`,
                moduleName: entry.moduleName,
                exportName,
                signature,
                summary,
                tags,
                searchText: normalizeText(
                    `${entry.moduleName} ${exportName} ${signature} ${summary} ${entry.summary} ${entry.description} ${tags.join(' ')}`
                ),
            };
        });

        loadedModules.push({
            moduleName: entry.moduleName,
            specifier: entry.specifier,
            summary: entry.summary,
            description: entry.description,
            tags: moduleTags,
            functions,
        });

        console.log(`[EvalCore] Loaded builtins module '${entry.specifier}' with ${functions.length} function(s).`);
    }

    builtinModules = loadedModules;
    rebuildBuiltinIndexes();
    builtinSummariesText = buildBuiltinPromptText(root, builtinModules);
    console.log(`[EvalCore] Loaded ${builtinModules.length} builtins module(s), ${builtinFunctions.length} callable(s).`);
}

// ---------------------------------------------------------------------------
// Runner code
// ---------------------------------------------------------------------------

// Fixed runner code that calls the globally defined execute() function,
// handles async result and error reporting via onFinish callback.
// The raw return value of execute() is passed through as-is in the result
// field - any __image markers or serialization are handled downstream
// by toModelOutput in eval-tool.mts.
const RUNNER_CODE = `(function(onFinish) {
    execute().then(function(result) {
        onFinish.Invoke(JSON.stringify({ __error: false, result: result }));
    }).catch(function(err) {
        onFinish.Invoke(JSON.stringify({ __error: true, message: String(err.message || err), stack: String(err.stack || '') }));
    });
})`;

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

/**
 * Result type returned by executeCode.
 */
export interface EvalResult {
    success: boolean;
    result?: any;
    error?: string;
    stack?: string;
}

/**
 * Execute user-supplied JS code in the eval VM.
 *
 * The code must define an async function named `execute`.
 * This function defines `execute()` via EvalSync, then runs the
 * RUNNER_CODE which calls `execute()` and serialises the result.
 *
 * @param code - An async function declaration named `execute`.
 * @param timeoutSeconds - Optional execution timeout in seconds (default 30).
 *                         If the code does not finish within this time, a timeout
 *                         EvalResult is returned so the caller can decide to retry.
 * @returns EvalResult with success/error info and optional image data.
 */
export async function executeCode(code: string, timeoutSeconds: number = 30): Promise<EvalResult> {
    const env = getJsEnv();
    try {
        console.log(`[EvalCore] Executing code (timeout=${timeoutSeconds}s):\n${code}`);

        // Step 1: Define the execute() function via EvalSync.
        try {
            CS.LLMAgent.ScriptEnvBridge.EvalSync(env, code);
        } catch (defineError: any) {
            return {
                success: false,
                error: defineError.message || String(defineError),
                stack: defineError.stack || '',
            };
        }

        // Step 2: Run the fixed runner that calls execute() and
        // serialises the result / error back through onFinish.
        const executionPromise = new Promise<string>((resolve) => {
            CS.LLMAgent.ScriptEnvBridge.Eval(env, RUNNER_CODE, resolve);
        });

        // Step 3: Race execution against a timeout.
        const timeoutMs = timeoutSeconds * 1000;
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error(
                    `Execution timed out after ${timeoutSeconds}s. ` +
                    `The code may be stuck (e.g. waiting for a resource that never resolves). ` +
                    `You can retry with a longer timeout, simplify the code, or try a different approach.`
                ));
            }, timeoutMs);
        });

        const resultJson = await Promise.race([executionPromise, timeoutPromise]);

        const parsed = JSON.parse(resultJson);
        if (parsed.__error) {
            return {
                success: false,
                error: parsed.message,
                stack: parsed.stack || '',
            };
        }

        return {
            success: true,
            result: parsed.result,
        };
    } catch (error: any) {
        const errorMsg = error.message || String(error);
        const stack = error.stack || '';
        return {
            success: false,
            error: errorMsg,
            stack: stack,
        };
    }
}
