import { createHash } from 'node:crypto';
import { ACTIONS } from '../rl/actions';
import { ENTITY_SCHEMA as legacySchema, observeEntities as legacyObserve } from './neural-observation';
import { ENTITY_SCHEMA as scoutingSchema, observeEntities as scoutingObserve } from '../rl/entities';

const frozenScoutingSchema = { ...legacySchema, version: 3 };
const frozenIds = new Map(legacySchema.ids.map((id, index) => [id, index + 1]));
const frozenScoutingObserve: typeof scoutingObserve = (...args) => scoutingObserve(...args).map(entity => {
  if (!entity) return null;
  const cardId = scoutingSchema.ids[entity.id - 1], id = frozenIds.get(cardId);
  // An old checkpoint cannot interpret new identities. Let the existing room fallback handle it.
  if (!id) throw Error(`Unknown entity identity ${cardId} for scouting-v4; use a trinkets-v5 checkpoint`);
  return { ...entity, id };
});

export function inferenceProfile(name = 'legacy-v3') {
  if (name !== 'legacy-v3' && name !== 'scouting-v4' && name !== 'trinkets-v5') throw Error(`Unknown inference profile: ${name}`);
  const entitySchema = name === 'legacy-v3' ? legacySchema : name === 'scouting-v4' ? frozenScoutingSchema : scoutingSchema;
  const schema = JSON.stringify({ actions: ACTIONS, entity_schema: entitySchema });
  return { name, schema, contract: createHash('sha256').update(schema).digest('hex'),
    observe: name === 'legacy-v3' ? legacyObserve : name === 'scouting-v4' ? frozenScoutingObserve : scoutingObserve };
}
