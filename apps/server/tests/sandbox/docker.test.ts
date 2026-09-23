import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
    // create() runs `docker run` via execFileSync and polls readiness via
    // execFile (promisified). Stub both so create() can be exercised without a
    // real docker daemon.
    execFileSync: vi.fn().mockReturnValue("container-xyz\n"),
    execFile: vi.fn((_cmd: string, _args: string[], opts: unknown, cb?: unknown) => {
      const done = (typeof opts === "function" ? opts : cb) as (e: unknown, r: unknown) => void;
      done(null, { stdout: "", stderr: "" });
    }),
  };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: vi.fn().mockReturnValue(true), readFileSync: vi.fn().mockReturnValue("{}") };
});

// docker.ts now logs via the pino LoggerPort instead of console — mock the
// logger module so the suite's stderr stays free of real pino JSON. `warn` is
// a hoisted spy so the credential-store tests can read what was logged.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

import { spawn, execFileSync } from "child_process";
import { DockerSandbox } from "#src/sandbox/docker.js";

const mockSpawn = vi.mocked(spawn);
const mockExecFileSync = vi.mocked(execFileSync);

function makeFakeChild() {
  const stdin = { write: vi.fn(), end: vi.fn() };
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: vi.fn() });
  return child as unknown as ReturnType<typeof spawn> & {
    stdin: typeof stdin;
    stdout: typeof stdout;
    stderr: typeof stderr;
  };
}

