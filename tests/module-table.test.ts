import { describe, expect, it } from 'vitest';
import {
  FUNCTIONAL_MODULES,
  MODULE_IDS,
  filesInModule,
  labelOf,
  moduleIdOf,
  modulesOf,
  moduleMatches
} from '../src/shared/module-table.js';

/**
 * ADR 0002 / MODULE-DESIGN §7.1: the module table is the single source of
 * truth shared by the server-side edit-scope verifier and the web module
 * view. Entries are either directory prefixes (trailing '/') or explicit
 * files; a file matching more than one functional module is a table conflict
 * (test red). Files outside the table belong to no module.
 */

describe('module table shape (ADR 0002 §7.1)', () => {
  it('defines exactly the six v1 functional modules with unique ids and labels', () => {
    expect(FUNCTIONAL_MODULES).toHaveLength(6);
    const ids = FUNCTIONAL_MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(6);
    for (const m of FUNCTIONAL_MODULES) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.entries.length).toBeGreaterThan(0);
    }
    expect(MODULE_IDS).toEqual(ids);
  });

  it('the v1 table has no self-conflicts (guard for future edits)', () => {
    // A representative file per entry (prefix → a file under it, explicit →
    // the file itself) must classify into exactly one module.
    const samples: Array<{ id: string; module: string }> = [];
    for (const m of FUNCTIONAL_MODULES) {
      for (const entry of m.entries) {
        samples.push({ id: entry.endsWith('/') ? `${entry}x.ts` : entry, module: m.id });
      }
    }
    for (const { id } of samples) {
      expect(modulesOf(id), `${id}`).toEqual([samples.find((s) => s.id === id)!.module]);
    }
  });
});

describe('moduleIdOf — classification', () => {
  it('directory prefixes claim the whole subtree', () => {
    expect(moduleIdOf('src/web/main.ts')).toBe('dashboard');
    expect(moduleIdOf('src/web/graph-view.ts')).toBe('dashboard');
    expect(moduleIdOf('src/shared/types.ts')).toBe('shared-contract');
    expect(moduleIdOf('src/evals/tasks/registry.ts')).toBe('trust-probes');
    expect(moduleIdOf('tests/graph-view.test.ts')).toBe('tests-samples');
    expect(moduleIdOf('test-fixtures/sample-app/index.ts')).toBe('tests-samples');
  });

  it('explicit files classify exactly, and the two src/server classes split', () => {
    // MCP 服务（对外接口面）
    for (const f of ['src/server/mcp.ts', 'src/server/index.ts', 'src/server/http.ts', 'src/server/report-page.ts', 'src/server/open-browser.ts', 'src/server/review-lifecycle.ts', 'src/server/review-store.ts', 'src/server/health-report.ts', 'src/server/impact.ts', 'src/server/response-budget.ts', 'src/server/version.ts']) {
      expect(moduleIdOf(f), f).toBe('mcp-service');
    }
    // 依赖图引擎（内核面）
    for (const f of ['src/server/incremental-graph.ts', 'src/server/file-watcher.ts', 'src/server/live-reload.ts', 'src/server/recent-changes.ts', 'src/server/coverage.ts', 'src/server/source-reader.ts', 'src/server/path-conventions.ts', 'src/server/state-pipeline.ts', 'src/server/typecheck.ts', 'src/server/gitignore.ts']) {
      expect(moduleIdOf(f), f).toBe('graph-engine');
    }
  });

  it('files outside the table belong to no module', () => {
    expect(moduleIdOf('src/server/not-listed.ts')).toBeNull();
    expect(moduleIdOf('src/server/public/app.js')).toBeNull();
    expect(moduleIdOf('package.json')).toBeNull();
    expect(moduleIdOf('README.md')).toBeNull();
    expect(moduleIdOf('docs/MODULE-DESIGN.md')).toBeNull();
    expect(moduleIdOf('')).toBeNull();
  });

  it('a dir-prefix entry does not claim the directory itself as a file', () => {
    // 'src/web/' matches files under it, not the bare directory id.
    expect(moduleIdOf('src/web')).toBeNull();
    expect(moduleIdOf('src/web/')).toBeNull();
  });
});

describe('modulesOf / moduleMatches — conflict vocabulary', () => {
  it('modulesOf returns every matching module (single for the v1 table)', () => {
    expect(modulesOf('src/web/main.ts')).toEqual(['dashboard']);
    expect(modulesOf('src/server/mcp.ts')).toEqual(['mcp-service']);
    expect(modulesOf('package.json')).toEqual([]);
  });

  it('moduleMatches: trailing slash = prefix, otherwise exact file', () => {
    expect(moduleMatches(['src/web/'], 'src/web/a/b.ts')).toBe(true);
    expect(moduleMatches(['src/web/'], 'src/web/main.ts')).toBe(true);
    expect(moduleMatches(['src/web/'], 'src/web')).toBe(false);
    expect(moduleMatches(['src/server/mcp.ts'], 'src/server/mcp.ts')).toBe(true);
    expect(moduleMatches(['src/server/mcp.ts'], 'src/server/mcp.ts.bak')).toBe(false);
    expect(moduleMatches([], 'anything')).toBe(false);
  });
});

describe('filesInModule — expansion over a file set', () => {
  it('keeps only the files of the requested module, in input order', () => {
    const ids = [
      'src/web/main.ts',
      'src/server/mcp.ts',
      'src/web/graph-view.ts',
      'src/server/incremental-graph.ts',
      'package.json'
    ];
    expect(filesInModule(ids, 'dashboard')).toEqual(['src/web/main.ts', 'src/web/graph-view.ts']);
    expect(filesInModule(ids, 'mcp-service')).toEqual(['src/server/mcp.ts']);
    expect(filesInModule(ids, 'graph-engine')).toEqual(['src/server/incremental-graph.ts']);
    expect(filesInModule(ids, 'tests-samples')).toEqual([]);
  });
});

describe('labelOf — agent-facing names', () => {
  it('returns the documented Chinese labels', () => {
    expect(labelOf('mcp-service')).toBe('MCP 服务');
    expect(labelOf('graph-engine')).toBe('依赖图引擎');
    expect(labelOf('dashboard')).toBe('Dashboard 渲染');
    expect(labelOf('shared-contract')).toBe('共享契约');
    expect(labelOf('trust-probes')).toBe('信任探针');
    expect(labelOf('tests-samples')).toBe('测试与样例');
  });
});
