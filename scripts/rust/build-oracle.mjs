import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
await build({entryPoints:['scripts/rust/oracle.ts'],outfile:'native/target/oracle.cjs',bundle:true,platform:'node',format:'cjs',target:'node20',define:{'import.meta.env.BASE_URL':'"/tavern/"'},plugins:[{
 name:'private-reference-hooks',setup(api){api.onLoad({filter:/src\/season\/engine\.ts$/},args=>({contents:readFileSync(args.path,'utf8')+'\nexport const nativeOracleHooks={heroStart,heroEnd,expandedHeroAction,offerPowers,startPowerEffects,heroWheel,trinketStart,settleTrinkets,legacyTrinketEvent,makeGolden,triples,copiedAbility,draw,syncCardStats,applyGlobal,attachDarkGift,canOfferTrinket,putHand,trinketCard,flushTrinketCards,reward,queueDiscover,copyDiscovery,nextDiscovery,drawSpell,gold,trinketGold,deityGain,darkDiscover,applyShop,scale,gain,effect,run,triggerBattlecry};\n',loader:'ts'}));}
}]});
