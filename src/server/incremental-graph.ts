import { readdir, readFile } from 'node:fs/promises';
import { createScanner, tokenToString } from 'typescript/unstable/ast/scanner';
import { loadGitignore, type GitignoreMatcher } from './gitignore.js';
import { EXCLUDED_DIRECTORIES, LANGUAGE_BY_EXTENSION, SOURCE_EXTENSIONS, type SourceExtension } from './path-conventions.js';
import type { Edge, GraphDelta, GraphSnapshot, ModuleNode, AiReview } from '../shared/types.js';

/**
 * Ticket 05: incremental dependency-graph engine — the single graph engine.
 *
 * A watcher event for file F re-lexes ONLY F's content; every other file's
 * import specifiers stay cached from their last parse, so edge recomputation
 * is pure string resolution against the current node set — no other file is
 * ever read or parsed on F's behalf. Every mutation window yields a graph
 * delta (added/removed nodes and edges) small enough to push over WS.
 *
 * `fullScan()` is the same engine driven in full-rebuild mode; it doubles as
 * the startup baseline. The parity tests (`tests/incremental-graph.test.ts`,
 * `tests/live-reload.test.ts`) pin the windowed path against a fresh
 * fullScan of the same tree so the two modes cannot silently diverge.
 */

export interface WatchedFileEvent {
  /** Absolute or root-relative path as reported by the watcher. */
  path: string;
  kind: 'add' | 'change' | 'unlink';
}

export function isEmptyDelta(delta: GraphDelta): boolean {
  return (
    delta.addedNodes.length === 0 &&
    delta.removedNodeIds.length === 0 &&
    delta.addedEdges.length === 0 &&
    delta.removedEdges.length === 0
  );
}

// ---------------------------------------------------------------------------
// Lexer contract (typescript@7 scanner; SyntaxKind numbers asserted at runtime)
// ---------------------------------------------------------------------------

// The extension/exclusion constants come from path-conventions.ts; the KIND
// table is verified by assertScannerContract() so a typescript upgrade fails
// loudly instead of silently corrupting the graph.

const KIND = {
  Semicolon: 26,
  StringLiteral: 10,
  RegularExpressionLiteral: 13,
  NoSubstitutionTemplateLiteral: 14,
  TemplateHead: 15,
  TemplateMiddle: 16,
  TemplateTail: 17,
  NumericLiteral: 8,
  BigintLiteral: 9,
  ImportKeyword: 101,
  ExportKeyword: 94,
  OpenBrace: 18,
  CloseBrace: 19,
  OpenParen: 20,
  CloseParen: 21,
  OpenBracket: 22,
  CloseBracket: 23,
  SlashToken: 43,
  Identifier: 79
} as const;

/** Kinds after which `/` must be division; elsewhere `/` starts a regex. */
function buildExpressionContinuationKinds(): Set<number> {
  const kinds = new Set<number>([
    KIND.Identifier,
    KIND.StringLiteral,
    KIND.NumericLiteral,
    KIND.BigintLiteral,
    KIND.RegularExpressionLiteral,
    KIND.NoSubstitutionTemplateLiteral,
    KIND.TemplateHead,
    KIND.TemplateMiddle,
    KIND.TemplateTail,
    KIND.CloseBrace,
    KIND.CloseBracket,
    KIND.CloseParen
  ]);
  const expressionEndingKeywords = new Set(['this', 'super', 'true', 'false', 'null', 'undefined']);
  const tts = tokenToString as (k: number) => string | undefined;
  for (let k = 0; k <= 200; k++) {
    const label = tts(k);
    if (label !== undefined && expressionEndingKeywords.has(label)) kinds.add(k);
  }
  return kinds;
}

const EXPRESSION_CONTINUATION_KINDS = buildExpressionContinuationKinds();

function assertScannerContract(): void {
  const tts = tokenToString as (k: number) => string | undefined;
  if (tts(KIND.ImportKeyword) !== 'import') throw new Error('incremental: scanner drifted (import kind)');
  if (tts(KIND.ExportKeyword) !== 'export') throw new Error('incremental: scanner drifted (export kind)');
  if (tts(KIND.OpenParen) !== '(') throw new Error('incremental: scanner drifted (paren kind)');
  if (tts(KIND.SlashToken) !== '/') throw new Error('incremental: scanner drifted (slash kind)');
  if (tts(KIND.Semicolon) !== ';') throw new Error('incremental: scanner drifted (semicolon kind)');
}

