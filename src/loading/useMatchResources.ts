import { useEffect, useSyncExternalStore } from "react";
import { assetUrl } from "../paths";
import { prepareSampledSounds, SAMPLED_FILES } from "../table/sampledSounds";
import images from "./matchAssets.json";
import { waitForResourceDownloads } from "./resourceTraffic";

type Resources = { phase: "idle" | "loading" | "ready" | "error"; completed: number; total: number; failed: number };
let state: Resources = { phase: "idle", completed: 0, total: images.length + SAMPLED_FILES.length, failed: 0 };
const listeners = new Set<() => void>();
const prepared = new Set<string>();
let loading: Promise<void> | undefined;
function publish(next: Resources) { state = next; listeners.forEach(notify => notify()); }

export function prepareMatchResources() {
  if (loading || state.phase === "ready") return loading;
  loading = (async () => {
    let imageCount = 0, audioCount = 0, failed = 0, cursor = 0;
    const progress = () => publish({ phase: "loading", completed: imageCount + audioCount, total: state.total, failed });
    progress();
    const worker = async () => {
      while (cursor < images.length) {
        const path = images[cursor++];
        if (!prepared.has(path)) {
          try {
            await waitForResourceDownloads();
            const response = await fetch(assetUrl(path), { cache: "force-cache", priority: "low", signal: AbortSignal.timeout(20000) });
            if (!response.ok) throw Error("Missing image");
            await response.arrayBuffer();
            prepared.add(path);
          } catch { failed++; }
        }
        imageCount++;
        progress();
      }
    };
    const audio = prepareSampledSounds(count => { audioCount = count; progress(); });
    await Promise.all(Array.from({ length: 3 }, worker));
    failed += await audio;
    publish({ phase: failed ? "error" : "ready", completed: state.total, total: state.total, failed });
  })().finally(() => { loading = undefined; });
  return loading;
}

export function useMatchResources(enabled: boolean) {
  const resources = useSyncExternalStore(
    notify => { listeners.add(notify); return () => { listeners.delete(notify); }; },
    () => state,
  );
  useEffect(() => { if (enabled) void prepareMatchResources(); }, [enabled]);
  return { ...resources, ready: resources.phase === "ready", retry: prepareMatchResources };
}
