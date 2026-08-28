import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import 'highlight.js/styles/github-dark.css';
import type { TypeErrorEntry } from '../shared/types.js';

/**
 * Ticket 09: highlighted source view with error-line markers.
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

const LINE_HEIGHT_PX = 20;

export interface SourceLoadResult {
  content: string;
}

export type SourceLoader = (path: string) => Promise<SourceLoadResult>;

export interface SourceView {
  /**
   * Render `path`'s content; error lines get a persistent marker and stay
   * clickable to scroll into view. Caches by path until the node's errors
   * change.
   */
  show(node: { path: string; typeErrors: TypeErrorEntry[] }): Promise<void>;
}

function languageOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : '';
  return LANGUAGE_BY_EXTENSION[ext] ?? 'plaintext';
}

export function createSourceView(container: HTMLElement, load: SourceLoader): SourceView {
  let loadedPath: string | null = null;
  let loadedErrors: string | null = null;
  let latest: { path: string; typeErrors: TypeErrorEntry[] } | null = null;

  async function show(node: { path: string; typeErrors: TypeErrorEntry[] }): Promise<void> {
    latest = { path: node.path, typeErrors: node.typeErrors };
    const errorsKey = JSON.stringify(node.typeErrors.map((e) => [e.line, e.code]));
    if (loadedPath === node.path && loadedErrors === errorsKey) return;

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
      loadedPath = null;
      loadedErrors = null;
      return;
    }

    // Stale response (the panel moved on meanwhile) — drop it.
    if (latest === null || latest.path !== node.path) return;

    container.replaceChildren();
    const language = languageOf(node.path);
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (language === 'plaintext') {
      // highlight.js core has no 'plaintext' registered, so hljs.highlight
      // would throw; escape via textContent instead (ticket 09 fallback).
      pre.className = 'code-pre hljs';
      code.textContent = content;
    } else {
      pre.className = `code-pre hljs language-${language}`;
      code.innerHTML = hljs.highlight(content, { language, ignoreIllegals: true }).value;
    }
    pre.append(code);
    container.append(pre);

    // Error-line markers: absolutely positioned in the scroll container,
    // aligned via the fixed CSS line height.
    const lines = content.split('\n').length;
    container.style.setProperty('--code-lines', String(Math.max(lines, 1)));
    for (const err of node.typeErrors) {
      if (err.line < 1 || err.line > lines) continue;
      const marker = document.createElement('div');
      marker.className = 'code-error-marker';
      marker.style.top = `${(err.line - 1) * LINE_HEIGHT_PX}px`;
      marker.title = `L${err.line} ${err.code}: ${err.message}`;
      marker.addEventListener('click', () => {
        container.scrollTo({ top: Math.max(0, (err.line - 1) * LINE_HEIGHT_PX - 40), behavior: 'smooth' });
      });
      container.append(marker);
    }

    loadedPath = node.path;
    loadedErrors = errorsKey;
  }

  return { show };
}
