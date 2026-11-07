import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import worktreeCommand from "./index.js";

const directories: string[] = [];

function directory() {
  const path = mkdtempSync(join(tmpdir(), "pi-completion-test-"));
  directories.push(path);
  return path;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

function repository(branch: string) {
  const root = directory();
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Completion Test");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "Base commit");
  const linked = join(root, ".worktrees", branch);
  git(root, "worktree", "add", "-b", branch, linked);
  return { root, linked };
}

function harness() {
  let start!: (event: unknown, ctx: ExtensionContext) => Promise<void>;
  let complete!: (
    prefix: string,
  ) => Promise<{ label: string; value: string }[]>;
  const exec = vi.fn(
    async (command: string, args: string[], options: { cwd: string }) => {
      try {
        return {
          code: 0,
          stdout: execFileSync(command, args, {
            cwd: options.cwd,
            encoding: "utf8",
            stdio: "pipe",
          }),
          stderr: "",
          killed: false,
        };
      } catch {
        return { code: 1, stdout: "", stderr: "Git failed", killed: false };
      }
    },
  );
  const pi = {
    exec,
    on: (name: string, handler: typeof start) => {
      if (name === "session_start") start = handler;
    },
    registerCommand: (
      _name: string,
      command: { getArgumentCompletions: typeof complete },
    ) => {
      complete = command.getArgumentCompletions;
    },
  } as unknown as ExtensionAPI;
  worktreeCommand(pi);
  return {
    exec,
    complete: (prefix: string) => complete(prefix),
    start: (cwd: string, hasUI = true) =>
      start({}, {
        cwd,
        hasUI,
        ui: {
          setStatus: vi.fn(),
          theme: { fg: (_: string, value: string) => value },
        },
      } as unknown as ExtensionContext),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("worktree completion session cwd", () => {
  it("keeps subcommand completion independent of session startup and Git", async () => {
    const h = harness();
    expect((await h.complete("")).map((item) => item.label)).toEqual([
      "create",
      "merge",
      "switch",
    ]);
    expect(await h.complete("switch ")).toEqual([]);
    expect(h.exec).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses the resumed session repository rather than process cwd (UI: %s)",
    async (hasUI) => {
      const launch = repository("wrong-launch-only");
      const active = repository("feature/active");
      vi.spyOn(process, "cwd").mockReturnValue(launch.root);
      const h = harness();
      await h.start(active.linked, hasUI);
      expect((await h.complete("switch ")).map((item) => item.label)).toEqual([
        "main",
        "feature/active",
      ]);
      expect(
        (await h.complete("merge feature/")).map((item) => item.value),
      ).toEqual(["merge feature/active"]);
      expect(process.cwd()).toBe(launch.root);
    },
  );

  it("refreshes completion after switching to another repository", async () => {
    const first = repository("first-only");
    const second = repository("second-only");
    vi.spyOn(process, "cwd").mockReturnValue(first.root);
    const h = harness();
    await h.start(first.linked);
    expect((await h.complete("switch ")).map((item) => item.label)).toContain(
      "first-only",
    );
    await h.start(second.linked);
    expect((await h.complete("switch ")).map((item) => item.label)).toEqual([
      "main",
      "second-only",
    ]);
  });

  it("does not retain old worktrees after switching to a non-Git session", async () => {
    const first = repository("old-only");
    vi.spyOn(process, "cwd").mockReturnValue(first.root);
    const h = harness();
    await h.start(first.linked);
    await h.start(directory(), false);
    expect(await h.complete("switch ")).toEqual([]);
    expect(await h.complete("merge ")).toEqual([]);
  });
});
