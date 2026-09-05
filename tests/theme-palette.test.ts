import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CY_PALETTE,
  MOTION,
  THEME,
  clusterFcoseOverrides,
  clusterIdealEdgeLength,
  cyPalette,
  diameterOf,
  reviewColor,
  sizeAwareRepulsion,
  stateColor,
  uniformIdealEdgeLength
} from '../src/web/theme.js';
import { STATE_ORDER } from '../src/web/test-states.js';

/**
 * 单主题(暗色仪器盘)定稿 —— 架构评审第二轮 #5:浅色工作台整体删除,
 * 「当前主题」全局随之消失。一个测试状态色 = 一份 TS 值 + 一份 CSS token,
 * 由下方等值钉逐色交叉断言:改一侧忘另一侧 = 测试红。历史病:双主题时代
 * 两真源各钉一侧从不交叉,legend 色点与画布球色可悄悄漂移。
 */

const css = readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');

/** 取 [data-theme="dark"] token 块里的一个 CSS 变量值;不存在返回 null。 */
function cssToken(name: string): string | null {
  const start = css.indexOf('[data-theme="dark"] {');
  if (start === -1) return null;
  const block = css.slice(start, css.indexOf('}', start));
  const m = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  return m ? m[1].trim().toUpperCase() : null;
}

