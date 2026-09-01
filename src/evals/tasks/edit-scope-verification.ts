import { check, type EvalTask, type ProbeResult } from '../types.js';

/**
 * Probe (ADR 0002 / MODULE-DESIGN §7.2): the declare_edit_scope /
 * report_edits pair. The server judges by module table + watcher facts:
 * declared scope admits explicit files (fixture paths are out of table, so
 * they can only enter via the explicit-file channel), undeclared files are
 * out-of-scope, and an unknown module id is a structured error. Watcher
 * cross-checking (漏报) is covered at unit level — the static fixture never
 * changes, so the wire probe pins membership, not the watcher.
 */
export const task: EvalTask = {
  id: 'edit-scope-verification',
  description: 'declare_edit_scope/report_edits admit declared files, flag out-of-scope edits and reject unknown modules',
  maxMs: 1500,
  maxBytes: 4500,
  async probe(client): Promise<ProbeResult> {
    const info = await client.callTool('get_dashboard_info');
    check(!info.failed, `get_dashboard_info failed: ${info.rpcError?.message ?? info.text}`);
    const modules = (info.payload as { modules?: Array<{ id: string; label: string; files: string[] }> }).modules;
    check(Array.isArray(modules) && modules.length === 6, `modules list missing/wrong: ${JSON.stringify(modules)}`);
    check(modules!.every((m) => typeof m.id === 'string' && typeof m.label === 'string' && Array.isArray(m.files)),
      `module entry shape wrong: ${JSON.stringify(modules)}`);

    const declared = await client.callTool('declare_edit_scope', { files: ['core/app.ts'] });
    check(!declared.failed, `declare_edit_scope failed: ${declared.rpcError?.message ?? declared.text}`);
    const decl = declared.payload as { ok?: boolean; scope?: { files?: string[] }; inScopeFileCount?: number };
    check(decl.ok === true, `declare not ok: ${declared.text}`);
    check(JSON.stringify(decl.scope?.files) === JSON.stringify(['core/app.ts']), `scope files wrong: ${declared.text}`);
    check(typeof decl.inScopeFileCount === 'number' && decl.inScopeFileCount >= 1, `inScopeFileCount wrong: ${declared.text}`);

    const clean = await client.callTool('report_edits', { files: ['core/app.ts'] });
    check(!clean.failed, `report_edits failed: ${clean.rpcError?.message ?? clean.text}`);
    const cleanPayload = clean.payload as { ok?: boolean; outOfScope?: unknown[]; unreported?: unknown[]; preexisting?: unknown[] };
    check(cleanPayload.ok === true, `declared file must be in scope: ${clean.text}`);
    check(Array.isArray(cleanPayload.outOfScope) && cleanPayload.outOfScope.length === 0, `unexpected outOfScope: ${clean.text}`);
    // Ticket 13 (scope epoch): the response must carry the pre-baseline list
    // (static fixture never changes → it stays empty here, but the field is contract).
    check(Array.isArray(cleanPayload.preexisting), `preexisting array missing: ${clean.text}`);

    const dirty = await client.callTool('report_edits', { files: ['core/app.ts', 'core/emitter.ts'] });
    const dirtyPayload = dirty.payload as {
      ok?: boolean;
      outOfScope?: Array<{ id: string; source: string }>;
      reported?: string[];
    };
    check(dirtyPayload.ok === false, `out-of-scope edit must turn ok=false: ${dirty.text}`);
    check(
      dirtyPayload.outOfScope?.some((e) => e.id === 'core/emitter.ts' && e.source === 'reported'),
      `core/emitter.ts must be out-of-scope with source reported: ${dirty.text}`
    );

    const badModule = await client.callTool('declare_edit_scope', { modules: ['bogus'] });
    check(badModule.failed, 'an unknown module id must be a structured error');
    check(badModule.text.includes('valid ids'), `valid-id guidance missing: ${badModule.text.slice(0, 120)}`);

    // Empty declaration clears the scope → everything out-of-scope again.
    const cleared = await client.callTool('declare_edit_scope', {});
    check(!cleared.failed, `clearing declare failed: ${cleared.rpcError?.message ?? cleared.text}`);
    const afterClear = await client.callTool('report_edits', { files: ['core/app.ts'] });
    const after = afterClear.payload as { scopeDeclared?: boolean; ok?: boolean; outOfScope?: Array<{ id: string }> };
    check(after.scopeDeclared === false && after.ok === false, `cleared scope must not admit files: ${afterClear.text}`);
    check(after.outOfScope?.some((e) => e.id === 'core/app.ts'), `cleared scope: core/app.ts must be out-of-scope: ${afterClear.text}`);

    return { bytes: info.bytes + declared.bytes + clean.bytes + dirty.bytes + badModule.bytes + cleared.bytes + afterClear.bytes };
  }
};