interface Token {
  kind: number;
  value: string;
  text: string | undefined;
  newlineBefore: boolean;
}

const MAX_TOKENS_PER_FILE = 250_000;
const MAX_HEADER_WINDOW_TOKENS = 120;

function isValueBearingKind(kind: number): boolean {
  switch (kind) {
    case KIND.StringLiteral:
    case KIND.NumericLiteral:
    case KIND.BigintLiteral:
    case KIND.RegularExpressionLiteral:
    case KIND.NoSubstitutionTemplateLiteral:
    case KIND.TemplateHead:
    case KIND.TemplateMiddle:
    case KIND.TemplateTail:
      return true;
    default:
      return false;
  }
}

function tokenize(text: string): Token[] {
  assertScannerContract();
  const scanner = createScanner(true);
  scanner.setText(text);

  const tokens: Token[] = [];
  const tts = tokenToString as (k: number) => string | undefined;
  let previousEnd = 0;

  for (;;) {
    let kind = scanner.scan();
    if (kind === undefined || kind === 1 /* EndOfFile */) break;

    if (kind === KIND.SlashToken) {
      const previous = tokens[tokens.length - 1];
      const continuation = previous ? EXPRESSION_CONTINUATION_KINDS.has(previous.kind) : false;
      if (!continuation) {
        kind = scanner.reScanSlashToken();
      }
    }

    tokens.push({
      kind,
      value: isValueBearingKind(kind) ? scanner.getTokenValue() : '',
      text: tts(kind),
      newlineBefore: scanner.hasPrecedingLineBreak()
    });

    const end = scanner.getTokenEnd();
    if (end <= previousEnd) break;
    previousEnd = end;
    if (tokens.length >= MAX_TOKENS_PER_FILE) break;
  }
  return tokens;
}

function extractModuleSpecifiers(tokens: readonly Token[]): string[] {
  const specifiers: string[] = [];

  const isString = (tok: Token | undefined): tok is Token =>
    tok !== undefined && tok.kind === KIND.StringLiteral;

  const headerWindowEnd = (start: number): number => {
    let braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    const limit = Math.min(start + MAX_HEADER_WINDOW_TOKENS, tokens.length);
    let cursor = start;
    while (cursor < limit) {
      const tok = tokens[cursor];
      if (tok === undefined) break;
      const balanced = braceDepth <= 0 && parenDepth <= 0 && bracketDepth <= 0;
      if (balanced && (tok.newlineBefore || tok.kind === KIND.Semicolon)) break;

      switch (tok.kind) {
        case KIND.OpenBrace:
          braceDepth++;
          break;
        case KIND.CloseBrace:
          braceDepth--;
          break;
        case KIND.OpenParen:
          parenDepth++;
          break;
        case KIND.CloseParen:
          parenDepth--;
          break;
        case KIND.OpenBracket:
          bracketDepth++;
          break;
        case KIND.CloseBracket:
          bracketDepth--;
          break;
        case KIND.Semicolon:
          return cursor;
        default:
          break;
      }
      cursor++;
    }
    return cursor;
  };

  const findFromSpecifier = (start: number, end: number): string | undefined => {
    for (let i = start; i < end - 1; i++) {
      const tok = tokens[i];
      if (tok?.text === 'from' && isString(tokens[i + 1])) {
        const value = tokens[i + 1]?.value ?? '';
        if (value.length > 0) return value;
      }
    }
    return undefined;
  };

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === undefined) break;

    if (tok.kind === KIND.ImportKeyword) {
      const t1 = tokens[i + 1];

      if (t1 !== undefined && t1.kind === KIND.OpenParen) {
        const candidate = tokens[i + 2];
        if (isString(candidate) && candidate.value.length > 0) {
          specifiers.push(candidate.value);
        }
        i += 3;
        continue;
      }

      if (isString(t1)) {
        if (t1.value.length > 0) specifiers.push(t1.value);
        i += 2;
        continue;
      }

      const end = headerWindowEnd(i + 1);
      const specifier = findFromSpecifier(i + 1, end);
      if (specifier !== undefined) specifiers.push(specifier);
      i = Math.max(end, i + 1);
      continue;
    }

    if (tok.kind === KIND.ExportKeyword) {
      const end = headerWindowEnd(i + 1);
      const specifier = findFromSpecifier(i + 1, end);
      if (specifier !== undefined) specifiers.push(specifier);
      i = Math.max(end, i + 1);
      continue;
    }

    i++;
  }
  return specifiers;
}

function isInternalSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function joinRelative(fromDirRel: string, specifierTail: string): string | undefined {
  const segments: string[] = [];
  for (const part of `${fromDirRel}/${specifierTail}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.pop() === undefined) return undefined;
      continue;
    }
    segments.push(part);
  }
  return segments.join('/');
}

function specifierCandidates(joinedNoRoot: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (path: string): void => {
    if (!seen.has(path)) {
      seen.add(path);
      candidates.push(path);
    }
  };

  const dot = joinedNoRoot.lastIndexOf('.');
  const slash = joinedNoRoot.lastIndexOf('/');
  const ext = dot > slash ? joinedNoRoot.slice(dot) : '';
  const stem = ext.length > 0 ? joinedNoRoot.slice(0, -ext.length) : joinedNoRoot;
  const isSourceExt = (SOURCE_EXTENSIONS as readonly string[]).includes(ext);

  if (isSourceExt) push(joinedNoRoot);
  for (const candidateExt of SOURCE_EXTENSIONS) push(stem + candidateExt);
  for (const dirPart of new Set([joinedNoRoot, stem])) {
    for (const candidateExt of SOURCE_EXTENSIONS) push(`${dirPart}/index${candidateExt}`);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Directory walk
// ---------------------------------------------------------------------------

interface WalkedFile {
  relPath: string;
  extension: SourceExtension;
}

async function walkSourceFiles(rootAbs: string, gitignore: GitignoreMatcher): Promise<WalkedFile[]> {
  const found: WalkedFile[] = [];

  const visit = async (dirRel: string): Promise<void> => {
    const absDir = dirRel.length === 0 ? rootAbs : `${rootAbs}/${dirRel}`;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const childRel = dirRel.length === 0 ? entry.name : `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        if (gitignore.isIgnored(childRel, true)) continue;
        await visit(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (gitignore.isIgnored(childRel, false)) continue;

      const dot = childRel.lastIndexOf('.');
      const rawExt = dot > childRel.lastIndexOf('/') ? childRel.slice(dot) : '';
      const ext = (SOURCE_EXTENSIONS as readonly string[]).includes(rawExt)
        ? (rawExt as SourceExtension)
        : undefined;
      if (ext !== undefined) {
        found.push({ relPath: childRel, extension: ext });
      }
    }
  };

  await visit('');
  found.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return found;
}

// ---------------------------------------------------------------------------
// The incremental engine
// ---------------------------------------------------------------------------

export class IncrementalGraph {
  private readonly rootAbs: string;
  private gitignore: GitignoreMatcher | null = null;
  private nodes = new Map<string, ModuleNode>();
  private edges = new Map<string, Edge>();
  /** file id → internal import specifiers from its last parse (the parse cache). */
  private specifiers = new Map<string, string[]>();
  /** Materialized on first read after a structural change; shared with readers. */
  private cachedSnapshot: GraphSnapshot | null = null;

  constructor(rootPath: string) {
    this.rootAbs = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  }

  /** Parse a single file's internal import specifiers (the only content reads). */
  async parseSpecifiers(relPath: string): Promise<string[]> {
    const text = await readFile(`${this.rootAbs}/${relPath}`, 'utf8');
    return extractModuleSpecifiers(tokenize(text)).filter(isInternalSpecifier);
  }

  /** Full rebuild: walks the tree and (re)parses every file. The baseline path. */
  async fullScan(): Promise<void> {
    assertScannerContract();
    this.gitignore = await loadGitignore(this.rootAbs);
    const files = await walkSourceFiles(this.rootAbs, this.gitignore);

    const nodes = new Map<string, ModuleNode>();
    const specifiers = new Map<string, string[]>();
    for (const file of files) {
      nodes.set(file.relPath, freshNode(file.relPath, file.extension));
      try {
        specifiers.set(file.relPath, await this.parseSpecifiers(file.relPath));
      } catch {
        specifiers.set(file.relPath, []); // unreadable at scan time: node stays, edges skipped
      }
    }
    this.nodes = nodes;
    this.specifiers = specifiers;
    this.edges = this.resolveAllEdges();
    this.cachedSnapshot = null;
  }

