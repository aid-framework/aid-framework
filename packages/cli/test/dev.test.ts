/**
 * `aid dev` compiles the spec and then hands the terminal to the application's own server,
 * so what is asserted here is the handoff: which argv gets spawned, what happens when the
 * project cannot serve at all, and which of those failures are about the invocation (2)
 * rather than about the project (1).
 *
 * **Why the port is checked before anything else that could go wrong.** A port that is not
 * a port is a typing mistake, and a reader who is told "no interpreter can import uvicorn"
 * while `--port 99999` sits on their command line will go install uvicorn. The tests pin
 * the precedence, not merely the message.
 *
 * **Why `ts-vercel` is asserted to refuse.** That target emits handlers for a platform that
 * supplies the server. A `dev` that quietly invented a Node server for it would be a second
 * way to run the app, drifting from the first -- so the refusal is the correct behaviour and
 * has to stay a refusal.
 *
 * **Why nothing runs Python.** The spawn is injected and answers as if the interpreter were
 * present. The real wiring is exercised by the E2E job, which runs the example application;
 * a unit test that imported uvicorn twice would be a slower copy of that.
 */

import { afterAll, describe, expect, it } from 'vitest';

import type { Spawn } from '../src/index.js';
import type { Run } from './helpers.js';
import { aid, project, recordingSpawn } from './helpers.js';

const created: ReturnType<typeof project>[] = [];

function scratch() {
  const made = project();
  created.push(made);
  return made;
}

/** A project with an application entry point already in place, so only the server is missing. */
function withEntry() {
  const made = scratch();
  made.write('app/main.py', 'from fastapi import FastAPI\n\napp = FastAPI()\n');
  return made;
}

afterAll(() => {
  for (const made of created) made.close();
});

const SUMMARY = 'regenerate the tree and run the application on a local server';

function expectUsageError(run: Run): void {
  expect(run.code).toBe(2);
  expect(run.stderr).not.toMatch(/unknown command/);
}

