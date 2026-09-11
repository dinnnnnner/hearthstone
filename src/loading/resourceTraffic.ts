let paused = 0;
const waiting = new Set<() => void>();

export function waitForResourceDownloads() {
  if (!paused) return Promise.resolve();
  return new Promise<void>(resolve => waiting.add(resolve));
}

// Finish in-flight files, then reserve the connection for the room response.
export function pauseResourceDownloads() {
  paused++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--paused === 0) {
      waiting.forEach(resolve => resolve());
      waiting.clear();
    }
  };
}