  /**
   * Apply one debounce window of watcher events and return the NET graph
   * delta (state before the window vs after). Only the touched files are
   * re-parsed; the node set is re-synced with the disk via a content-free
   * directory walk, and edges are recomputed from cached specifiers (pure
   * string ops).
   *
   * Atomicity: the plan phase does all I/O first — a thrown error (e.g. the
   * lexer blowing up) leaves the state untouched so the caller can keep the
   * last good frame and raise a scan_error notice (ticket-04 semantics).
   * Events are collapsed to the last event per path: a file created and
   * deleted inside one window parses zero times.
   */
  async applyEvents(events: readonly WatchedFileEvent[]): Promise<GraphDelta> {
    assertScannerContract();
    if (!this.gitignore) await this.fullScan();

    const beforeNodeIds = new Set(this.nodes.keys());
    const beforeEdges = new Map(this.edges);

    // ---- plan phase (I/O only; throws leave the state untouched) ----
    const walked = await walkSourceFiles(this.rootAbs, this.gitignore!);
    const walkedIds = new Set(walked.map((f) => f.relPath));

    const lastEventByPath = new Map<string, WatchedFileEvent>();
    for (const ev of events) {
      const rel = this.toRel(ev.path);
      if (rel === null) continue;
      lastEventByPath.set(rel, { path: rel, kind: ev.kind });
    }

    const plan = new Map<string, string[]>(); // rel → fresh specifiers
    const absent = new Set<string>(); // rel → gone from disk
    for (const [rel, ev] of lastEventByPath) {
      if (ev.kind === 'unlink' || !walkedIds.has(rel)) {
        absent.add(rel);
        continue;
      }
      if (extensionOf(rel) === undefined) continue;
      try {
        plan.set(rel, await this.parseSpecifiers(rel));
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') absent.add(rel);
        else throw err;
      }
    }

    // ---- mutate phase (deterministic; content I/O only for catch-ups) ----
    for (const [rel, specs] of plan) {
      if (!this.nodes.has(rel)) {
        const ext = extensionOf(rel);
        if (ext !== undefined) this.nodes.set(rel, freshNode(rel, ext));
      }
      this.specifiers.set(rel, specs);
    }
    for (const rel of absent) {
      this.specifiers.delete(rel);
      this.nodes.delete(rel);
    }
    // Node-set sync + catch-up parses for anything the watcher missed
    // (normally an empty set; anomalies get the tolerant "node stays,
    // edges skipped" treatment).
    for (const file of walked) {
      if (!this.nodes.has(file.relPath)) {
        this.nodes.set(file.relPath, freshNode(file.relPath, file.extension));
      }
      if (!this.specifiers.has(file.relPath)) {
        try {
          this.specifiers.set(file.relPath, await this.parseSpecifiers(file.relPath));
        } catch {
          this.specifiers.set(file.relPath, []);
        }
      }
    }
    for (const id of [...this.nodes.keys()]) {
      if (!walkedIds.has(id)) {
        this.nodes.delete(id);
        this.specifiers.delete(id);
      }
    }

    // ---- recompute edges from caches (pure resolution, no file reads) ----
    this.edges = this.resolveAllEdges();
    this.cachedSnapshot = null;

    return diff(beforeNodeIds, beforeEdges, this.nodes, this.edges);
  }

