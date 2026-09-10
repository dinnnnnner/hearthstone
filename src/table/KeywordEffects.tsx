import type { Minion } from "../engine";
export function KeywordEffects({ m }: { m: Minion }) {
  return (
    <span className="keyword-effects" aria-hidden="true">
      {m.keywords.includes("嘲讽") && (
        <svg className="taunt-guard" viewBox="0 0 100 124" preserveAspectRatio="none">
          <path className="guard-shadow" d="M8 14 24 4 50 9 76 4 92 14 96 74Q91 105 50 121 9 105 4 74Z" />
          <path className="guard-metal" d="M9 15 24 6 50 11 76 6 91 15 94 73Q89 102 50 118 11 102 6 73Z" />
          <path className="guard-bevel" d="M12 18 25 10 50 15 75 10 88 18 90 72Q85 99 50 113 15 99 10 72Z" />
          <path className="guard-seam" d="M13 20 26 14 50 19 74 14 87 20M12 77Q18 98 50 109 82 98 88 77" />
          <path className="guard-tip" d="m42 107 8 5 8-5-8 10Z" />
          <circle cx="16" cy="24" r="2" /><circle cx="84" cy="24" r="2" />
        </svg>
      )}
      {(m.rebornNext || m.keywords.includes("复生")) && <span className="reborn-aura" />}
      {m.keywords.includes("风怒") && <span className="windfury-aura" />}
      {m.keywords.includes("圣盾") && <span className="divine-shield"><span className="shield-reflection" /></span>}
    </span>
  );
}
