import { describe, expect, it } from 'vitest';
import { browserCandidates, shouldAutoOpen, shouldPopFile } from '../src/server/open-browser.js';

const DASHBOARD_URL = 'http://127.0.0.1:24282';

/**
 * Code-review 2026-08-29: popup policy. A desktop client spawns one server
 * process per project at app open, so popping at startup produced N tabs
 * before the user touched anything; a per-session process popped one tab per
 * new session. shouldAutoOpen only ARMS an instance (index.ts executes the
 * popup on the first real activity). Within one root exactly one instance
 * arms: the preferred-port holder, or a bumped instance whose band walk found
 * no same-root holder. The decision is a pure function so every branch is
 * pinned here.
 */
describe('shouldAutoOpen (armed popup policy)', () => {
  it('arms the preferred-port holder (first instance of a root)', () => {
    expect(shouldAutoOpen({ noOpen: false, forceOpen: false, portBumped: false, sameRootHolder: false })).toBe(true);
  });

  it('--no-open overrides everything, including --open', () => {
    expect(shouldAutoOpen({ noOpen: true, forceOpen: true, portBumped: false, sameRootHolder: false })).toBe(false);
  });

  it('stays headless when the band walk found a same-root instance', () => {
    expect(shouldAutoOpen({ noOpen: false, forceOpen: false, portBumped: true, sameRootHolder: true })).toBe(false);
  });

  it('arms a bumped instance when the band holds only closed ports / foreign roots', () => {
    expect(shouldAutoOpen({ noOpen: false, forceOpen: false, portBumped: true, sameRootHolder: false })).toBe(true);
  });

  it('--open forces a tab even for a same-root secondary', () => {
    expect(shouldAutoOpen({ noOpen: false, forceOpen: true, portBumped: true, sameRootHolder: true })).toBe(true);
  });
});

/**
 * Code-review 2026-08-31: minimal WSLg installs ship neither wslview nor
 * xdg-utils, so the old two-candidate Linux chain died on ENOENT and no tab
 * ever appeared. The chain is a pure function so every branch — including the
 * mandatory empty-title arg of `cmd.exe start` — is pinned here without
 * spawning anything.
 */
describe('browserCandidates (launcher fallback chain)', () => {
  it('win32: cmd.exe start keeps the empty title arg (start eats a quoted first arg)', () => {
    expect(browserCandidates('win32', false, DASHBOARD_URL)).toEqual([
      ['cmd.exe', ['/c', 'start', '', DASHBOARD_URL]]
    ]);
  });

  it('darwin: plain open', () => {
    expect(browserCandidates('darwin', false, DASHBOARD_URL)).toEqual([['open', [DASHBOARD_URL]]]);
  });

  it('linux without WSL: wslview → xdg-open → gio open, no cmd.exe', () => {
    expect(browserCandidates('linux', false, DASHBOARD_URL)).toEqual([
      ['wslview', [DASHBOARD_URL]],
      ['xdg-open', [DASHBOARD_URL]],
      ['gio', ['open', DASHBOARD_URL]]
    ]);
  });

  it('WSL inserts cmd.exe right after wslview (Windows default browser does not need wslu)', () => {
    expect(browserCandidates('linux', true, DASHBOARD_URL)).toEqual([
      ['wslview', [DASHBOARD_URL]],
      ['cmd.exe', ['/c', 'start', '', DASHBOARD_URL]],
      ['xdg-open', [DASHBOARD_URL]],
      ['gio', ['open', DASHBOARD_URL]]
    ]);
  });
});

/**
 * Code-review 2026-08-31: once launchers actually worked, one session reading
 * N files stacked N identical tabs. A connected dashboard page means the user
 * can already see the project, so popping stops until that tab closes.
 */
describe('shouldPopFile (page-connected popup rhythm)', () => {
  it('pops while armed, unseen, and no page is connected', () => {
    expect(shouldPopFile({ armed: true, alreadyPopped: false, pageConnected: false })).toBe(true);
  });

  it('a disarmed instance never pops', () => {
    expect(shouldPopFile({ armed: false, alreadyPopped: false, pageConnected: false })).toBe(false);
  });

  it('each file pops at most once per process', () => {
    expect(shouldPopFile({ armed: true, alreadyPopped: true, pageConnected: false })).toBe(false);
  });

  it('a live dashboard tab silences further pops', () => {
    expect(shouldPopFile({ armed: true, alreadyPopped: false, pageConnected: true })).toBe(false);
  });
});
