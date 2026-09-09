#!/usr/bin/env node
// Developer utility: send one event to the EasyEDA extension through an already
// running EasyEDA Copilot bridge (the MCP server that owns ws://127.0.0.1:8787).
//
// It connects as a "proxy" client, exactly like a second MCP server instance does,
// so it never disturbs the owner and needs no MCP client restart. Useful when
// iterating on extension events during development.
//
// Usage:
//   node mcp/scripts/easyeda-request.mjs <event> [jsonBody] [--timeout <ms>] [--out <file>] [--instance <id>]
//   node mcp/scripts/easyeda-request.mjs get-schematic
//   node mcp/scripts/easyeda-request.mjs get-schematic '{"includeConnections":true}' --out /tmp/sch.json
//   node mcp/scripts/easyeda-request.mjs proxy:list-easyeda-instances
//
// Environment:
//   EASYEDA_COPILOT_MCP_WS_HOST / EASYEDA_COPILOT_MCP_WS_PORT  (default 127.0.0.1:8787)

import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const HOST = process.env.EASYEDA_COPILOT_MCP_WS_HOST || '127.0.0.1';
const PORT = Number(process.env.EASYEDA_COPILOT_MCP_WS_PORT || 8787);
const URL = `ws://${HOST}:${PORT}`;

function parseArgs(argv) {
    const positional = [];
    const options = { timeout: 120_000, out: undefined, instance: undefined };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--timeout') options.timeout = Number(argv[++i]);
        else if (arg === '--out') options.out = argv[++i];
        else if (arg === '--instance') options.instance = argv[++i];
        else if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        } else positional.push(arg);
    }
    return { positional, options };
}

function printUsage() {
    console.error('Usage: node mcp/scripts/easyeda-request.mjs <event> [jsonBody] [--timeout <ms>] [--out <file>] [--instance <id>]');
}

function connect() {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(URL);
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error(`Timeout connecting to bridge at ${URL}. Is the MCP server running?`));
        }, 3_000);
        socket.addEventListener('open', () => {
            clearTimeout(timer);
            resolve(socket);
        });
        socket.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error(`Cannot connect to bridge at ${URL}. Is the MCP server running?`));
        });
    });
}

function send(socket, event, body) {
    socket.send(JSON.stringify({ event, body: JSON.stringify(body) }));
}

function waitFor(socket, predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.removeEventListener('message', onMessage);
            reject(new Error(`Timeout waiting for ${label}`));
        }, timeoutMs);
        const onMessage = (messageEvent) => {
            let message;
            try {
                message = JSON.parse(String(messageEvent.data));
            } catch {
                return;
            }
            const body = message.body ? JSON.parse(message.body) : {};
            if (!predicate(message, body)) return;
            clearTimeout(timer);
            socket.removeEventListener('message', onMessage);
            resolve({ message, body });
        };
        socket.addEventListener('message', onMessage);
    });
}

async function main() {
    const { positional, options } = parseArgs(process.argv.slice(2));
    const [event, rawBody] = positional;
    if (!event) {
        printUsage();
        process.exit(2);
    }

    let requestBody = {};
    if (rawBody) {
        try {
            requestBody = JSON.parse(rawBody);
        } catch (error) {
            console.error(`Body is not valid JSON: ${error.message}`);
            process.exit(2);
        }
    }

    const socket = await connect();
    try {
        const handshake = waitFor(socket, m => m.event === 'proxy:hello:result', 3_000, 'proxy handshake');
        send(socket, 'proxy:hello', { ok: true, protocolVersion: 1 });
        const { body: hello } = await handshake;
        if (hello.ok !== true) throw new Error('Bridge rejected the proxy handshake.');

        const id = randomUUID();
        const isListInstances = event === 'proxy:list-easyeda-instances';
        const response = waitFor(
            socket,
            (m, b) => m.event === 'proxy:response' && b.id === id,
            options.timeout + 5_000,
            `response to ${event}`,
        );

        if (isListInstances) {
            send(socket, 'proxy:list-easyeda-instances', { id });
        } else {
            send(socket, 'proxy:request-easyeda', {
                id,
                event,
                body: requestBody,
                timeoutMs: options.timeout,
                ...(options.instance ? { targetInstanceId: options.instance } : {}),
            });
        }

        const { body } = await response;
        if (body.ok === false) {
            console.error(`EasyEDA event failed: ${body.error ?? 'unknown error'}`);
            process.exit(1);
        }

        const text = JSON.stringify(body.result ?? null, null, 2);
        if (options.out) {
            await writeFile(options.out, text);
            console.error(`Result written to ${options.out} (${text.length} chars)`);
        } else {
            console.log(text);
        }
    } finally {
        socket.close();
    }
}

main().catch(error => {
    console.error(error.message);
    process.exit(1);
});