  /**
   * Point-in-time view of the graph. Cached: the expensive sort runs once per
   * structural change, not per reader. Aliasing is the contract, not an
   * accident — the cached snapshot shares NODE objects with the engine, so
   * field-level updates made through node()/setNote() (test states, type
   * badges, notes) are visible to existing readers immediately; only the
   * engine's own structural mutations (fullScan/applyEvents) invalidate.
   */
  snapshot(): GraphSnapshot {
    if (this.cachedSnapshot === null) {
      const nodes = [...this.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const edges = [...this.edges.values()].sort((a, b) =>
        a.from === b.from ? (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) : a.from < b.from ? -1 : 1
      );
      this.cachedSnapshot = {
        rootPath: this.rootAbs,
        generatedAt: Date.now(),
        nodes,
        edges
      };
    }
    return this.cachedSnapshot;
  }

  /** Shared lookup+mutate of one node; false for an unknown id. */
  private mutateNode(id: string, mutate: (node: ModuleNode) => void): boolean {
    const node = this.nodes.get(id);
    if (node === undefined) return false;
    mutate(node);
    return true;
  }

  /** Attach/clear the note on one node. Returns false for an unknown id. */
  setNote(id: string, note: string | undefined): boolean {
    return this.mutateNode(id, (node) => {
      node.note = note;
    });
  }

  /**
   * Ticket 12: attach/clear the AI review state on one node. Same aliasing
   * contract as setNote: the cached snapshot shares NODE objects, so the
   * mutation is visible to existing readers immediately. In-memory only —
   * fullScan/applyEvents rebuild nodes without a review and the agent
   * re-reports (begin_review/end_review) as needed.
   */
  setReview(id: string, review: AiReview | undefined): boolean {
    return this.mutateNode(id, (node) => {
      node.aiReview = review;
    });
  }

  /** Mutable access for state-injection layers (coverage/typecheck wiring). */
  node(id: string): ModuleNode | undefined {
    return this.nodes.get(id);
  }

  /** Current file list (sorted, root-relative) for the state layers. */
  nodeIds(): string[] {
    return [...this.nodes.keys()].sort();
  }

  private resolveAllEdges(): Map<string, Edge> {
    const edges = new Map<string, Edge>();
    for (const [from, rawSpecifiers] of this.specifiers) {
      if (!this.nodes.has(from)) continue;
      const fromDir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
      for (const raw of rawSpecifiers) {
        const joined = joinRelative(fromDir, raw);
        if (joined === undefined) continue;
        // Candidate order is mandated (real ext → extension remap → index);
        // the first candidate that names a known node wins.
        for (const candidate of specifierCandidates(joined)) {
          if (this.nodes.has(candidate)) {
            const key = `${from}\u0000${candidate}`;
            if (!edges.has(key)) edges.set(key, { from, to: candidate });
            break;
          }
        }
      }
    }
    return edges;
  }

  private toRel(path: string): string | null {
    const norm = path.replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm.startsWith(this.rootAbs + '/')) return norm.slice(this.rootAbs.length + 1);
    if (!norm.includes('/') && !norm.startsWith('.')) return norm; // already relative
    return null;
  }
}

/** Extension of a root-relative path, or undefined for non-source files. */
function extensionOf(relPath: string): SourceExtension | undefined {
  const dot = relPath.lastIndexOf('.');
  const slash = relPath.lastIndexOf('/');
  const rawExt = dot > slash ? relPath.slice(dot) : '';
  return (SOURCE_EXTENSIONS as readonly string[]).includes(rawExt)
    ? (rawExt as SourceExtension)
    : undefined;
}

function freshNode(id: string, ext: SourceExtension): ModuleNode {
  return {
    id,
    path: id,
    language: LANGUAGE_BY_EXTENSION[ext],
    testState: 'untested',
    coveredBy: [],
    typeErrors: []
  };
}

function diff(
  beforeNodeIds: Set<string>,
  beforeEdges: Map<string, Edge>,
  afterNodes: Map<string, ModuleNode>,
  afterEdges: Map<string, Edge>
): GraphDelta {
  const addedNodes: ModuleNode[] = [];
  const removedNodeIds: string[] = [];
  const addedEdges: Edge[] = [];
  const removedEdges: Edge[] = [];

  for (const [id, node] of afterNodes) {
    if (!beforeNodeIds.has(id)) addedNodes.push(node);
  }
  for (const id of beforeNodeIds) {
    if (!afterNodes.has(id)) removedNodeIds.push(id);
  }
  for (const [key, edge] of afterEdges) {
    if (!beforeEdges.has(key)) addedEdges.push(edge);
  }
  for (const [key, edge] of beforeEdges) {
    if (!afterEdges.has(key)) removedEdges.push(edge);
  }

  // Deterministic order (by id / by from→to) — deltas cross the wire and
  // tests, so both sides see a stable shape.
  addedNodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  removedNodeIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const byEdge = (a: Edge, b: Edge): number =>
    a.from === b.from ? (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) : a.from < b.from ? -1 : 1;
  addedEdges.sort(byEdge);
  removedEdges.sort(byEdge);

  return { addedNodes, removedNodeIds, addedEdges, removedEdges };
}
