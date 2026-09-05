import { describe, expect, it } from 'vitest';
import { buildTools, type GraphSnapshotSource } from '../src/server/mcp.js';
import { FORWARDABILITY } from '../src/server/http.js';

/**
 * 架构评审第二轮 #7:工具注册策略跟定义走。
 * 三张手抄名单(只读屏蔽 / 基线闸门 / relay 白名单)全部改为从工具定义标志与
 * 穷尽映射派生——本文件钉住派生结果与重构前三张名单逐名相等(等值快照),
 * 并钉「每个工具必须显式声明两 bit」的编译期纪律在运行期的镜像。
 */

function fakeGraph(): GraphSnapshotSource {
  return {
    snapshot: () => ({ rootPath: '/proj', generatedAt: 1, nodes: [], edges: [] }),
    setNote: () => false,
    setReview: () => false
  };
}

const allTools = buildTools(fakeGraph(), {});
const names = Object.keys(allTools).sort();

// 重构前三张手抄名单的历史事实(2026-09-05,up@dd42e26)。派生集合必须与之恒等。
const MUTATING_TOOLS = [
  'begin_review',
  'declare_edit_scope',
  'end_review',
  'report_edits',
  'report_note',
  'report_test_run',
  'update_review'
];
const BASELINE_GATED_TOOLS = [
  'begin_review',
  'end_review',
  'get_change_impact',
  'get_health_report',
  'get_impact',
  'get_module_details',
  'list_untested',
  'report_note',
  'update_review'
];
const FORWARDABLE_EVENTS = [
  'edit_scope',
  'edit_verification',
  'module_activity',
  'node_update',
  'review_timeout',
  'scan_error'
];
// GraphEvent 的全部 8 个变体:relay 白名单必须对每个都表态(fwd/hold)。
const ALL_EVENT_TYPES = [
  'edit_scope',
  'edit_verification',
  'graph_delta',
  'module_activity',
  'node_update',
  'review_timeout',
  'scan_error',
  'snapshot'
];

describe('ToolDef 策略标志(#7:注册表即名单)', () => {
  it('14 个工具全部显式声明 mutating 与 contentDependent 两个布尔', () => {
    expect(names).toHaveLength(14);
    for (const [name, def] of Object.entries(allTools)) {
      expect(typeof def.mutating, `${name}.mutating`).toBe('boolean');
      expect(typeof def.contentDependent, `${name}.contentDependent`).toBe('boolean');
    }
  });

  it('mutating 标志与重构前 READ_ONLY_BLOCKED_TOOLS 名单恒等', () => {
    const mutating = names.filter((n) => allTools[n]!.mutating);
    expect(mutating).toEqual([...MUTATING_TOOLS].sort());
  });

  it('contentDependent 标志与重构前 BASELINE_GATED 名单恒等', () => {
    const gated = names.filter((n) => allTools[n]!.contentDependent);
    expect(gated).toEqual(BASELINE_GATED_TOOLS);
  });

  it('只读隐藏层派生自标志:hidden 集合 === mutating 集合,分析类全存活', () => {
    const readOnly = buildTools(fakeGraph(), { readOnly: true });
    const hidden = names.filter((n) => !(n in readOnly));
    expect(hidden).toEqual([...MUTATING_TOOLS].sort());
    for (const [name, def] of Object.entries(readOnly)) {
      expect(def.mutating, name)    .toBe(false);
    }
  });

  it('内容型工具必须受闸门:begin/update/end_review 是 mutating ∧ contentDependent;report_test_run 变更但免闸门', () => {
    for (const n of ['begin_review', 'update_review', 'end_review']) {
      expect(allTools[n]!.mutating, n).toBe(true);
      expect(allTools[n]!.contentDependent, n).toBe(true);
    }
    expect(allTools.report_test_run!.mutating).toBe(true);
    expect(allTools.report_test_run!.contentDependent).toBe(false);
    expect(allTools.get_dashboard_info!.contentDependent).toBe(false);
    expect(allTools.get_module_graph!.contentDependent).toBe(false);
  });
});

describe('relay 白名单穷尽映射(#7)', () => {
  it('每个 GraphEvent 变体都被表态,取值只有 fwd/hold', () => {
    expect(Object.keys(FORWARDABILITY).sort()).toEqual(ALL_EVENT_TYPES);
    for (const [type, verdict] of Object.entries(FORWARDABILITY)) {
      expect(['fwd', 'hold'], type).toContain(verdict);
    }
  });

  it('fwd 集合与重构前 FORWARDABLE_TYPES 手挑名单恒等', () => {
    const fwd = Object.entries(FORWARDABILITY)
      .filter(([, v]) => v === 'fwd')
      .map(([t]) => t)
      .sort();
    expect(fwd).toEqual([...FORWARDABLE_EVENTS].sort());
  });
});
