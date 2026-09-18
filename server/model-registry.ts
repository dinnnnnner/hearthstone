import { readFileSync } from 'node:fs';
import { NeuralRooms, httpInference, inferenceBudget, type NeuralModel } from './neural';
import { inferenceProfile } from './neural-profile';
import { SEARCH_VERSION } from '../rl/recruit-search';

export function configuredModels(path: string, maxKbps: number): NeuralModel[] {
  const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(config) || !config.length) throw Error('Expected inference model list');
  const budget = inferenceBudget(maxKbps);
  return config.map(model => {
    if (!model || !/^[a-z0-9-]{1,80}$/.test(model.id) || typeof model.label !== 'string' ||
        !model.label || model.label.length > 80 || !/^[a-f0-9]{64}$/.test(model.checkpointSha256) ||
        !Number.isInteger(model.episodes) || model.episodes < 0 ||
        (model.search !== undefined && typeof model.search !== 'boolean') ||
        (model.search && !['scouting-v4', 'trinkets-v5'].includes(model.profile)))
      throw Error('Invalid inference model configuration');
    const profile = inferenceProfile(model.profile);
    const infer = httpInference(model.url, { compress: true, budget });
    return { id: model.id, label: model.label, episodes: model.episodes,
      checkpointSha256: model.checkpointSha256, profile: profile.name, search: model.search, infer,
      health: async () => {
        const response = await fetch(new URL('/health', model.url), { signal: AbortSignal.timeout(1500) });
        if (!response.ok) return false;
        const data = await response.json() as Record<string, unknown>;
        return data.ok === true && data.contract === profile.contract &&
          data.checkpointSha256 === model.checkpointSha256 &&
          (!model.search || (data.search as { version?: string } | undefined)?.version === SEARCH_VERSION);
      },
    };
  });
}

export function multiModelRooms(path: string, maxKbps: number) {
  const models = configuredModels(path, maxKbps);
  const rooms = new NeuralRooms(models[0].infer, Date.now, Math.random, models[0].profile, models);
  void rooms.checkModels();
  return rooms;
}
