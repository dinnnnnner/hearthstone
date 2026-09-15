import { createInterface } from 'node:readline';
import { inferenceProfile } from '../server/neural-profile';
import { RecruitSearchEnv, SEARCH_VERSION, UnsupportedSearch } from './recruit-search';
let branch: RecruitSearchEnv | undefined;
const profile = inferenceProfile('scouting-v4');
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  try {
    const m = JSON.parse(line); let result: unknown;
    switch (m.command) {
      case 'meta': result = { contract: profile.contract, searchVersion: SEARCH_VERSION }; break;
      case 'open':
        branch = undefined;
        try { branch = new RecruitSearchEnv(m.entities, m.decisions, m.budget); result = { supported: true }; }
        catch (e) { if (!(e instanceof UnsupportedSearch)) throw e; result = { supported: false, reason: e.message }; }
        break;
      case 'reset': if (!branch) throw Error('No search root'); result = branch.reset(m.seed); break;
      case 'step': if (!branch) throw Error('No search root'); result = branch.step(m.action); break;
      case 'release': branch = undefined; result = { released: true }; break;
      case 'close': process.exit(0);
      default: throw Error('Unknown recruit-search command');
    }
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: String(e) }) + '\n'); }
});
