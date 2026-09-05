import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * 落盘卫生层（dot-module store，2026-09-05 架构评审候选 #1）。
 *
 * `<root>/.module-graph/` 下所有 JSON 状态文件的共享 fs 仪式，收编自
 * review-store 与 recent-changes 的两份逐字抄本（外加 run.ts 的目录名
 * 第三副本）：目录创建、自忽略 .gitignore 自举、tmp+rename 原子写、
 * 坏文件即空、schema version 信封、warn-once 闩、写失败降级仅内存
 * ——**全部失败路径都不 throw**。
 *
 * 只管仪式，不管语义：每个文件自身的 payload 解码（哪些条目算合法）与
 * 合并规则（墓碑并集 / per-id max / 容量截断）留在消费者手里——它们
 * 本就不同，强行泛化会让 interface 膨胀回 shallow。日志文案由消费者在
 * 自己的调用点用 warn() 拼（闩在这边，字串在那边），逐字节保持收编前。
 */

/** 单一事实源：server 消费者与 evals 的 fixture 清理共用同一个目录名。 */
export const DOT_MODULE_DIR = '.module-graph';

export interface DotModuleStoreOptions {
  /** 被监视根目录（反斜杠与尾部斜杠由本模块归一）。 */
  rootPath: string;
  /** `.module-graph/` 下的文件名，如 `reviews.json`。 */
  fileName: string;
  /** 信封 schema version；不匹配 → loadRaw 视为空（不告警，与收编前一致）。 */
  version: number;
  /** 人类可读日志汇（warn 闩只放行第一条）。 */
  log?(msg: string): void;
}

export type DotModuleLoadResult =
  | { status: 'ok'; body: Record<string, unknown> }
  | { status: 'empty'; reason: 'missing' | 'corrupt' | 'version' };

export type DotModuleSaveResult = { ok: true } | { ok: false; err: unknown };

export interface DotModuleStore {
  /**
   * 读并解析 store 文件。不可读/坏 JSON/版本不符都归 empty——区分 reason
   * 只为让消费者决定告警（corrupt 才告，missing/version 静默，收编前如此）。
   */
  loadRaw(): DotModuleLoadResult;
  /** mkdir + gitignore 自举 + JSON(body, null, 2)+'\n' → tmp → rename。从不 throw。 */
  saveRaw(body: unknown): DotModuleSaveResult;
  /** 闩控日志：第一条经注入的 log 出，之后的静默。 */
  warn(msg: string): void;
}

/** 降级日志里的错误描述，两个消费者的既有文案共用。 */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createDotModuleStore(opts: DotModuleStoreOptions): DotModuleStore {
  const root = opts.rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const dir = `${root}/${DOT_MODULE_DIR}`;
  const file = `${dir}/${opts.fileName}`;
  const log = opts.log ?? (() => {});
  let warned = false;

  return {
    loadRaw(): DotModuleLoadResult {
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        return { status: 'empty', reason: 'missing' }; // 无文件 / 不可读 → 空（静默）
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { status: 'empty', reason: 'corrupt' };
      }
      if (typeof parsed !== 'object' || parsed === null) return { status: 'empty', reason: 'version' };
      const body = parsed as Record<string, unknown>;
      if (body.version !== opts.version) return { status: 'empty', reason: 'version' };
      return { status: 'ok', body };
    },

    saveRaw(body: unknown): DotModuleSaveResult {
      try {
        mkdirSync(dir, { recursive: true });
        // 让 .module-graph/ 默认不进 git（状态数据不是源码；想提交可自行改）。
        // 只写一次，不覆盖用户已有的自定义 .gitignore。
        if (!existsSync(`${dir}/.gitignore`)) {
          writeFileSync(`${dir}/.gitignore`, `*\n!.gitignore\n`, 'utf8');
        }
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
        renameSync(tmp, file);
        return { ok: true };
      } catch (err) {
        return { ok: false, err };
      }
    },

    warn(msg: string): void {
      if (warned) return;
      warned = true;
      log(msg);
    }
  };
}