describe('aid dev -- the command exists', () => {
  it('lists dev as a row with its summary, on stdout', () => {
    const run = aid(scratch(), []);
    expect(run.code).toBe(2);
    expect(run.stdout).toMatch(new RegExp(`^\\s*dev\\s{2,}${SUMMARY}\\s*$`, 'm'));
    expect(run.stderr).toBe('');
  });

  it('documents its own flags when asked for help', () => {
    const run = aid(scratch(), ['dev', '--help']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage: aid dev');
    expect(run.stdout).toContain('--port');
    expect(run.stdout).toContain('--no-gen');
    expect(run.stdout).toContain('--no-reload');
  });

  it('refuses --json, which a running server cannot produce', () => {
    // A JSON document is a verdict about a finished run; `dev` streams a child's output for
    // an unbounded time. Accepting the flag would mean emitting something unparseable.
    const run = aid(withEntry(), ['dev', '--no-gen', '--json']);
    expectUsageError(run);
    expect(run.stderr).toContain('unknown option `--json`');
  });
});

describe('aid dev -- usage errors, before the project is touched', () => {
  it('rejects a port that is not a port', () => {
    const spawn = recordingSpawn();
    const run = aid(withEntry(), ['dev', '--no-gen', '--port', 'eighty'], spawn);
    expectUsageError(run);
    expect(run.stderr).toContain('[cli/dev-port-invalid]');
    expect(spawn.calls).toHaveLength(0);
  });

  it('rejects a port outside 1-65535', () => {
    const run = aid(withEntry(), ['dev', '--no-gen', '--port', '70000']);
    expectUsageError(run);
    expect(run.stderr).toContain('[cli/dev-port-invalid]');
  });

  it('rejects an unknown target', () => {
    const spawn = recordingSpawn();
    const run = aid(withEntry(), ['dev', '--no-gen', '--target', 'nonesuch'], spawn);
    expectUsageError(run);
    expect(run.stderr).toContain('[cli/unknown-target]');
    expect(spawn.calls).toHaveLength(0);
  });

  it('checks the port before the interpreter', () => {
    // Both are wrong; the port is the thing the reader can fix immediately.
    const run = aid(
      withEntry(),
      ['dev', '--no-gen', '--port', '0'],
      recordingSpawn({ probeStatus: null }),
    );
    expect(run.stderr).toContain('[cli/dev-port-invalid]');
    expect(run.stderr).not.toContain('[cli/dev-uvicorn-missing]');
  });
});

describe('aid dev -- targets that cannot be served', () => {
  it('refuses ts-vercel with the reason, as a usage error', () => {
    const spawn = recordingSpawn();
    const run = aid(withEntry(), ['dev', '--no-gen', '--target', 'ts-vercel'], spawn);
    expectUsageError(run);
    expect(run.stderr).toContain('[cli/runner-unsupported]');
    expect(run.stderr).toContain('ts-vercel');
    expect(run.stderr).toContain('Next');
    expect(spawn.calls).toHaveLength(0);
  });
});

describe('aid dev -- the project cannot serve', () => {
  it('reports a missing entry point as a failure, naming the file', () => {
    const run = aid(scratch(), ['dev', '--no-gen']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('[cli/dev-entry-missing]');
    expect(run.stderr).toContain('app/main.py');
  });

  it('reports a missing interpreter that can import uvicorn as a usage error', () => {
    const spawn = recordingSpawn({ probeStatus: null });
    const run = aid(withEntry(), ['dev', '--no-gen'], spawn);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('[cli/dev-uvicorn-missing]');
    // All three candidates were tried, and none was started as a server.
    expect(spawn.calls).toHaveLength(3);
    expect(spawn.calls.every((call) => call.args.includes('-c'))).toBe(true);
  });
});

describe('aid dev -- starting the application', () => {
  it('spawns uvicorn as a module, on loopback, with reload on by default', () => {
    const spawn = recordingSpawn();
    const run = aid(withEntry(), ['dev', '--no-gen'], spawn);

    expect(run.code).toBe(0);
    const server = spawn.calls.at(-1);
    expect(server?.command).toBe('python3');
    expect(server?.args).toEqual([
      '-m',
      'uvicorn',
      'app.main:app',
      '--host',
      '127.0.0.1',
      '--port',
      '8000',
      '--reload',
    ]);
  });

  it('prints the address before the server starts, not after it stops', () => {
    const run = aid(withEntry(), ['dev', '--no-gen'], recordingSpawn());
    const banner = run.stdout.indexOf('http://127.0.0.1:8000');
    const farewell = run.stdout.indexOf('server stopped.');
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(farewell).toBeGreaterThan(banner);
  });

  it('honours --port and --no-reload', () => {
    const spawn = recordingSpawn();
    const run = aid(withEntry(), ['dev', '--no-gen', '--port', '9100', '--no-reload'], spawn);
    expect(run.code).toBe(0);
    const server = spawn.calls.at(-1);
    expect(server?.args).toContain('9100');
    expect(server?.args).not.toContain('--reload');
  });

  it('regenerates the tree by default', () => {
    const made = withEntry();
    const run = aid(made, ['dev'], recordingSpawn());
    expect(run.code).toBe(0);
    expect(made.exists('app/aid.manifest.json')).toBe(true);
  });

  it('serves the tree as it is with --no-gen', () => {
    const made = withEntry();
    const run = aid(made, ['dev', '--no-gen'], recordingSpawn());
    expect(run.code).toBe(0);
    expect(made.exists('app/aid.manifest.json')).toBe(false);
  });

  it('does not start the server when generation fails', () => {
    const made = scratch();
    made.setSpec('name: not a spec\n');
    const spawn = recordingSpawn();
    const run = aid(made, ['dev'], spawn);

    expect(run.code).toBe(1);
    expect(spawn.calls).toHaveLength(0);
    expect(run.stdout).not.toContain('http://127.0.0.1');
  });

  it('fails with the server status when the server exits non-zero', () => {
    const run = aid(withEntry(), ['dev', '--no-gen'], recordingSpawn({ status: 3 }));
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('[cli/runner-failed]');
    expect(run.stderr).toContain('status 3');
  });

  it('treats a signal-terminated server as a clean stop', () => {
    // Ctrl-C ends the child with a signal, which `spawnSync` reports as a null status with
    // no `error`. Reporting that as a failure would make stopping the dev server look like
    // the server broke.
    const spawn: Spawn = (_command, args) =>
      args.includes('-c')
        ? { status: 0, stdout: '', stderr: '' }
        : { status: null, stdout: '', stderr: '' };

    const run = aid(withEntry(), ['dev', '--no-gen'], spawn);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('server stopped.');
    expect(run.stderr).not.toContain('[cli/runner-failed]');
  });

  it('reports a binary that could not be executed at all', () => {
    const spawn: Spawn = (_command, args) =>
      args.includes('-c')
        ? { status: 0, stdout: '', stderr: '' }
        : { status: null, stdout: '', stderr: '', error: new Error('not there') };

    const run = aid(withEntry(), ['dev', '--no-gen'], spawn);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('[cli/runner-failed]');
  });
});
