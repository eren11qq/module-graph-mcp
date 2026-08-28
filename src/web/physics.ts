import type { NodeSingular, Core, ElementAnimateOptionPos } from 'cytoscape';
import { MOTION, prefersReducedMotion } from './theme.js';

/**
 * Node physics (prototype theme.html §节点物理, production port): three
 * layers on top of the static fcose layout —
 *
 *   1. ambient drift    slow per-axis sinusoids, de-synchronised per node
 *   2. release spring   underdamped spring-back after a drag, fed by the
 *                       drag's recent velocity (flick to send a ball sliding)
 *   3. hover pop        ball scales up while hovered, neighbours less
 *
 * plus the AI-checking pulse: while a node carries the `checking` class its
 * overlay-opacity oscillates ≈1.2 Hz (theme MOTION), producing the breathing
 * edge halo. All motion collapses under prefers-reduced-motion (a checking
 * node keeps only its static bright border) and ambient drift stops above
 * MOTION.driftMaxNodes balls (pulse/spring stay on).
 *
 * Base positions are captured by rebase() — call it after every layout run /
 * element swap so drift and spring-back orbit the CURRENT resting spots.
 */

interface PhysState {
  ele: NodeSingular;
  baseDiameter: number;
  bx: number;
  by: number;
  amp: number;
  w1: number;
  w2: number;
  ph1: number;
  ph2: number;
  sx: number;
  sy: number;
  vx: number;
  vy: number;
  hist: Array<{ x: number; y: number; t: number }>;
  ooOn: boolean;
}

export interface Physics {
  /** Re-capture base positions for the current node set; restarts the clock. */
  rebase(): void;
  popNode(ele: NodeSingular, mult: number): void;
  restorePop(): void;
  destroy(): void;
}

