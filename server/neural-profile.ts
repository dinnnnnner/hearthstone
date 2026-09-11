import { createHash } from 'node:crypto';
import { ACTIONS } from '../rl/actions';
import { ENTITY_SCHEMA as legacySchema, observeEntities as legacyObserve } from './neural-observation';
import { ENTITY_SCHEMA as scoutingSchema, observeEntities as scoutingObserve } from '../rl/entities';

export function inferenceProfile(name = 'legacy-v3') {
  if (name !== 'legacy-v3' && name !== 'scouting-v4') throw Error(`Unknown inference profile: ${name}`);
  const entitySchema = name === 'legacy-v3' ? legacySchema : scoutingSchema;
  const schema = JSON.stringify({ actions: ACTIONS, entity_schema: entitySchema });
  return { name, schema, contract: createHash('sha256').update(schema).digest('hex'),
    observe: name === 'legacy-v3' ? legacyObserve : scoutingObserve };
}
