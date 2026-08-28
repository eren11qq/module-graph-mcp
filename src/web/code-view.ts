import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import 'highlight.js/styles/github-dark.css';
import type { AiReview, AiReviewEntry, TypeErrorEntry } from '../shared/types.js';

/**
 * Ticket 09/12: source view rendered line by line (prototype `.cl` row
 * structure) so AI-review verdicts and type errors can highlight WHOLE rows.
 *
 * Rows wrap (`pre-wrap`) instead of scrolling horizontally — long lines fold
 * and nothing is ever clipped. highlight.js runs per line so verdict rows can
 * carry their own background; the accepted trade-off: continuation lines of
 * multi-line comments / template strings degrade to plain colors (noted in
 * theme-tokens.md).
 *
 * Two highlight channels coexist and never override each other: the agent's
 * aiReview verdicts (green/amber/red row) and the real typeErrors (left bar).
 * highlight.js is registered per-language (core build) to keep the bundle
 * lean; unknown extensions fall back to escaped plaintext.
 */

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('yaml', yaml);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.css': 'css',
  '.md': 'markdown',
  '.html': 'xml',
  '.xml': 'xml',
  '.yml': 'yaml',
  '.yaml': 'yaml'
};

export interface SourceLoadResult {
  content: string;
}

export type SourceLoader = (path: string) => Promise<SourceLoadResult>;

export interface SourceShowNode {
  path: string;
  typeErrors: TypeErrorEntry[];
  aiReview?: AiReview;
}

export interface SourceView {
  /** Render `path`'s content; verdict/error rows highlighted. Caches by path + marks. */
  show(node: SourceShowNode): Promise<void>;
}

function languageOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : '';
  return LANGUAGE_BY_EXTENSION[ext] ?? 'plaintext';
}

const VERDICT_CLASS: Record<AiReviewEntry['verdict'], string> = {
  confident: 'v-pass',
  unsure: 'v-unsure',
  error: 'v-error'
};

const VERDICT_DEFAULT_MARK: Record<AiReviewEntry['verdict'], string | null> = {
  confident: null,
  unsure: '// ? 待确认',
  error: '// ✗ 逻辑不符'
};

export function createSourceView(container: HTMLElement, load: SourceLoader): SourceView {
  let loadedKey: string | null = null;
  let latestPath: string | null = null;

  async function show(node: SourceShowNode): Promise<void> {
    latestPath = node.path;
    const errorsKey = JSON.stringify(node.typeErrors.map((e) => [e.line, e.code]));
    const review = node.aiReview;
    const verdictsKey =
      review === undefined
        ? 'none'
        : `${review.status}|${JSON.stringify(review.verdicts.map((v) => [v.line, v.verdict, v.message ?? '']))}`;
    const key = `${node.path}|${errorsKey}|${verdictsKey}`;
    if (loadedKey === key) return;

    container.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'code-loading';
    loading.textContent = '加载源码…';
    container.append(loading);

    let content: string;
    try {
      const result = await load(node.path);
      content = result.content;
    } catch (err) {
      container.replaceChildren();
      const note = document.createElement('div');
      note.className = 'code-error-note';
      note.textContent = `源码不可读：${err instanceof Error ? err.message : String(err)}`;
      container.append(note);
      loadedKey = null;
      return;
    }

    // Stale response (the panel moved on meanwhile) — drop it.
    if (latestPath !== node.path) return;

    const lines = content.split('\n');
    const errorLines = new Set(node.typeErrors.filter((e) => e.line >= 1).map((e) => e.line));
    const verdictByLine = new Map<number, AiReviewEntry>();
    // Verdict colors only once the review is done; while checking, rows stay plain.
    if (review?.status === 'done') {
      for (const v of review.verdicts) verdictByLine.set(v.line, v);
    }

    container.replaceChildren();
    const language = languageOf(node.path);
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const text = lines[i] ?? '';
      const row = document.createElement('div');
      row.className = 'cl';

      const verdict = verdictByLine.get(lineNo);
      if (verdict !== undefined) row.classList.add(VERDICT_CLASS[verdict.verdict]);
      if (errorLines.has(lineNo)) row.classList.add('t-err');

      const ln = document.createElement('span');
      ln.className = 'ln';
      ln.textContent = String(lineNo);

      const body = document.createElement('span');
      body.className = 'cl-body';
      if (language === 'plaintext') {
        // highlight.js core has no 'plaintext' registered; escape via
        // textContent (ticket 09 fallback).
        body.textContent = text;
      } else {
        // Per-line highlighting (see module docblock for the trade-off).
        body.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
      }

      if (verdict !== undefined) {
        const mark = verdict.message ?? VERDICT_DEFAULT_MARK[verdict.verdict];
        if (mark !== null) {
          const mk = document.createElement('span');
          mk.className = `mk mk-${verdict.verdict}`;
          mk.textContent = ` ${mark}`;
          body.append(mk);
        }
      }

      row.append(ln, body);
      container.append(row);
    }

    loadedKey = key;
  }

  return { show };
}