export function createPhysics(cy: Core): Physics {
  const reduced = prefersReducedMotion();
  const states = new Map<string, PhysState>();
  let raf = 0;
  let t0 = 0;
  let last = 0;

  function rebase(): void {
    for (const id of [...states.keys()]) {
      if (cy.getElementById(id).empty()) states.delete(id);
    }
    t0 = last = performance.now();
    cy.nodes().forEach((n) => {
      const p = n.position();
      const ampRange = MOTION.driftAmpMax - MOTION.driftAmpMin;
      states.set(n.id(), {
        ele: n,
        baseDiameter: Number(n.data('diameter')) || 0,
        bx: p.x,
        by: p.y,
        amp: MOTION.driftAmpMin + Math.random() * ampRange,
        w1: 0.5 + Math.random() * 0.5, // 6–12s per axis, de-synchronised
        w2: 0.5 + Math.random() * 0.5,
        ph1: Math.random() * Math.PI * 2,
        ph2: Math.random() * Math.PI * 2,
        sx: 0,
        sy: 0,
        vx: 0,
        vy: 0,
        hist: [],
        ooOn: false
      });
    });
    if (!reduced && raf === 0) raf = requestAnimationFrame(tick);
  }

  function tick(now: number): void {
    const t = (now - t0) / 1000;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const driftEnabled = cy.nodes().length <= MOTION.driftMaxNodes;
    const pulsePeriod = MOTION.checkingPulsePeriodMs;
    const pulseSpan = MOTION.checkingPulseMax - MOTION.checkingPulseMin;

    for (const s of states.values()) {
      if (s.ele.inside() && !s.ele.removed()) {
        if (s.ele.grabbed()) continue;

        // AI checking pulse: breathing overlay (the border comes from the
        // `checking` stylesheet rule; reduced motion keeps only that border).
        if (s.ele.hasClass('checking')) {
          s.ooOn = true;
          s.ele.data('oo', MOTION.checkingPulseMin + pulseSpan * (0.5 + 0.5 * Math.sin((now / pulsePeriod) * Math.PI * 2)));
        } else if (s.ooOn) {
          s.ooOn = false;
          s.ele.data('oo', 0);
        }

        // Release spring.
        s.vx += (-MOTION.springK * s.sx - MOTION.springC * s.vx) * dt;
        s.vy += (-MOTION.springK * s.sy - MOTION.springC * s.vy) * dt;
        s.sx += s.vx * dt;
        s.sy += s.vy * dt;
        if (Math.abs(s.sx) + Math.abs(s.sy) + Math.abs(s.vx) + Math.abs(s.vy) < 0.02) {
          s.sx = s.sy = s.vx = s.vy = 0;
        }

        const drifted =
          driftEnabled &&
          (s.amp * Math.abs(Math.sin(t * s.w1 + s.ph1)) > 0.01 ||
            s.sx !== 0 ||
            s.sy !== 0);
        if (drifted) {
          s.ele.position({
            x: s.bx + s.sx + s.amp * Math.sin(t * s.w1 + s.ph1),
            y: s.by + s.sy + s.amp * Math.sin(t * s.w2 + s.ph2)
          });
        } else if (s.sx !== 0 || s.sy !== 0) {
          s.ele.position({ x: s.bx + s.sx, y: s.by + s.sy });
        }
      }
    }
    raf = requestAnimationFrame(tick);
  }

  function popNode(ele: NodeSingular, mult: number): void {
    if (reduced || ele.empty()) return;
    const s = states.get(ele.id());
    const base = s?.baseDiameter ?? Number(ele.data('diameter')) ?? 0;
    if (base <= 0) return;
    ele.stop(true);
    // Animating `data` is a cytoscape runtime feature the @types don't model.
    ele.animate({ data: { diameter: base * mult } } as unknown as ElementAnimateOptionPos, {
      duration: MOTION.popDurationMs,
      easing: 'ease-out'
    });
  }

  function restorePop(): void {
    if (reduced) return;
    cy.nodes().forEach((n) => {
      const s = states.get(n.id());
      const base = s?.baseDiameter ?? Number(n.data('diameter')) ?? 0;
      if (base > 0 && Math.abs(Number(n.data('diameter')) - base) > 0.3) {
        n.stop(true);
        n.animate({ data: { diameter: base } } as unknown as ElementAnimateOptionPos, {
          duration: MOTION.popDurationMs,
          easing: 'ease-out'
        });
      }
    });
  }

  // Drag → spring hand-off: while grabbed cytoscape owns the ball 1:1; on
  // release the recent drag motion becomes the spring's initial velocity.
  cy.on('grab', 'node', (evt) => {
    const s = states.get(evt.target.id());
    if (!s) return;
    const p = evt.target.position();
    s.bx = p.x;
    s.by = p.y;
    s.sx = s.sy = s.vx = s.vy = 0;
    s.hist = [];
  });
  cy.on('drag', 'node', (evt) => {
    const s = states.get(evt.target.id());
    if (!s) return;
    const p = evt.target.position();
    const now = performance.now();
    s.hist.push({ x: p.x, y: p.y, t: now });
    if (s.hist.length > 3) s.hist.shift();
    s.bx = p.x;
    s.by = p.y;
  });
  cy.on('dragfree', 'node', (evt) => {
    const s = states.get(evt.target.id());
    if (!s) return;
    const h = s.hist;
    if (h.length >= 2) {
      const a = h[h.length - 2]!;
      const b = h[h.length - 1]!;
      const dt = (b.t - a.t) / 1000;
      if (dt > 0) {
        s.vx = Math.max(-MOTION.dragVelocityMax, Math.min(MOTION.dragVelocityMax, ((b.x - a.x) / dt) * MOTION.dragVelocityFactor));
        s.vy = Math.max(-MOTION.dragVelocityMax, Math.min(MOTION.dragVelocityMax, ((b.y - a.y) / dt) * MOTION.dragVelocityFactor));
      }
    }
    s.hist = [];
  });

  function destroy(): void {
    if (raf !== 0) cancelAnimationFrame(raf);
    raf = 0;
  }

  return { rebase, popNode, restorePop, destroy };
}
