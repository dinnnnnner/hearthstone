import { useEffect } from "react";
export function LoadingScreen({
  title = "正在布置酒馆",
  detail = "准备英雄与随从卡面…",
  completed,
  total,
  embedded = false,
  onContinue,
  continueLabel = "先进入，卡面稍后加载",
}: {
  title?: string;
  detail?: string;
  completed?: number;
  total?: number;
  embedded?: boolean;
  onContinue?: () => void;
  continueLabel?: string;
}) {
  return (
    <section
      className={`tavern-loading ${embedded ? "is-embedded" : ""}`}
      aria-label="酒馆加载画面"
      aria-busy="true"
    >
      <div className="loading-content">
        <p className="loading-eyebrow">BOB’S TAVERN</p>
        <div className="loading-seal" aria-hidden="true">
          <span className="loading-stars">
            ✦<span>✦</span>
          </span>
          <svg viewBox="0 0 80 80">
            <path d="M40 5 68 22v35L40 74 12 57V22Z" />
            <path d="M49 25c-16-12-36 6-26 24 8 14 28 7 30-5 2-12-15-17-19-7-3 8 6 12 10 6" />
            <path d="M40 5v8M68 57l-7-4M12 57l7-4" />
          </svg>
        </div>
        <h2>{title}</h2>
        <p className="loading-detail" role="status">
          {detail}
        </p>
        <div
          className={`loading-track ${total ? "is-determinate" : ""}`}
          role="progressbar"
          aria-label="准备游戏素材"
          aria-valuemin={0}
          aria-valuemax={total || undefined}
          aria-valuenow={total ? completed : undefined}
        >
          <span
            className="loading-fill"
            style={
              total
                ? { width: `${(100 * (completed || 0)) / total}%` }
                : undefined
            }
          />
        </div>
        {total ? (
          <p className="loading-count">
            {completed} / {total}
          </p>
        ) : null}
        <p className="loading-tip">
          鲍勃的小提示
          <br />
          <b>三张相同随从可以合为金色，保留额外属性。</b>
        </p>
        {onContinue && (
          <button className="loading-action" onClick={onContinue}>
            {continueLabel}
          </button>
        )}
      </div>
      <span className="loading-footer">招募 · 三连 · 决胜酒馆</span>
    </section>
  );
}
export function BootReady() {
  useEffect(() => {
    const screen = document.getElementById("boot-screen");
    if (!screen) return;
    screen.classList.add("boot-leaving");
    const timer = setTimeout(() => screen.remove(), 230);
    return () => clearTimeout(timer);
  }, []);
  return null;
}
