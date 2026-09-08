import {build} from 'esbuild';
await build({entryPoints:['server/index.ts'],bundle:true,platform:'node',target:'node20',format:'cjs',outfile:'server-dist/server.cjs',define:{'import.meta.env.BASE_URL':'"/tavern/"'},logLevel:'info'});
