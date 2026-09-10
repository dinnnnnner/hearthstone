/** Synchronous engine scope. Each training worker owns its RNG and ID counter. */
export interface SimulationScope {
  uid: () => string;
  recordFrames: boolean;
  recordLogs: boolean;
}
let current: SimulationScope | undefined;
export function withSimulation<T>(scope: SimulationScope, run: () => T): T {
  const previous = current;
  current = scope;
  try { return run(); } finally { current = previous; }
}
export const simulationUid = (fallback: () => string) => current ? current.uid() : fallback();
export const recordsFrames = () => current?.recordFrames !== false;
export const recordsLogs = () => current?.recordLogs !== false;