describe('CY_PALETTE — 单主题色板覆盖', () => {
  it('covers every test state', () => {
    expect(Object.keys(CY_PALETTE.states).sort()).toEqual([...STATE_ORDER].sort());
    for (const state of STATE_ORDER) {
      expect(CY_PALETTE.states[state], state).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('carries the canvas encoding fields the cy stylesheet reads', () => {
    const p = CY_PALETTE;
    expect(p.edge.color).toMatch(/^#/);
    expect(p.edge.cycleColor).toMatch(/^#/);
    expect(p.edge.alpha).toBeGreaterThan(0);
    expect(p.edge.cycleAlpha).toBeGreaterThan(p.edge.alpha); // cycles pop harder
    expect(p.label).toMatch(/^#/);
    expect(p.accent).toMatch(/^#/);
    expect(p.dimNode).toBeGreaterThan(0);
    expect(p.dimEdge).toBeLessThan(p.dimNode);
  });

  it('cyPalette() 读的就是这一份表 —— 不再有「当前主题」间接层', () => {
    expect(cyPalette()).toBe(CY_PALETTE);
    expect(stateColor('passing')).toBe(CY_PALETTE.states.passing);
    expect(reviewColor('error')).toBe(CY_PALETTE.review.error);
  });
});

describe('等值钉 — TS 色板 ⇄ styles.css dark token 逐色交叉,一份不许漂', () => {
  // [说明, TS 侧值, CSS token 名] —— 双主题时代各钉一侧、从不交叉的账,这里结清。
  const PAIRS: ReadonlyArray<readonly [string, string, string]> = [
    ['passing 球色 = 覆盖率带/图例点', CY_PALETTE.states.passing, '--state-pass'],
    ['failing 球色 = 失败条', CY_PALETTE.states.failing, '--state-fail'],
    ['has-tests-unrun 球色', CY_PALETTE.states['has-tests-unrun'], '--state-skip'],
    ['untested 球色', CY_PALETTE.states.untested, '--state-none'],
    ['AI unsure 黄(评审环/行条)', CY_PALETTE.review.unsure, '--state-unsure'],
    ['AI error 红 = 类型错误色', CY_PALETTE.review.error, '--type-error'],
    ['类型错误环色(THEME 侧同值)', THEME.typeError.color, '--type-error'],
    ['画布地面 = --bg(theme.ts 注释自供的镜像)', CY_PALETTE.canvas, '--bg'],
    ['普通边色', CY_PALETTE.edge.color, '--edge-line'],
    ['环朱红', CY_PALETTE.edge.cycleColor, '--cycle-line'],
    ['聚焦/accent 青', CY_PALETTE.accent, '--accent'],
    ['节点标签 = 地面墨色', CY_PALETTE.label, '--ink']
  ];

  it.each(PAIRS)('%s', (_label, tsValue, token) => {
    const cssValue = cssToken(token);
    expect(cssValue, `styles.css 缺少 ${token}`).not.toBeNull();
    expect(cssValue, `${token} 与 TS 侧漂移`).toBe(tsValue.toUpperCase());
  });
});

describe('浅色主题删除钉(#5)', () => {
  it('styles.css 不再存在 light token 块', () => {
    expect(css).not.toContain('[data-theme="light"]');
  });
});

describe('死词汇清扫钉(#6,纯减法)', () => {
  it('CyPalette.edge 只留实际被读的 4 键 —— moduleColor 随 ADR 0003 模块级边退役', () => {
    expect(Object.keys(CY_PALETTE.edge).sort()).toEqual(['alpha', 'color', 'cycleAlpha', 'cycleColor']);
  });

  it('THEME 不再携带 collapse —— 目录折叠已随 ADR 0002 退役,唯一引用是过期注释', () => {
    expect(THEME).not.toHaveProperty('collapse');
  });
});

describe('MOTION — checking 脉冲与物理参数', () => {
  it('pulse period ≈1.2 Hz with a min<max overlay window', () => {
    expect(MOTION.checkingPulsePeriodMs).toBeGreaterThanOrEqual(780);
    expect(MOTION.checkingPulsePeriodMs).toBeLessThanOrEqual(860);
    expect(MOTION.checkingPulseMin).toBeLessThan(MOTION.checkingPulseMax);
  });

  it('stops ambient drift on large graphs, keeps a positive drift band otherwise', () => {
    expect(MOTION.driftMaxNodes).toBe(600);
    expect(MOTION.driftAmpMin).toBeGreaterThan(0);
    expect(MOTION.driftAmpMax).toBeGreaterThan(MOTION.driftAmpMin);
  });
});

describe('uniformIdealEdgeLength — 等空隙裁定 (2026-08-31)', () => {
  it('小球-小球: gap + 两端半径 (21 + 21 + 52)', () => {
    expect(uniformIdealEdgeLength(52, 21, 21)).toBe(94);
  });

  it('小球-枢纽: 大球吃到自己的半径,空隙仍是一档 (21 + 65 + 52)', () => {
    expect(uniformIdealEdgeLength(52, 21, 65)).toBe(138);
  });

  it('半径缺失(data 未写 → 0)夹到最小球半径,不留负空隙通道', () => {
    // 最小真实球 deg=1:diameterOf(1)/2 = 10.6。
    const minR = 10.6;
    expect(uniformIdealEdgeLength(52, 0, 0)).toBeCloseTo(52 + 2 * minR);
    expect(uniformIdealEdgeLength(52, Number.NaN, 21)).toBeCloseTo(52 + minR + 21);
  });

  it('spacingGap 单一事实源住在 THEME.layout,且守住漂移下限 ≥ 40', () => {
    expect(THEME.layout.spacingGap).toBe(52);
    expect(THEME.layout.spacingGap).toBeGreaterThanOrEqual(40);
  });
});

describe('clusterIdealEdgeLength / clusterFcoseOverrides (2026-09-01 D1/D2)', () => {
  const edge = (d1: number, d2: number) =>
    (({
      source: () => ({ data: () => d1 }),
      target: () => ({ data: () => d2 })
    }) as unknown) as cytoscape.EdgeSingular;

  it('簇内理想边长 = ballGap + 两端半径（共享 spacingGap 52 的降档,海报要团不要点阵）', () => {
    const r = diameterOf(1) / 2;
    expect(clusterIdealEdgeLength(edge(24, 24))).toBeCloseTo(THEME.layout.ballGap + 24, 9);
    expect(clusterIdealEdgeLength(edge(0, 0))).toBeCloseTo(THEME.layout.ballGap + 2 * r, 9); // 缺失夹最小球
  });

  it('聚类覆盖只出三键（numIter 600 / gravity 1.2 / idealEdgeLength 函数）,THEME.fcose 共享对象不被污染', () => {
    const before = { ...THEME.fcose };
    const o = clusterFcoseOverrides();
    expect(o.numIter).toBe(600);
    expect(o.gravity).toBe(1.2);
    expect(o.idealEdgeLength).toBe(clusterIdealEdgeLength);
    expect(Object.keys(o).sort()).toEqual(['gravity', 'idealEdgeLength', 'numIter']);
    expect(THEME.fcose).toEqual(before);
  });
});

describe('sizeAwareRepulsion — 大球间距二次裁定 (2026-08-31)', () => {
  const minR = diameterOf(1) / 2; // 10.6:最小真实球半径=夹紧基准

  it('小球对斥力与旧常数一致 (boost = 1)', () => {
    expect(sizeAwareRepulsion(20000, minR)).toBeCloseTo(20000, 5);
  });

  it('枢纽球 (d=65 → r=32.5) 按面积放大 ≈9×,大球与大球顶得出空隙', () => {
    expect(sizeAwareRepulsion(20000, 32.5)).toBeCloseTo(20000 * (32.5 / minR) ** 2, 3);
    expect(sizeAwareRepulsion(20000, 32.5)).toBeGreaterThan(20000 * 9);
  });

  it('放大顶格 16×:超大球不再继续抬,整体斥力有上界', () => {
    expect(sizeAwareRepulsion(20000, minR * 5)).toBe(20000 * 16);
  });

  it('半径缺失/异常 (0、NaN、负) 夹到 minR → 恰为基准值', () => {
    expect(sizeAwareRepulsion(20000, 0)).toBeCloseTo(20000, 5);
    expect(sizeAwareRepulsion(20000, Number.NaN)).toBe(20000);
    expect(sizeAwareRepulsion(20000, -50)).toBeCloseTo(20000, 5);
  });
});

describe('styles.css defines the dark theme block with the shell tokens', () => {
  it('declares [data-theme="dark"] token block with the AI three-color row tokens', () => {
    for (const token of ['--state-pass', '--state-fail', '--state-unsure', '--vpass-bg', '--vunsure-bg', '--verror-bg', '--type-error']) {
      expect(cssToken(token), token).not.toBeNull();
    }
  });

  it('keeps the canvas mount id and the detail dock width contract (380px)', () => {
    expect(css).toContain('--dock-right-w: 380px');
  });
});
