import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase, getTaskById, insertTask } from "../../state/database.js";
import { assignTask, createGoal, failTask, completeTask, type TaskNode } from "../../orchestration/task-graph.js";
import { LocalWorkerPool } from "../../orchestration/local-worker.js";
import { TaskAttemptScope } from "../../orchestration/task-attempt.js";
import { AgentWorkspace } from "../../orchestration/workspace.js";
import { createPublishedGoalWorkspace, publishAttemptWorkspace, seedAttemptWorkspace } from "../../orchestration/workspace-publication.js";
import { HarnessRegistry } from "../../agent/harness-registry.js";
import type { AgentHarness, HarnessContext } from "../../agent/harness-types.js";
import { createTestConfig, createTestIdentity, MockConwayClient } from "../mocks.js";

const RESULT = { success: true, output: "done", artifacts: [], costCents: 0, duration: 1 };

describe("committed workspace publication", () => {
  let dir: string;
  let db: ReturnType<typeof createDatabase>;
  let goalId: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-publication-"));
    db = createDatabase(path.join(dir, "state.db"));
    goalId = createGoal(db.raw, "Goal", "Goal").id;
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  function assigned(id?: string): TaskNode {
    const taskId = id ?? insertTask(db.raw, { goalId, title: "Task", description: "Task", agentRole: "test" });
    const attemptId = assignTask(db.raw, taskId, "local://worker");
    const row = getTaskById(db.raw, taskId)!;
    return { ...row, attemptId, result: null, metadata: { estimatedCostCents: 0, actualCostCents: 0, maxRetries: 3, retryCount: row.retryCount, timeoutMs: 1000, createdAt: row.createdAt, startedAt: null, completedAt: null } };
  }
  function pool(execute: (context: HarnessContext) => Promise<typeof RESULT>) {
    class Harness implements AgentHarness {
      id = "test"; description = "test"; context!: HarnessContext;
      async initialize(_task: TaskNode, context: HarnessContext) { this.context = context; }
      execute() { return execute(this.context); }
      getToolDefs() { return []; }
      buildSystemPrompt() { return ""; }
      buildTaskPrompt() { return ""; }
    }
    const registry = new HarnessRegistry(); registry.register("test", Harness);
    return new LocalWorkerPool({ db: db.raw, conway: new MockConwayClient(), inference: { chat: async () => ({ content: "" }) }, harnessRegistry: registry,
      identity: createTestIdentity(), config: createTestConfig(), workspaceBasePath: dir, allowedEditRoot: dir });
  }
  async function run(worker: LocalWorkerPool, task: TaskNode) {
    await (worker as any).runWorker("worker", task, new AbortController().signal);
  }
  function snapshot() { return JSON.parse(db.getKV(`worker.workspace.${goalId}`)!); }

  it.each([false, true])("shares committed outputs and conventions between successive tasks, restart=%s", async (restart) => {
    const first = assigned();
    await run(pool(async (context) => {
      context.workspace.writeOutput("test", "notes.md", "committed artifact");
      context.workspace.logDecision("Convention: use modules", "consistent", "test");
      return RESULT;
    }), first);
    expect(getTaskById(db.raw, first.id)?.status).toBe("completed");
    if (restart) { db.close(); db = createDatabase(path.join(dir, "state.db")); }
    const second = assigned();
    await run(pool(async (context) => {
      expect(context.workspace.readOutput("notes.md")).toBe("committed artifact");
      expect(context.wisdom.conventions.join(" ")).toContain("use modules");
      context.workspace.writeOutput("test", "next.md", "next artifact");
      return RESULT;
    }), second);
    expect(getTaskById(db.raw, second.id)?.status).toBe("completed");
    expect(snapshot().outputs).toMatchObject({ "notes.md": { content: "committed artifact" }, "next.md": { content: "next artifact" } });
    expect(snapshot().decisions.match(/use modules/g)).toHaveLength(1);
  });

  it("publishes deletions across restart without resurrecting inherited parent outputs", async () => {
    const goal = new AgentWorkspace(goalId, path.join(dir, goalId));
    goal.writeOutput("parent", "inherited.md", "parent old");
    await run(pool(async context => {
      context.workspace.writeOutput("test", "published.md", "worker old");
      context.workspace.writeOutput("test", "keep.md", "keep"); return RESULT;
    }), assigned());
    await run(pool(async context => {
      for (const file of ["published.md", "inherited.md"]) fs.unlinkSync(path.join(context.workspace.basePath, "outputs", file));
      return RESULT;
    }), assigned());
    expect(snapshot().outputs["published.md"]).toBeUndefined();
    expect(snapshot().deletedOutputs).toEqual(expect.arrayContaining(["published.md", "inherited.md"]));
    db.close(); db = createDatabase(path.join(dir, "state.db"));
    await run(pool(async context => {
      expect(context.workspace.listOutputs().map(file => path.basename(file.path))).toEqual(["keep.md"]);
      return RESULT;
    }), assigned());
    const view = createPublishedGoalWorkspace(db.raw, goalId, goal.basePath);
    expect(view.listOutputs().map(file => path.basename(file.path))).toEqual(["keep.md"]);
    // Physical parent-owned files and older snapshots are immutable inputs, masked by tombstones.
    expect(goal.readOutput("inherited.md")).toBe("parent old");
  });

  it("does not publish a stale attempt's private files or decisions after reassignment to the same worker", async () => {
    const first = assigned();
    let started!: () => void; let release!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = run(pool(async (context) => {
      context.workspace.writeOutput("test", "notes.md", "stale");
      context.workspace.logDecision("Convention: stale", "stale", "test");
      started(); await gate; return RESULT;
    }), first);
    await ready;
    failTask(db.raw, first.id, "retry", true);
    const second = assigned(first.id);
    await run(pool(async (context) => {
      expect(context.workspace.listOutputs()).toEqual([]);
      context.workspace.writeOutput("test", "notes.md", "current"); return RESULT;
    }), second);
    release(); await pending;
    expect(snapshot().outputs["notes.md"].content).toBe("current");
    expect(snapshot().decisions).not.toContain("stale");
    expect(getTaskById(db.raw, first.id)).toMatchObject({ status: "completed", attemptId: second.attemptId });
  });

  it("preserves preexisting goal files and makes committed worker outputs visible to the parent planner", async () => {
    const goal = new AgentWorkspace(goalId, path.join(dir, goalId));
    goal.writeOutput("parent", "legacy.md", "original");
    goal.logDecision("Convention: original", "keep", "parent");
    const original = fs.readFileSync(path.join(goal.basePath, "context", "decisions.md"), "utf8");
    await run(pool(async (context) => {
      expect(context.workspace.readOutput("legacy.md")).toBe("original");
      expect(context.wisdom.conventions.join(" ")).toContain("original");
      context.workspace.writeOutput("test", "committed.md", "published");
      context.workspace.logDecision("Convention: new", "share", "test"); return RESULT;
    }), assigned());
    const view = createPublishedGoalWorkspace(db.raw, goalId, goal.basePath);
    expect(view.readOutput("legacy.md")).toBe("original");
    expect(view.readOutput("committed.md")).toBe("published");
    expect(goal.listOutputs()).toHaveLength(1);
    expect(fs.readFileSync(path.join(goal.basePath, "context", "decisions.md"), "utf8")).toBe(original);
    expect(fs.readFileSync(path.join(view.basePath, "context", "decisions.md"), "utf8")).toContain("Convention: new");
  });

  it("does not retain a removed goal output in the next parent snapshot", () => {
    const goal = new AgentWorkspace(goalId, path.join(dir, goalId));
    goal.writeOutput("parent", "removed.md", "old");
    const first = createPublishedGoalWorkspace(db.raw, goalId, goal.basePath);
    fs.unlinkSync(path.join(goal.basePath, "outputs", "removed.md"));
    const second = createPublishedGoalWorkspace(db.raw, goalId, goal.basePath);
    expect(first.basePath).not.toBe(second.basePath);
    expect(first.readOutput("removed.md")).toBe("old");
    expect(second.listOutputs()).toEqual([]);
    expect(() => second.readOutput("removed.md")).toThrow(/does not exist/);
  });

  it("isolates simultaneous attempts and parent snapshots before either attempt publishes", async () => {
    const goal = new AgentWorkspace(goalId, path.join(dir, goalId));
    goal.writeOutput("parent", "notes.md", "shared");
    const firstView = createPublishedGoalWorkspace(db.raw, goalId, goal.basePath);
    let started!: () => void; let release!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = assigned();
    const pending = run(pool(async (context) => {
      context.workspace.writeOutput("test", "notes.md", "first-private");
      started(); await gate;
      expect(context.workspace.readOutput("notes.md")).toBe("first-private");
      return RESULT;
    }), first);
    await ready;
    const second = assigned();
    await run(pool(async (context) => {
      expect(context.workspace.readOutput("notes.md")).toBe("shared");
      context.workspace.writeOutput("test", "notes.md", "second-private"); return RESULT;
    }), second);
    const secondView = createPublishedGoalWorkspace(db.raw, goalId, goal.basePath);
    expect(firstView.readOutput("notes.md")).toBe("shared");
    expect(secondView.readOutput("notes.md")).toBe("second-private");
    release(); await pending;
    expect(firstView.readOutput("notes.md")).toBe("shared");
    expect(secondView.readOutput("notes.md")).toBe("second-private");
  });

  it("merges concurrent tasks' deltas and rolls back publication with a failed completion transaction", () => {
    const goal = new AgentWorkspace(goalId, path.join(dir, goalId));
    const first = assigned(); const second = assigned();
    const one = new AgentWorkspace(goalId, path.join(goal.basePath, "attempts", first.attemptId!));
    const two = new AgentWorkspace(goalId, path.join(goal.basePath, "attempts", second.attemptId!));
    const initialOne = seedAttemptWorkspace(db.raw, goal, one);
    const initialTwo = seedAttemptWorkspace(db.raw, goal, two);
    one.writeOutput("test", "one.txt", "one"); two.writeOutput("test", "two.txt", "two");
    const publish = (task: TaskNode, workspace: AgentWorkspace, initial: ReturnType<typeof seedAttemptWorkspace>) => {
      const scope = new TaskAttemptScope(db.raw, { taskId: task.id, workerAddress: task.assignedTo!, attemptId: task.attemptId! });
      scope.write(db.raw, () => { publishAttemptWorkspace(db.raw, workspace, initial, scope.attempt); completeTask(db.raw, task.id, RESULT, scope.attempt); });
    };
    publish(first, one, initialOne);
    const scope = new TaskAttemptScope(db.raw, { taskId: second.id, workerAddress: second.assignedTo!, attemptId: second.attemptId! });
    expect(() => scope.write(db.raw, () => { publishAttemptWorkspace(db.raw, two, initialTwo, scope.attempt); throw new Error("completion failed"); })).toThrow("completion failed");
    expect(snapshot().outputs["two.txt"]).toBeUndefined();
    publish(second, two, initialTwo);
    expect(snapshot().outputs).toMatchObject({ "one.txt": { content: "one" }, "two.txt": { content: "two" } });
    expect(() => scope.write(db.raw, () => publishAttemptWorkspace(db.raw, two, initialTwo, scope.attempt))).toThrow(/no longer owns/);
    expect(() => publishAttemptWorkspace(db.raw, two, initialTwo, scope.attempt)).toThrow(/no longer owns/);
  });
});
