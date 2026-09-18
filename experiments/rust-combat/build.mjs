import { build } from 'esbuild';
await build({entryPoints:['experiments/rust-combat/oracle.ts'],outfile:'experiments/rust-combat/oracle.cjs',bundle:true,platform:'node',format:'cjs',target:'node20',define:{'import.meta.env.BASE_URL':'"/tavern/"'}});
