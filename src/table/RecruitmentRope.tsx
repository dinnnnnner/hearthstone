import { useEffect, useRef } from "react";
import { playTableSound } from "./sound";
import type { CSSProperties } from "react";
import { useRemainingTime, type RoomClock } from "../online/Countdown";
import "./rope.css";

const BURN_TIME = 20_000;
export function RecruitmentRope({ clock, sound = false }: { clock: RoomClock; sound?: boolean }) {
  // Only this small overlay ticks; card layout and the game engine do not rerender.
  const remaining = useRemainingTime(clock, 100);
  const seconds = Math.ceil(remaining / 1000);
  const lastSecond = useRef(seconds);
  useEffect(() => {
    if (seconds !== lastSecond.current && seconds > 0 && seconds <= 5 && clock.deadline > 0)
      playTableSound("tick", sound);
    lastSecond.current = seconds;
  }, [seconds, sound, clock.deadline]);
  if (clock.deadline <= 0 || remaining > BURN_TIME) return null;
  const spent = remaining === 0;
  return <div className={`recruitment-rope ${seconds <= 5 ? "rope-urgent" : ""} ${spent ? "rope-spent" : ""}`}
    data-seconds={seconds} style={{ "--rope-burn": `${(1 - remaining / BURN_TIME) * 100}%` } as CSSProperties}>
    <div className="rope-track" aria-hidden="true">
      <span className="rope-pin rope-pin-left" /><span className="rope-pin rope-pin-right" />
      <span className="rope-ash" /><span className="rope-cord" />
      <span className="rope-fuse">
        <span className="rope-glow" /><span className="rope-flame" /><span className="rope-core" />
        <span className="rope-sparks">{[0, 1, 2, 3, 4, 5].map((i) => <i key={i} style={{ "--spark": i } as CSSProperties} />)}</span>
      </span>
      {spent && <span className="rope-last-ember" />}
    </div>
    <span className="rope-caption" role="timer" aria-label="招募倒计时" aria-live="off">
      {spent ? "招募结束 · 等待战斗" : <><b>{seconds}</b> 秒 · 招募即将结束</>}
    </span>
  </div>;
}
