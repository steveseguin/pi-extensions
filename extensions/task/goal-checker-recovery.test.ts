import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGoalChecker } from "./goal-checker.js";

type Phase = "planning" | "evaluation";
type Scenario = "retry" | "recovery" | "terminal" | "late-error" | "cancel";

async function fixture(
  scenario: Scenario,
  phase: Phase,
  controller: AbortController,
) {
  const directory = await mkdtemp(join(tmpdir(), "goal-checker-recovery-"));
  const path = join(directory, "checker.mjs");
  await writeFile(
    path,
    `
import { writeFile } from "node:fs/promises";
const request = process.argv.at(-1);
const planning = request.includes("Create the independent acceptance checklist");
const targeted = planning === ${JSON.stringify(phase === "planning")};
const checklist = JSON.parse(request.match(/Checklist file: ("[^\\n]+")/)[1]);
await writeFile(checklist, "# Checklist\\n- [x] Verify fixture output independently");
const emit = (event) => console.log(JSON.stringify(event));
const success = () => emit({ type: "message_end", message: {
  role: "assistant", stopReason: "stop", content: [{ type: "text",
  text: planning ? '{"ready":true}' : '{"complete":true,"feedback":"Verified fixture."}' }]
} });
const error = () => emit({ type: "message_end", message: {
  role: "assistant", stopReason: "error", content: [], errorMessage: "503 Service unavailable"
} });
if (!targeted) success();
else if (${JSON.stringify(scenario)} === "cancel") {
  process.on("SIGTERM", () => { success(); process.exit(0); });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Waiting" } });
  setInterval(() => {}, 1000);
} else if (${JSON.stringify(scenario)} === "late-error") { success(); error(); }
else {
  error();
  // Non-assistant output must not hide a terminal model error.
  emit({ type: "message_end", message: { role: "toolResult", content: [] } });
  if (${JSON.stringify(scenario)} !== "terminal") {
    if (${JSON.stringify(scenario)} === "retry") emit({ type: "auto_retry_start", attempt: 1 });
    success();
    if (${JSON.stringify(scenario)} === "retry") emit({ type: "auto_retry_end", success: true, attempt: 1 });
  }
}
`,
  );
  const checker = await createGoalChecker({
    cwd: directory,
    prompt: "Verify fixture output",
    model: { provider: "test", id: "model" },
    projectTrusted: false,
    invocation: { command: process.execPath, args: [path] },
    onUpdate: (update) => {
      if (
        scenario === "cancel" &&
        update.type === "text" &&
        update.text === "Waiting"
      )
        controller.abort();
    },
  });
  return {
    checker,
    async cleanup() {
      controller.abort();
      await checker.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("goal checker model recovery", () => {
  it.each([
    ["planning", "retry"],
    ["evaluation", "retry"],
    ["planning", "recovery"],
    ["evaluation", "recovery"],
  ] as const)("accepts successful %s after %s", async (phase, scenario) => {
    const controller = new AbortController();
    const { checker, cleanup } = await fixture(scenario, phase, controller);
    try {
      await checker.initialize(controller.signal);
      if (phase === "evaluation") {
        await expect(checker.evaluate(controller.signal)).resolves.toEqual({
          complete: true,
          feedback: "Verified fixture.",
        });
      }
    } finally {
      await cleanup();
    }
  });

  it.each([
    ["planning", "terminal"],
    ["evaluation", "terminal"],
    ["planning", "late-error"],
    ["evaluation", "late-error"],
  ] as const)("still rejects %s with a %s", async (phase, scenario) => {
    const controller = new AbortController();
    const { checker, cleanup } = await fixture(scenario, phase, controller);
    try {
      if (phase === "evaluation") await checker.initialize(controller.signal);
      await expect(
        phase === "planning"
          ? checker.initialize(controller.signal)
          : checker.evaluate(controller.signal),
      ).rejects.toThrow("503 Service unavailable");
    } finally {
      await cleanup();
    }
  });

  it("does not clear cancellation when a late successful message arrives", async () => {
    const controller = new AbortController();
    const { checker, cleanup } = await fixture(
      "cancel",
      "planning",
      controller,
    );
    try {
      await expect(checker.initialize(controller.signal)).rejects.toThrow(
        "goal checker was cancelled",
      );
    } finally {
      await cleanup();
    }
  });
});
