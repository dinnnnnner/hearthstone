import { useEffect, useState } from "react";

export interface RoomClock {
  deadline: number;
  serverNow: number;
  /** Monotonic browser time at receipt of this server snapshot. */
  receivedAt: number;
}
export function useRemainingTime(clock: RoomClock, interval = 1000) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const update = () => setNow(performance.now());
    update();
    if (clock.deadline <= 0) return;
    const id = setInterval(update, interval);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", update);
    };
  }, [clock.deadline, interval]);
  return Math.max(0, clock.deadline - clock.serverNow - Math.max(0, now - clock.receivedAt));
}

export function Countdown(clock: RoomClock) {
  const remaining = Math.ceil(useRemainingTime(clock) / 1000);
  return clock.deadline > 0 ? <span> · {remaining}秒</span> : null;
}
