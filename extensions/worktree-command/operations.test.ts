import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

// These tests exercise Git branch creation without switching Pi sessions.
vi.mock("@earendil-works/pi-coding-agent", () => ({ SessionManager: {} }));

import { createWorktreeForkSession } from "./operations.js";

const directories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-worktree-test-"));
  directories.push(directory);
  git(directory, "init", "-b", "main");
  git(directory, "config", "user.name", "Worktree Test");
  git(directory, "config", "user.email", "test@example.invalid");
  writeFileSync(join(directory, "base.txt"), "base\n");
  git(directory, "add", "base.txt");
  git(directory, "commit", "-m", "Base commit");
  return directory;
}

async function createFrom(cwd: string) {
  const pi = {
    exec: async (command: string, args: string[], options: { cwd: string }) => {
      try {
        const stdout = execFileSync(command, args, {
          cwd: options.cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, stdout, stderr: "", killed: false };
      } catch (error) {
        const failure = error as {
          status: number;
          stdout: string;
          stderr: string;
        };
        return {
          code: failure.status,
          stdout: failure.stdout,
          stderr: failure.stderr,
          killed: false,
        };
      }
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    sessionManager: { getSessionFile: () => undefined },
  } as unknown as ExtensionCommandContext;
  const result = await createWorktreeForkSession(pi, ctx);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.handle;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("createWorktreeForkSession", () => {
  it("starts from the current branch in the main worktree", async () => {
    const directory = repository();
    const expected = git(directory, "rev-parse", "HEAD");
    const handle = await createFrom(directory);

    expect(handle.parent).toBe("main");
    expect(handle.branch).toBe("main-wt-1");
    expect(git(handle.worktreePath, "rev-parse", "HEAD")).toBe(expected);
  });

  it.each(["feature", "feature/nested"])(
    "preserves %s commits when creating from a linked worktree",
    async (branch) => {
      const directory = repository();
      const linked = join(directory, "parent");
      git(directory, "worktree", "add", "-b", branch, linked);
      writeFileSync(join(linked, "feature.txt"), "committed feature work\n");
      git(linked, "add", "feature.txt");
      git(linked, "commit", "-m", "Feature-only commit");
      const expected = git(linked, "rev-parse", "HEAD");
      const handle = await createFrom(linked);

      expect(handle.parent).toBe(branch);
      expect(handle.branch).toBe(`${branch}-wt-1`);
      expect(git(handle.worktreePath, "rev-parse", "HEAD")).toBe(expected);
      expect(readFileSync(join(handle.worktreePath, "feature.txt"), "utf8")).toBe(
        "committed feature work\n",
      );
      expect(git(directory, "rev-parse", "HEAD")).not.toBe(expected);
    },
  );

  it("accepts Git's disambiguated branch ref when a same-named tag exists", async () => {
    const directory = repository();
    const linked = join(directory, "parent");
    git(directory, "worktree", "add", "-b", "feature", linked);
    writeFileSync(join(linked, "feature.txt"), "committed feature work\n");
    git(linked, "add", "feature.txt");
    git(linked, "commit", "-m", "Feature-only commit");
    const expected = git(linked, "rev-parse", "HEAD");
    git(directory, "tag", "feature", "main");

    const handle = await createFrom(linked);

    expect(git(handle.worktreePath, "rev-parse", "HEAD")).toBe(expected);
  });
});
