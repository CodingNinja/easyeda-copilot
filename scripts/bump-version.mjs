#!/usr/bin/env node
// Bump the patch version in every manifest that carries it, keeping them identical.
// Runs automatically before `npm run build` (see "prebuild"), except in CI, where the
// version comes from the release commit. Run by hand: `node scripts/bump-version.mjs [x.y.z]`.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.env.CI) {
    console.log('bump-version: CI detected, version left unchanged.');
    process.exit(0);
}

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const write = (p, s) => writeFileSync(resolve(root, p), s);

const current = JSON.parse(read('extension.json')).version;
const next = process.argv[2] ?? current.replace(/(\d+)$/, (m) => String(Number(m) + 1));
if (!/^\d+\.\d+\.\d+$/.test(next)) {
    console.error(`bump-version: "${next}" is not x.y.z`);
    process.exit(1);
}

// JSON manifests: only the top-level "version" (first occurrence), so dependency versions are untouched.
for (const file of ['package.json', 'mcp/package.json', 'extension.json']) {
    write(file, read(file).replace(/("version":\s*")[^"]+(")/, `$1${next}$2`));
}
// mcp/server.json carries the version twice (server and package entry); both must match.
write('mcp/server.json', read('mcp/server.json').replaceAll(`"version": "${current}"`, `"version": "${next}"`));
// package-lock.json: root package and the mcp workspace entry only.
write('package-lock.json', read('package-lock.json').replaceAll(`"version": "${current}"`, `"version": "${next}"`));
// MCP server announces its version to clients.
write('mcp/src/index.ts', read('mcp/src/index.ts').replace(/version: '[^']+'/, `version: '${next}'`));

console.log(`bump-version: ${current} → ${next}`);
