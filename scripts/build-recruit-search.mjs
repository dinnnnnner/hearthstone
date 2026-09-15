import { build } from 'esbuild';
// Separate output: never overwrite a running/frozen training simulator.
await build({ entryPoints: ['rl/recruit-search-bridge.ts'], bundle: true, platform: 'node', target: 'node20',
  format: 'cjs', outfile: 'rl-dist/recruit-search.cjs', define: { 'import.meta.env.BASE_URL': '"/tavern/"' }, logLevel: 'info' });