describe("DockerSandbox.runAgent — prompt via stdin, not shell arg", () => {
  // Both budgets are resolved from config by the orchestrator (issue #385) —
  // the driver has no default of its own, so every call supplies them.
  const RUN = { timeoutSeconds: 5, gateTimeoutSeconds: 900 };
  let manager: DockerSandbox;
  let fakeChild: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeChild = makeFakeChild();
    mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

    manager = new DockerSandbox({
      imageName: "test-image",
      env: {},
    });
    (manager as unknown as { activeContainers: Map<string, unknown> })
      .activeContainers.set("task-001", {
        containerId: "abc123",
        containerName: "test-container",
        worktreePath: "/tmp/work",
      });
  });

  it("spawn is called with stdin: 'pipe'", async () => {
    const runPromise = manager.runAgent("task-001", "hello world", RUN);
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;

    const spawnOpts = mockSpawn.mock.calls[0][2] as { stdio: unknown[] };
    expect(spawnOpts.stdio[0]).toBe("pipe");
  });

  it("prompt is written to child.stdin", async () => {
    const prompt = "Do something dangerous'; rm -rf /; echo '";
    const runPromise = manager.runAgent("task-001", prompt, RUN);
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;

    expect(fakeChild.stdin.write).toHaveBeenCalledWith(prompt);
    expect(fakeChild.stdin.end).toHaveBeenCalled();
  });

  it("prompt is not embedded in the docker exec args", async () => {
    const prompt = "secret'; rm -rf /;'";
    const runPromise = manager.runAgent("task-001", prompt, RUN);
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;

    const dockerArgs = (mockSpawn.mock.calls[0][1] as string[]).join(" ");
    expect(dockerArgs).not.toContain(prompt);
    expect(dockerArgs).not.toContain("rm -rf");
  });

  it("docker exec args contain -i flag for stdin", async () => {
    const runPromise = manager.runAgent("task-001", "test prompt", RUN);
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;

    const dockerArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(dockerArgs).toContain("-i");
  });

  it("agentic-pi command runs in --sandbox none mode and does not embed the prompt", async () => {
    const runPromise = manager.runAgent("task-001", "test prompt", RUN);
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;

    const dockerArgs = mockSpawn.mock.calls[0][1] as string[];
    const shCmd = dockerArgs[dockerArgs.length - 1];
    expect(shCmd).toContain("agentic-pi run");
    expect(shCmd).toContain("--sandbox none");
    expect(shCmd).not.toContain("--no-file-search");
    expect(shCmd).not.toContain("test prompt");
  });

  it("forwards git-identity sandboxEnv via docker exec -e (reaches the agent's git)", async () => {
    const sandboxEnv = {
      GIT_AUTHOR_NAME: "nearform-lastlight[bot]",
      GIT_AUTHOR_EMAIL: "nearform-lastlight[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "nearform-lastlight[bot]",
      GIT_COMMITTER_EMAIL: "nearform-lastlight[bot]@users.noreply.github.com",
    };
    const runPromise = manager.runAgent("task-001", "test prompt", { ...RUN, sandboxEnv });
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;

    const dockerArgs = mockSpawn.mock.calls[0][1] as string[];
    // Real `-e KEY=VALUE` argv flags — the only channel that reaches the agent
    // process under `--sandbox none` (agentic-pi's --sandbox-env is a no-op there).
    for (const [k, v] of Object.entries(sandboxEnv)) {
      const i = dockerArgs.indexOf("-e");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(dockerArgs).toContain(`${k}=${v}`);
    }
    // Must NOT ride inside the agentic-pi command as --sandbox-env (dropped there).
    const shCmd = dockerArgs[dockerArgs.length - 1];
    expect(shCmd).not.toContain("--sandbox-env");
    expect(shCmd).not.toContain("GIT_AUTHOR_NAME");
  });

  it("passes --profile to agentic-pi when a valid profile is given", async () => {
    const runPromise = manager.runAgent("task-001", "test prompt", { ...RUN, profile: "issues-write" });
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;

    const dockerArgs = mockSpawn.mock.calls[0][1] as string[];
    const shCmd = dockerArgs[dockerArgs.length - 1];
    expect(shCmd).toContain("--profile issues-write");
  });

  it("always passes the run's gate budget to agentic-pi as --gate-timeout (#385)", async () => {
    const runPromise = manager.runAgent("task-001", "test prompt", { ...RUN, gateTimeoutSeconds: 1234 });
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;

    const shCmd = (mockSpawn.mock.calls[0][1] as string[]).at(-1)!;
    expect(shCmd).toContain("--gate-timeout 1234");
  });

  it("rounds a fractional gate budget UP — never down (#385)", async () => {
    const runPromise = manager.runAgent("task-001", "test prompt", { ...RUN, gateTimeoutSeconds: 90.5 });
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;

    expect((mockSpawn.mock.calls[0][1] as string[]).at(-1)).toContain("--gate-timeout 91");
  });

  it("refuses to run without a resolved timeout rather than defaulting to a literal (#385)", async () => {
    await expect(
      manager.runAgent("task-001", "test prompt", { gateTimeoutSeconds: 900 } as never),
    ).rejects.toThrow(/timeoutSeconds must be a positive number/);
    await expect(
      manager.runAgent("task-001", "test prompt", { timeoutSeconds: 60 } as never),
    ).rejects.toThrow(/gateTimeoutSeconds must be a positive number/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("rejects when profile is not one of the closed set", async () => {
    // The `as any` simulates a value that reached here already erased to
    // `string` (e.g. an untyped caller) — the runtime guard is the last
    // line of defence once `GitAccessProfile` narrowing is bypassed.
    await expect(
      manager.runAgent("task-001", "test prompt", { ...RUN, profile: "admin" as any }),
    ).rejects.toThrow(/Refusing to pass profile "admin"/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

// In production the harness state dir is mounted at /data, so the OAuth
// credential store the orchestrator names on the host is readable in the guest.
// The driver maps the path and passes `--auth-file` — the only auth route for a
// provider with no env var (Codex).
describe("DockerSandbox.runAgent — OAuth credential store via the /data mount", () => {
  const RUN = { timeoutSeconds: 5, gateTimeoutSeconds: 900 };
  const STATE_DIR = "/app/data";
  const OUTSIDE_MOUNT = "outside the directory mounted at /data";
  let manager: DockerSandbox;
  let fakeChild: ReturnType<typeof makeFakeChild>;
  const prevDataVolume = process.env.SANDBOX_DATA_VOLUME;

  afterEach(() => {
    if (prevDataVolume === undefined) delete process.env.SANDBOX_DATA_VOLUME;
    else process.env.SANDBOX_DATA_VOLUME = prevDataVolume;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // The default is the production named volume. Each test that needs a
    // different mount sets the variable itself.
    delete process.env.SANDBOX_DATA_VOLUME;
    fakeChild = makeFakeChild();
    mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);
    manager = new DockerSandbox({ imageName: "test-image", env: {}, stateDir: STATE_DIR });
    (manager as unknown as { activeContainers: Map<string, unknown> })
      .activeContainers.set("task-001", {
        containerId: "abc123",
        containerName: "test-container",
        worktreePath: "/tmp/work",
      });
  });

  async function runWith(authFile?: string): Promise<string> {
    const runPromise = manager.runAgent("task-001", "test prompt", { ...RUN, authFile });
    process.nextTick(() => fakeChild.emit("close", 0));
    await runPromise;
    return (mockSpawn.mock.calls[0][1] as string[]).at(-1)!;
  }

  it("maps the default store to the in-guest path", async () => {
    const shCmd = await runWith(`${STATE_DIR}/auth.json`);
    expect(shCmd).toContain("--auth-file /data/auth.json");
    expect(warnSpy.mock.calls.some(([m]) => String(m).includes(OUTSIDE_MOUNT))).toBe(false);
  });

  it("maps a store in a subdirectory of the state dir", async () => {
    const shCmd = await runWith(`${STATE_DIR}/creds/auth.json`);
    expect(shCmd).toContain("--auth-file /data/creds/auth.json");
  });

  it("passes no flag when the run carries no auth file", async () => {
    const shCmd = await runWith(undefined);
    expect(shCmd).not.toContain("--auth-file");
    expect(warnSpy.mock.calls.some(([m]) => String(m).includes(OUTSIDE_MOUNT))).toBe(false);
  });

  it("passes no flag and warns for a store outside the state dir", async () => {
    // What `LASTLIGHT_AUTH_FILE=/elsewhere/auth.json` produces: the file exists
    // on the host but no mount carries it into the guest.
    const shCmd = await runWith("/elsewhere/auth.json");
    expect(shCmd).not.toContain("--auth-file");
    expect(warnSpy.mock.calls.some(([m]) => String(m).includes(OUTSIDE_MOUNT))).toBe(true);
  });

  it("passes no flag and warns when the driver knows no state dir", async () => {
    manager = new DockerSandbox({ imageName: "test-image", env: {} });
    (manager as unknown as { activeContainers: Map<string, unknown> })
      .activeContainers.set("task-001", {
        containerId: "abc123",
        containerName: "test-container",
        worktreePath: "/tmp/work",
      });
    const shCmd = await runWith(`${STATE_DIR}/auth.json`);
    expect(shCmd).not.toContain("--auth-file");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("maps against the state dir for an explicit named volume (production)", async () => {
    process.env.SANDBOX_DATA_VOLUME = "lastlight_agent-data";
    const shCmd = await runWith(`${STATE_DIR}/auth.json`);
    expect(shCmd).toContain("--auth-file /data/auth.json");
  });

  describe("bind mount of a host path (local dev)", () => {
    // What `scripts/dev-local.sh` sets: the guest sees only a subdirectory of
    // the state dir.
    const DEV_STATE_DIR = "/home/dev/lastlight/state";
    const DEV_DATA = `${DEV_STATE_DIR}/sandbox-data`;

    beforeEach(() => {
      process.env.SANDBOX_DATA_VOLUME = DEV_DATA;
      manager = new DockerSandbox({ imageName: "test-image", env: {}, stateDir: DEV_STATE_DIR });
      (manager as unknown as { activeContainers: Map<string, unknown> })
        .activeContainers.set("task-001", {
          containerId: "abc123",
          containerName: "test-container",
          worktreePath: "/tmp/work",
        });
    });

    it("passes no flag and warns for the default store, which the mount does not carry", async () => {
      // Before the fix the driver translated against the state dir and passed
      // /data/auth.json — in the guest that is sandbox-data/auth.json, a file
      // that does not exist.
      const shCmd = await runWith(`${DEV_STATE_DIR}/auth.json`);
      expect(shCmd).not.toContain("--auth-file");
      expect(warnSpy.mock.calls.some(([m]) => String(m).includes(OUTSIDE_MOUNT))).toBe(true);
    });

    it("maps a store inside the mounted directory", async () => {
      const shCmd = await runWith(`${DEV_DATA}/auth.json`);
      expect(shCmd).toContain("--auth-file /data/auth.json");
      expect(warnSpy.mock.calls.some(([m]) => String(m).includes(OUTSIDE_MOUNT))).toBe(false);
    });

    it("maps against the bind mount even when the driver knows no state dir", async () => {
      manager = new DockerSandbox({ imageName: "test-image", env: {} });
      (manager as unknown as { activeContainers: Map<string, unknown> })
        .activeContainers.set("task-001", {
          containerId: "abc123",
          containerName: "test-container",
          worktreePath: "/tmp/work",
        });
      const shCmd = await runWith(`${DEV_DATA}/creds/auth.json`);
      expect(shCmd).toContain("--auth-file /data/creds/auth.json");
    });

    it("mounts at /data the same directory that the translation uses", async () => {
      mockExecFileSync.mockReturnValue("container-xyz\n");
      await manager.create({
        taskId: "t",
        worktreePath: "/tmp/work",
        workspaceMount: { type: "bind", hostPath: "/tmp/work" },
      });
      const run = mockExecFileSync.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "run",
      );
      expect(run?.[1] as string[]).toContain(`${DEV_DATA}:/data`);
    });
  });
});

describe("DockerSandbox.create — shared package cache (issue #107)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReturnValue("container-xyz\n");
  });

  function dockerRunArgv(): string[] {
    const call = mockExecFileSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "run",
    );
    return (call?.[1] as string[]) ?? [];
  }

  it("mounts the shared cache volume and wires npm/pnpm/yarn env", async () => {
    const manager = new DockerSandbox({ imageName: "img", env: {} });
    await manager.create({
      taskId: "repo-1-pr-review",
      worktreePath: "/tmp/work",
      workspaceMount: { type: "bind", hostPath: "/tmp/work" },
    });
    const argv = dockerRunArgv();
    expect(argv).toContain("lastlight_pkg-cache:/cache");
    expect(argv).toContain("npm_config_cache=/cache/npm");
    expect(argv).toContain("npm_config_store_dir=/cache/pnpm");
    expect(argv).toContain("YARN_CACHE_FOLDER=/cache/yarn");
  });

  it("honours LASTLIGHT_PKG_CACHE_VOLUME override", async () => {
    const prev = process.env.LASTLIGHT_PKG_CACHE_VOLUME;
    process.env.LASTLIGHT_PKG_CACHE_VOLUME = "my-cache";
    try {
      const manager = new DockerSandbox({ imageName: "img", env: {} });
      await manager.create({
        taskId: "t",
        worktreePath: "/tmp/work",
        workspaceMount: { type: "bind", hostPath: "/tmp/work" },
      });
      expect(dockerRunArgv()).toContain("my-cache:/cache");
    } finally {
      if (prev === undefined) delete process.env.LASTLIGHT_PKG_CACHE_VOLUME;
      else process.env.LASTLIGHT_PKG_CACHE_VOLUME = prev;
    }
  });
});
