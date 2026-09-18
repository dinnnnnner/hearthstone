/** npx tsx scripts/evaluate-basic-position.ts request.json [result.json] */
import { readFileSync, writeFileSync } from 'node:fs';
import { compareRecruitLines, evaluateBasic } from '../rl/basic-evaluation';

const [input, output] = process.argv.slice(2);
if (!input) throw Error('Usage: tsx scripts/evaluate-basic-position.ts request.json [result.json]');
const request = JSON.parse(readFileSync(input, 'utf8'));
const result = request.lines
  ? compareRecruitLines(request.entities, request.lines, request.seeds, request.weights)
  : evaluateBasic(request.entities, request.phase, request.weights);
const text = JSON.stringify(result, null, 2) + '\n';
if (output) writeFileSync(output, text);
else process.stdout.write(text);
