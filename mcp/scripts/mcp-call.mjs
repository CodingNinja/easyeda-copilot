#!/usr/bin/env node
// Developer utility: call one tool on the LOCAL MCP server build (mcp/dist/index.js) over stdio,
// exactly as an MCP client would. Complements easyeda-request.mjs, which bypasses the MCP
// server and talks to the extension directly. Use this one when the tool itself has logic
// (cloud calls, schema validation, restyle routing) that you want to exercise.
//
// Usage:
//   node mcp/scripts/mcp-call.mjs [--instance <easyedaInstanceId>] <tool> [jsonArgs] [--out <file>]
//   node mcp/scripts/mcp-call.mjs list_easyeda_instances
//   node mcp/scripts/mcp-call.mjs --instance 6f6a… get_current_page_schematic '{"include_connections":true}'
//
// The server joins the already running bridge (port 8787) as a proxy, so nothing else needs
// restarting. `--instance` runs select_easyeda_instance first (selection is per server process).
// Environment variables (EASYEDA_COPILOT_DEBUG, EASYEDA_COPILOT_SERVER_URL, …) are passed through.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(here, '..', 'dist', 'index.js');

function parseArgs(argv) {
    const positional = [];
    const options = { instance: undefined, out: undefined };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--instance') options.instance = argv[++i];
        else if (arg === '--out') options.out = argv[++i];
        else if (arg === '--help' || arg === '-h') {
            console.error('Usage: node mcp/scripts/mcp-call.mjs [--instance <id>] <tool> [jsonArgs] [--out <file>]');
            process.exit(0);
        } else positional.push(arg);
    }
    return { positional, options };
}

function textOf(result) {
    const parts = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text);
    const text = parts.join('\n');
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        return text;
    }
}

async function main() {
    const { positional, options } = parseArgs(process.argv.slice(2));
    const [tool, rawArgs] = positional;
    if (!tool) {
        console.error('Usage: node mcp/scripts/mcp-call.mjs [--instance <id>] <tool> [jsonArgs] [--out <file>]');
        process.exit(2);
    }
    let args = {};
    if (rawArgs) {
        try {
            args = JSON.parse(rawArgs);
        } catch (error) {
            console.error(`Arguments are not valid JSON: ${error.message}`);
            process.exit(2);
        }
    }

    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: process.env, stderr: 'pipe' });
    const client = new Client({ name: 'easyeda-copilot-dev-cli', version: '0.0.0' });
    let serverStderr = '';
    transport.stderr?.on('data', chunk => { serverStderr += chunk.toString(); });

    try {
        await client.connect(transport);

        if (options.instance) {
            const selected = await client.callTool({ name: 'select_easyeda_instance', arguments: { instanceId: options.instance } });
            if (selected.isError) throw new Error(`select_easyeda_instance failed: ${textOf(selected)}`);
        }

        const result = await client.callTool({ name: tool, arguments: args });
        const text = textOf(result);
        if (options.out) {
            await writeFile(options.out, text);
            console.error(`Result written to ${options.out} (${text.length} chars)${result.isError ? ' [isError]' : ''}`);
        } else {
            console.log(text);
        }
        if (result.isError) process.exitCode = 1;
    } catch (error) {
        console.error(error.message);
        if (serverStderr.trim()) console.error(`--- server stderr ---\n${serverStderr.trim()}`);
        process.exitCode = 1;
    } finally {
        await client.close().catch(() => undefined);
    }
}

main();
