import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
export type BurstKind = "hit" | "shield" | "buff" | "death" | "gold";
export interface EffectsHandle {
  burst(x: number, y: number, kind: BurstKind): void;
}
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  total: number;
  color: string;
  size: number;
}
export const Effects = forwardRef<EffectsHandle>(function Effects(_, ref) {
  const canvas = useRef<HTMLCanvasElement>(null),
    particles = useRef<Particle[]>([]),
    raf = useRef(0),
    last = useRef(0),
    size = useRef({ w: 0, h: 0, dpr: 1 });
  const reduced = useRef(false);
  useEffect(() => {
    reduced.current = matchMedia("(prefers-reduced-motion: reduce)").matches;
    return () => cancelAnimationFrame(raf.current);
  }, []);
  useImperativeHandle(
    ref,
    () => ({
      burst(x, y, kind) {
        if (reduced.current || !canvas.current) return;
        const rect = canvas.current.getBoundingClientRect(),
          dpr = Math.min(devicePixelRatio || 1, 1.5);
        if (size.current.w !== rect.width || size.current.h !== rect.height) {
          canvas.current.width = rect.width * dpr;
          canvas.current.height = rect.height * dpr;
          size.current = { w: rect.width, h: rect.height, dpr };
        }
        const colors = {
          hit: ["#fff6bb", "#ffd667", "#ef9441"],
          shield: ["#e3fcff", "#78dcec", "#fff2a8"],
          buff: ["#e0ffad", "#82eac7", "#d5bbfb"],
          death: ["#b3aab4", "#8b7c94", "#edc28d"],
          gold: ["#fff3b0", "#efba4e", "#dba5fc"],
        }[kind];
        for (let i = 0; i < (kind === "gold" ? 44 : 22); i++) {
          const a = Math.random() * Math.PI * 2,
            v =
              kind === "gold"
                ? 90 + Math.random() * 170
                : 50 + Math.random() * 150,
            life = 0.35 + Math.random() * 0.4;
          particles.current.push({
            x: x - rect.x,
            y: y - rect.y,
            vx: Math.cos(a) * v,
            vy: Math.sin(a) * v,
            life,
            total: life,
            color: colors[i % colors.length],
            size:
              kind === "death" ? 3 + Math.random() * 5 : 1 + Math.random() * 3,
          });
        }
        if (raf.current) return;
        last.current = performance.now();
        const draw = (now: number) => {
          const ctx = canvas.current?.getContext("2d");
          if (!ctx) {
            raf.current = 0;
            return;
          }
          const dt = Math.min((now - last.current) / 1000, 0.04);
          last.current = now;
          ctx.setTransform(size.current.dpr, 0, 0, size.current.dpr, 0, 0);
          ctx.clearRect(0, 0, size.current.w, size.current.h);
          particles.current = particles.current.filter((p) => p.life > 0);
          for (const p of particles.current) {
            p.life -= dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += 90 * dt;
            ctx.globalAlpha = Math.max(0, p.life / p.total);
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
          if (particles.current.length)
            raf.current = requestAnimationFrame(draw);
          else {
            ctx.clearRect(0, 0, size.current.w, size.current.h);
            raf.current = 0;
          }
        };
        raf.current = requestAnimationFrame(draw);
      },
    }),
    [],
  );
  return <canvas className="table-effects" ref={canvas} aria-hidden="true" />;
});
