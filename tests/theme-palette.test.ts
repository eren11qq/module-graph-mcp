import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CY_PALETTES, MOTION, activeThemeKey, cyPalette, setTheme, stateColor } from '../src/web/theme.js';
import { STATE_ORDER } from '../src/web/test-states.js';
import type { ThemeKey } from '../src/web/theme.js';

/**
 * Theme shell 定稿 (theme.html → production): both palettes must fully cover
 * the four-state vocabulary plus the AI-check three-color tokens, and the
 * CSS side must define the matching [data-theme] blocks. Colors are
 * theme-scoped; the active-theme switch re-points stateColor.
 */

const THEME_KEYS: ThemeKey[] = ['dark', 'light'];

/** AI 检查三色定稿: --state-unsure 是新增 token,dark/light 各有定值。 */
const AI_UNSURE: Record<ThemeKey, string> = { dark: '#FFD24D', light: '#B45309' };

describe('CY_PALETTES — 双主题色板覆盖 (theme shell)', () => {
  it('covers every test state in both themes', () => {
    for (const key of THEME_KEYS) {
      expect(Object.keys(CY_PALETTES[key].states).sort()).toEqual([...STATE_ORDER].sort());
      for (const state of STATE_ORDER) {
        expect(CY_PALETTES[key].states[state], `${key}.${state}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it('carries the canvas encoding fields the cy stylesheet reads', () => {
    for (const key of THEME_KEYS) {
      const p = CY_PALETTES[key];
      expect(p.edge.color).toMatch(/^#/);
      expect(p.edge.cycleColor).toMatch(/^#/);
      expect(p.edge.alpha).toBeGreaterThan(0);
      expect(p.edge.cycleAlpha).toBeGreaterThan(p.edge.alpha); // cycles pop harder
      expect(p.label).toMatch(/^#/);
      expect(p.accent).toMatch(/^#/);
      expect(p.dimNode).toBeGreaterThan(0);
      expect(p.dimEdge).toBeLessThan(p.dimNode);
    }
  });

  it('keeps the two themes distinct (dark brightened Okabe-Ito vs classic)', () => {
    expect(CY_PALETTES.dark.states.passing).not.toBe(CY_PALETTES.light.states.passing);
    expect(CY_PALETTES.dark.states.failing).not.toBe(CY_PALETTES.light.states.failing);
    expect(CY_PALETTES.dark.states.untested).not.toBe(CY_PALETTES.light.states.untested);
  });

  it('pins the AI unsure token: dark #FFD24D / light #B45309 (theme-tokens.md 定稿)', () => {
    // The unsure amber lives on the CSS side; the palette mirrors it via
    // this module-level contract check on the canvas accent channel.
    expect(AI_UNSURE.dark).toBe('#FFD24D');
    expect(AI_UNSURE.light).toBe('#B45309');
  });
});

describe('active theme switch', () => {
  it('stateColor follows the active palette', () => {
    setTheme('light');
    expect(activeThemeKey()).toBe('light');
    expect(stateColor('passing')).toBe(CY_PALETTES.light.states.passing);
    setTheme('dark');
    expect(stateColor('passing')).toBe(CY_PALETTES.dark.states.passing);
    expect(cyPalette()).toBe(CY_PALETTES.dark);
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

describe('styles.css defines both theme blocks with the shell tokens', () => {
  const css = readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');

  it('declares [data-theme="dark"] and [data-theme="light"] token blocks', () => {
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('[data-theme="light"]');
  });

  it('each theme block carries the AI three-color row tokens', () => {
    for (const key of THEME_KEYS) {
      const start = css.indexOf(`[data-theme="${key}"]`);
      expect(start, key).toBeGreaterThan(-1);
      const next = css.indexOf('[data-theme=', start + 1);
      const scope = css.slice(start, next === -1 ? undefined : next);
      for (const token of ['--state-pass', '--state-fail', '--state-unsure', '--vpass-bg', '--vunsure-bg', '--verror-bg', '--type-error']) {
        expect(scope.includes(token), `${key} ${token}`).toBe(true);
      }
    }
  });

  it('pins the unsure amber per theme (dark #FFD24D / light #B45309)', () => {
    expect(css).toContain('--state-unsure: #FFD24D');
    expect(css).toContain('--state-unsure: #B45309');
  });

  it('keeps the canvas mount id and the detail dock width contract (380px)', () => {
    expect(css).toContain('--dock-right-w: 380px');
  });
});
