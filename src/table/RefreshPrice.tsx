import { Heart } from "lucide-react";
import type { Game } from "../engine";
import { refreshPayment } from "../season/engine";
export function RefreshPrice({ game, compact = false }: { game: Game; compact?: boolean }) {
  const payment = refreshPayment(game);
  if (!payment.health) return <>{payment.gold}</>;
  return (
    <span className="refresh-health-price" title={`消耗${payment.health}点生命，剩余${payment.remaining}次`}>
      <Heart size={12} fill="currentColor" aria-hidden="true" />
      {payment.health}
      {!compact && <small>余{payment.remaining}次</small>}
    </span>
  );
}
