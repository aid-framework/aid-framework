/**
 * Pins the retry policy that makes a post-deploy version check usable.
 *
 * The check exists because a green build says nothing about what the CDN is serving. That
 * makes the wait policy load-bearing: too impatient and every deploy reports a failure it
 * did not have, too patient and a real mismatch is reported ten minutes late. Each case
 * here drives `waitForVersion` with a fake clock and a fake network, so the assertions are
 * about the policy rather than about GitHub's response times.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_DELAYS_MS, versionsIn, waitForVersion } from './check-live-version.mjs';

/** @param {string} version */
const page = (version) => `<footer>Latest release ${version} · Apache-2.0</footer>`;

/**
 * @param {(string | number | Error)[]} outcomes each attempt yields a body, an HTTP status, or a thrown error
 * @returns {{ fetchImpl: typeof fetch, calls: number[] }}
 */
function network(outcomes) {
  /** @type {number[]} */
  const calls = [];
  const fetchImpl = async () => {
    calls.push(calls.length + 1);
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === 'number') return { ok: false, status: outcome, text: async () => '' };
    return { ok: true, status: 200, text: async () => outcome ?? '' };
  };
  return { fetchImpl: /** @type {typeof fetch} */ (fetchImpl), calls };
}

/** @param {{ slept: number[] }} state */
function clock(state) {
  return async (ms) => {
    state.slept.push(ms);
  };
}

const quiet = () => {};

describe('versionsIn', () => {
  it('lists every version on the page once, in order', () => {
    expect(versionsIn(page('v0.1.168'))).toEqual(['v0.1.168']);
    expect(versionsIn('<p>v0.1.167 then v0.1.168 then v0.1.167</p>')).toEqual([
      'v0.1.167',
      'v0.1.168',
    ]);
  });

  it('finds nothing in a page that names no version', () => {
    expect(versionsIn('<footer>Latest release</footer>')).toEqual([]);
  });
});

describe('waitForVersion', () => {
  it('accepts a page that already carries the declared version, without waiting', async () => {
    const { fetchImpl, calls } = network([page('v0.1.168')]);
    const state = { slept: [] };

    const result = await waitForVersion({
      expected: 'v0.1.168',
      fetchImpl,
      sleep: clock(state),
      log: quiet,
    });

    expect(result).toEqual({ ok: true, attempts: 1, versions: ['v0.1.168'] });
    expect(calls).toHaveLength(1);
    expect(state.slept).toEqual([]);
  });

  it('retries a stale page and succeeds once the deploy becomes visible', async () => {
    const { fetchImpl, calls } = network([page('v0.1.167'), page('v0.1.167'), page('v0.1.168')]);
    const state = { slept: [] };

    const result = await waitForVersion({
      expected: 'v0.1.168',
      fetchImpl,
      sleep: clock(state),
      log: quiet,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(calls).toHaveLength(3);
    // The waits are the first two of the published policy, in order: the CDN window is the
    // only reason to wait at all, so the delays must not be shortened by the retry loop.
    expect(state.slept).toEqual(DEFAULT_DELAYS_MS.slice(0, 2));
  });

  it('keeps retrying through HTTP failures and connection errors', async () => {
    const { fetchImpl } = network([503, new Error('ECONNRESET'), page('v0.1.168')]);
    const state = { slept: [] };

    const result = await waitForVersion({
      expected: 'v0.1.168',
      fetchImpl,
      sleep: clock(state),
      log: quiet,
    });

    expect(result).toMatchObject({ ok: true, attempts: 3 });
    expect(state.slept).toHaveLength(2);
  });

  it('fails after the final attempt and reports every version it saw', async () => {
    const { fetchImpl, calls } = network([
      page('v0.1.166'),
      page('v0.1.167'),
      page('v0.1.167'),
      page('v0.1.167'),
      page('v0.1.167'),
      page('v0.1.167'),
      page('v0.1.167'),
    ]);
    const state = { slept: [] };

    const result = await waitForVersion({
      expected: 'v0.1.168',
      fetchImpl,
      sleep: clock(state),
      log: quiet,
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(DEFAULT_DELAYS_MS.length + 1);
    expect(result.versions).toEqual(['v0.1.166', 'v0.1.167']);
    // One attempt more than there are delays, and no trailing wait after the last attempt.
    expect(calls).toHaveLength(DEFAULT_DELAYS_MS.length + 1);
    expect(state.slept).toEqual(DEFAULT_DELAYS_MS);
  });

  it('never passes a page that carries no version at all', async () => {
    const { fetchImpl } = network(Array.from({ length: 7 }, () => '<p>maintenance</p>'));

    const result = await waitForVersion({
      expected: 'v0.1.168',
      fetchImpl,
      sleep: clock({ slept: [] }),
      log: quiet,
    });

    expect(result.ok).toBe(false);
    expect(result.versions).toEqual([]);
  });
});
