import { describe, expect, it } from 'vitest';
import { shouldAutoOpen } from '../src/server/open-browser.js';

/**
 * Code-review 2026-08-29: auto-open policy. An MCP client spawns one server
 * process per session, so opening unconditionally produced a browser tab per
 * new session. Only the first instance of a root opens the dashboard; the
 * decision is a pure function so every branch is pinned here.
 */
describe('shouldAutoOpen (same-root dedup)', () => {
  const root = '/repo';

  it('opens when the preferred port was free (first instance)', () => {
    expect(shouldAutoOpen({ noOpen: false, forceOpen: false, portBumped: false, primaryRoot: null, rootPath: root })).toBe(
      true
    );
  });

  it('--no-open overrides everything, including --open', () => {
    expect(shouldAutoOpen({ noOpen: true, forceOpen: true, portBumped: false, primaryRoot: null, rootPath: root })).toBe(
      false
    );
  });

  it('stays headless when the preferred port belongs to the same root', () => {
    expect(shouldAutoOpen({ noOpen: false, forceOpen: false, portBumped: true, primaryRoot: root, rootPath: root })).toBe(
      false
    );
  });

  it('opens its own tab when the preferred port belongs to a different root', () => {
    expect(
      shouldAutoOpen({ noOpen: false, forceOpen: false, portBumped: true, primaryRoot: '/other', rootPath: root })
    ).toBe(true);
  });

  it('opens when the preferred-port owner could not be identified (foreign process / probe failure)', () => {
    expect(shouldAutoOpen({ noOpen: false, forceOpen: false, portBumped: true, primaryRoot: null, rootPath: root })).toBe(
      true
    );
  });

  it('--open forces a tab even for a same-root secondary', () => {
    expect(shouldAutoOpen({ noOpen: false, forceOpen: true, portBumped: true, primaryRoot: root, rootPath: root })).toBe(
      true
    );
  });
});
