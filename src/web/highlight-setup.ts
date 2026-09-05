import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * The lazy highlight.js boundary.
 *
 * This module is the ONLY static importer of highlight.js and is reached
 * exclusively through `await import('./highlight-setup.js')` from
 * code-view.ts, so vite emits it as a separate chunk that the browser
 * fetches on first source-file view — never before the graph paints
 * (first-paint budget, tests/bundle-split.test.ts).
 *
 * highlight.js is registered per-language (core build) to keep the chunk
 * lean; unknown extensions fall back to escaped plaintext in code-view.
 */

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('yaml', yaml);

export default hljs;
