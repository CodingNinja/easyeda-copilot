// Test bootstrap: `node --import ./tests/setup.mjs --test 'tests/*.test.ts'` (see `npm test`).
//
// Node runs .ts test files with built-in type stripping, but its ES module resolver
// requires explicit file extensions. The sources under src/ use extensionless
// relative imports (resolved by esbuild at build time), so this hook lets the
// tests import them unchanged by retrying `./name` as `./name.ts`.
import { register } from 'node:module';

register('./resolve-ts.mjs', import.meta.url);
