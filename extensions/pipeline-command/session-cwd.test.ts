/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@dpchamps/pi-worktree-command/operations", () => ({
  createWorktreeForkSession: vi.fn(),
  mergeWorktreeAndCleanup: vi.fn(),
}));

import pipelineCommand from "./index.js";

const directories: string[] = [];

function directory() {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-cwd-test-"));
  directories.push(dir);
  return dir;
}

function pipeline(dir: string, marker: string, file = "pipeline.json") {
  const filePath = join(dir, file);
  writeFileSync(
    filePath,
    JSON.stringify({
      units: [{ id: marker, postScript: `printf ${marker} > selected.txt` }],
    }),
  );
  return filePath;
}

function harness() {
  const events = new Map<string, (...args: any[]) => any>();
  let command: any;
  const messages: string[] = [];
  const exec = vi.fn(async (cmd: string, args: string[], opts: any) => ({
    stdout: execFileSync(cmd, args, { cwd: opts.cwd, encoding: "utf8" }),
    stderr: "",
    code: 0,
    killed: false,
  }));
  const pi: any = {
    on: (name: string, callback: (...args: any[]) => any) =>
      events.set(name, callback),
    registerCommand: (_name: string, definition: any) => {
      command = definition;
    },
    exec,
  };
  pipelineCommand(pi);
  const context = (cwd: string, hasUI = true) => ({
    cwd,
    hasUI,
    ui: {
      notify: (message: string) => messages.push(message),
      setStatus: vi.fn(),
      theme: { fg: (_: string, text: string) => text },
    },
  });
  return {
    exec,
    messages,
    run: (args: string, cwd: string) => command.handler(args, context(cwd)),
    start: async (cwd: string, hasUI = true) =>
      events.get("session_start")?.({}, context(cwd, hasUI)),
    complete: (prefix: string) => command.getArgumentCompletions(prefix),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("pipeline active session paths", () => {
  it("executes the relative pipeline from the command context, not the launch directory", async () => {
    const launch = directory();
    const active = directory();
    pipeline(launch, "launch");
    pipeline(active, "active");
    vi.spyOn(process, "cwd").mockReturnValue(launch);
    const h = harness();
    await h.run("execute pipeline.json", active);
    expect(readFileSync(join(active, "selected.txt"), "utf8")).toBe("active");
    expect(process.cwd()).toBe(launch);
  });

  it("validates the active session file even when a same-named launch file is invalid", async () => {
    const launch = directory();
    const active = directory();
    writeFileSync(join(launch, "pipeline.json"), "not JSON");
    pipeline(active, "active");
    vi.spyOn(process, "cwd").mockReturnValue(launch);
    const h = harness();
    await h.run("validate pipeline.json", active);
    expect(h.messages).toContain(
      `Pipeline: ${join(active, "pipeline.json")} OK (1 units, 0 edges)`,
    );
    expect(h.exec).not.toHaveBeenCalled();
  });

  it("does not fall back to a launch-directory pipeline absent from the active session", async () => {
    const launch = directory();
    const active = directory();
    pipeline(launch, "launch");
    vi.spyOn(process, "cwd").mockReturnValue(launch);
    const h = harness();
    await h.run("execute pipeline.json", active);
    expect(h.exec).not.toHaveBeenCalled();
    expect(
      h.messages.some(
        (message) =>
          message.includes(join(active, "pipeline.json")) &&
          message.includes("failed to read"),
      ),
    ).toBe(true);
  });

  it("preserves explicit absolute paths, including paths containing spaces", async () => {
    const launch = directory();
    const active = directory();
    const target = pipeline(launch, "explicit", "my pipeline.json");
    vi.spyOn(process, "cwd").mockReturnValue(launch);
    const h = harness();
    await h.run(`execute ${target}`, active);
    expect(readFileSync(join(active, "selected.txt"), "utf8")).toBe("explicit");
  });

  it.each([true, false])(
    "completes paths from a resumed session (UI: %s)",
    async (hasUI) => {
      const launch = directory();
      const active = directory();
      pipeline(launch, "launch", "launch-only.json");
      pipeline(active, "active", "active-only.json");
      vi.spyOn(process, "cwd").mockReturnValue(launch);
      const h = harness();
      await h.start(active, hasUI);
      expect(
        (await h.complete("execute ")).map((item: any) => item.value),
      ).toEqual(["execute ./active-only.json"]);
    },
  );

  it("refreshes path completions after a later session switch", async () => {
    const first = directory();
    const second = directory();
    pipeline(first, "first", "first.json");
    pipeline(second, "second", "second.json");
    vi.spyOn(process, "cwd").mockReturnValue(first);
    const h = harness();
    await h.start(first);
    await h.start(second);
    expect(
      (await h.complete("validate ")).map((item: any) => item.value),
    ).toEqual(["validate ./second.json"]);
  });

  it("offers subcommands but does not scan a launch directory before session startup", async () => {
    const h = harness();
    expect((await h.complete("")).map((item: any) => item.label)).toEqual([
      "execute",
      "validate",
    ]);
    expect(await h.complete("execute ")).toEqual([]);
    expect(h.exec).not.toHaveBeenCalled();
  });
});
