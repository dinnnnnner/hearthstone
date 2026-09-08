import { useEffect, useState } from "react";

export function Countdown({
  deadline,
  serverNow,
  receivedAt,
}: {
  deadline: number;
  serverNow: number;
  receivedAt: number;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(
    0,
    Math.ceil(
      (deadline - serverNow - (Math.max(now, receivedAt) - receivedAt)) / 1000,
    ),
  );
  return deadline > 0 ? <span> · {remaining}秒</span> : null;
}
