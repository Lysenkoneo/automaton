import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ulid } from "ulid";
import { HarnessRegistry } from "../../agent/harness-registry.js";
import type { AgentHarness, HarnessContext, HarnessTool } from "../../agent/harness-types.js";
import { LocalWorkerPool } from "../../orchestration/local-worker.js";
import type { PlannerOutput } from "../../orchestration/planner.js";
import type { TaskNode, TaskResult } from "../../orchestration/task-graph.js";
import { getTaskById } from "../../state/database.js";
import { createInMemoryDb } from "./test-db.js";
import { createTestConfig, createTestIdentity, MockConwayClient } from "../mocks.js";
import { assignTask, completeTask, failTask } from "../../orchestration/task-graph.js";
import { StaleTaskAttemptError } from "../../orchestration/task-attempt.js";

class SuccessHarness implements AgentHarness {
  readonly id = "success";
  readonly description = "success harness";
  static capturedContext: HarnessContext | null = null;

  async initialize(_task: TaskNode, context: HarnessContext): Promise<void> {
    SuccessHarness.capturedContext = context;
  }

  async execute(): Promise<TaskResult> {
    return { success: true, output: "completed by harness", artifacts: ["src/file.ts"], costCents: 0, duration: 1 };
  }

  getToolDefs(): HarnessTool[] {
    return [];
  }

  buildSystemPrompt(): string {
    return "";
  }

  buildTaskPrompt(): string {
    return "";
  }
}

class FailureHarness implements AgentHarness {
  readonly id = "failure";
  readonly description = "failure harness";
  async initialize(): Promise<void> {}
  async execute(): Promise<TaskResult> {
    return { success: false, output: "failed by harness", artifacts: [], costCents: 0, duration: 1 };
  }
  getToolDefs(): HarnessTool[] {
    return [];
  }
  buildSystemPrompt(): string {
    return "";
  }
  buildTaskPrompt(): string {
    return "";
  }
}

class SlowHarness implements AgentHarness {
  readonly id = "slow";
  readonly description = "slow harness";
  static release: (() => void) | null = null;

  async initialize(): Promise<void> {}
  async execute(): Promise<TaskResult> {
    await new Promise<void>((resolve) => {
      SlowHarness.release = resolve;
    });
    return { success: true, output: "slow done", artifacts: [], costCents: 0, duration: 1 };
  }
  getToolDefs(): HarnessTool[] {
    return [];
  }
  buildSystemPrompt(): string {
    return "";
  }
  buildTaskPrompt(): string {
    return "";
  }
}

class OrchestratorBudgetHarness implements AgentHarness {
  readonly id = "orchestrator";
  readonly description = "orchestrator budget harness";
  static capturedBudget: number | null = null;

  async initialize(_task: TaskNode, context: HarnessContext): Promise<void> {
    OrchestratorBudgetHarness.capturedBudget = context.budget.maxTurns;
  }

  async execute(): Promise<TaskResult> {
    return { success: true, output: "done", artifacts: [], costCents: 0, duration: 1 };
  }

  getToolDefs(): HarnessTool[] {
    return [];
  }

  buildSystemPrompt(): string {
    return "";
  }

  buildTaskPrompt(): string {
    return "";
  }
}

class PlannerAwareWorkerInference {
  private plannerIndex = 0;
  private workerIndex = 0;

  constructor(
    private readonly plannerOutputs: PlannerOutput[],
    private readonly workerResponses: Array<{ content: string; toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }> }>,
  ) {}

  async chat(params: { messages: any[]; responseFormat?: { type: string } }): Promise<{ content: string; toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }> }> {
    const systemPrompt = params.messages[0]?.content ?? "";
    if (systemPrompt.includes("# Planner Agent") || params.responseFormat?.type === "json_object") {
      const plan = this.plannerOutputs[this.plannerIndex++] ?? this.plannerOutputs[this.plannerOutputs.length - 1];
      return { content: JSON.stringify(plan) };
    }

    const response = this.workerResponses[this.workerIndex++] ?? { content: "Done." };
    return response;
  }
}

describe("orchestration/LocalWorkerPool harness integration", () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let registry: HarnessRegistry;
  let tempHome: string;

  beforeEach(() => {
    db = createInMemoryDb();
    registry = new HarnessRegistry();
    insertGoal(db, "goal-1");
    SuccessHarness.capturedContext = null;
    SlowHarness.release = null;
    OrchestratorBudgetHarness.capturedBudget = null;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "local-worker-harness-home-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function createPool(maxTurns?: number): LocalWorkerPool {
    return new LocalWorkerPool({
      db,
      conway: new MockConwayClient(),
      inference: { chat: async () => ({ content: "done" }) },
      maxTurns,
      harnessRegistry: registry,
      identity: createTestIdentity(),
      config: createTestConfig(),
      allowedEditRoot: process.cwd(),
      workspaceBasePath: path.join(tempHome, "workspace"),
    });
  }

  it("routes a worker task through the configured harness and completes the task", async () => {
    registry.register("custom-success", SuccessHarness);
    const pool = createPool(7);
    const task = insertTask(db, {
      id: "task-success",
      goalId: "goal-1",
      agentRole: "custom-success",
      status: "assigned",
      assignedTo: "local://worker-test",
      maxRetries: 0,
    });

    await (pool as any).runWorker("worker-test", task, new AbortController().signal);

    const row = getTaskById(db, task.id);
    expect(row?.status).toBe("completed");
    expect(row?.result).toMatchObject({ success: true, output: "completed by harness" });
    expect(SuccessHarness.capturedContext?.budget.maxTurns).toBe(7);
    expect(SuccessHarness.capturedContext?.allowedEditRoot).toBe(process.cwd());
  });

  it("marks the task as failed when the harness reports failure", async () => {
    registry.register("custom-failure", FailureHarness);
    const pool = createPool();
    const task = insertTask(db, {
      id: "task-failure",
      goalId: "goal-1",
      agentRole: "custom-failure",
      status: "assigned",
      assignedTo: "local://worker-test",
      maxRetries: 0,
    });

    await (pool as any).runWorker("worker-test", task, new AbortController().signal);

    const row = getTaskById(db, task.id);
    expect(row?.status).toBe("failed");
    expect(row?.result).toMatchObject({ success: false, output: "failed by harness" });
  });

  it.each([false, true])("retains local failure costs and cumulative retry costs, throws=%s", async (throws) => {
    class CostlyFailure extends FailureHarness {
      override async execute(): Promise<TaskResult> {
        if (throws) throw Object.assign(new Error("costly failure"), { costCents: 9 });
        return { success: false, output: "costly failure", artifacts: [], costCents: 9, duration: 3 };
      }
    }
    registry.register("costly", CostlyFailure);
    const pool = createPool();
    const task = insertTask(db, { id: "costly", goalId: "goal-1", agentRole: "costly", status: "assigned", assignedTo: "local://worker-test", maxRetries: 2 });
    await (pool as any).runWorker("worker-test", task, new AbortController().signal);
    expect(getTaskById(db, task.id)).toMatchObject({ status: "pending", actualCostCents: 9, result: { success: false, costCents: 9, attemptId: task.attemptId } });
    const token = assignTask(db, task.id, "local://worker-test");
    completeTask(db, task.id, { success: true, output: "retry", artifacts: [], costCents: 4, duration: 1 }, { taskId: task.id, workerAddress: "local://worker-test", attemptId: token });
    expect(getTaskById(db, task.id)).toMatchObject({ actualCostCents: 13, result: { costCents: 4 } });
  });

  it("tracks active workers for spawn/hasWorker/getActiveCount", async () => {
    registry.register("custom-slow", SlowHarness);
    const pool = createPool();
    const task = insertTask(db, {
      id: "task-slow",
      goalId: "goal-1",
      agentRole: "custom-slow",
      status: "assigned",
      assignedTo: null,
      maxRetries: 0,
    });

    const spawned = pool.spawn(task);
    db.prepare("UPDATE task_graph SET assigned_to = ?, attempt_id = ? WHERE id = ?").run(spawned.address, spawned.attemptId, task.id);
    expect(pool.getActiveCount()).toBe(1);
    expect(pool.hasWorker(spawned.address)).toBe(true);
    expect(pool.hasWorker(spawned.sandboxId)).toBe(true);

    const resumedPool = createPool();
    expect(resumedPool.hasWorker(spawned.address)).toBe(true);
    expect(resumedPool.getActiveCount()).toBe(1);
    const otherDb = createInMemoryDb();
    try {
      const unrelatedPool = new LocalWorkerPool({ ...(pool as any).config, db: otherDb });
      expect(unrelatedPool.hasWorker(spawned.address)).toBe(false);
    } finally {
      otherDb.close();
    }

    await waitFor(async () => SlowHarness.release !== null);
    SlowHarness.release?.();
    await waitFor(async () => pool.getActiveCount() === 0);
    expect(pool.getActiveCount()).toBe(0);
    expect(resumedPool.getActiveCount()).toBe(0);
    expect(getTaskById(db, task.id)?.status).toBe("completed");
  });

  it("publishes an immediately resolving spawned harness only after assignment", async () => {
    registry.register("custom-success", SuccessHarness);
    const pool = createPool();
    const task = insertTask(db, {
      id: "task-fast", goalId: "goal-1", agentRole: "custom-success",
      status: "pending", assignedTo: null, maxRetries: 0,
    });
    const spawned = await Promise.resolve(pool.spawn(task));
    db.prepare("UPDATE task_graph SET status = 'assigned', assigned_to = ?, attempt_id = ? WHERE id = ?")
      .run(spawned.address, spawned.attemptId, task.id);
    await waitFor(() => pool.getActiveCount() === 0);
    expect(getTaskById(db, task.id)?.status).toBe("completed");
  });

  it.each(["success", "failure", "throw"])("ignores a late %s from a reassigned worker", async (outcome) => {
    registry.register("custom-slow", SlowHarness);
    const pool = createPool();
    const task = insertTask(db, {
      id: "task-late", goalId: "goal-1", agentRole: "custom-slow",
      status: "assigned", assignedTo: "local://worker-old", maxRetries: 2,
    });
    const execute = vi.spyOn(SlowHarness.prototype, "execute").mockImplementation(async () => {
      await new Promise<void>((resolve) => { SlowHarness.release = resolve; });
      if (outcome === "throw") throw new Error("late error");
      return { success: outcome === "success", output: "late result", artifacts: [], costCents: 9, duration: 1 };
    });
    const running = (pool as any).runWorker("worker-old", task, new AbortController().signal);
    await waitFor(() => SlowHarness.release !== null);
    db.prepare("UPDATE task_graph SET assigned_to = ? WHERE id = ?").run("local://worker-new", task.id);
    const before = getTaskById(db, task.id);
    SlowHarness.release?.();
    await running;
    expect(getTaskById(db, task.id)).toEqual(before);
    execute.mockRestore();
  });

  it("ignores a late crash before harness initialization after reassignment", async () => {
    const pool = createPool();
    const task = insertTask(db, {
      id: "task-crash", goalId: "goal-1", agentRole: "generalist",
      status: "pending", assignedTo: null, maxRetries: 2,
    });
    vi.spyOn(registry, "createForRole").mockImplementation(() => { throw new Error("crash"); });
    pool.spawn(task);
    db.prepare("UPDATE task_graph SET status = 'assigned', assigned_to = ? WHERE id = ?")
      .run("local://worker-new", task.id);
    const before = getTaskById(db, task.id);
    await waitFor(() => pool.getActiveCount() === 0);
    expect(getTaskById(db, task.id)).toEqual(before);
  });

  it.each(["success", "failure", "throw"])("ignores a late %s when the same worker address receives a new attempt", async (outcome) => {
    registry.register("custom-slow", SlowHarness);
    const pool = createPool();
    const task = insertTask(db, {
      id: "task-same-address", goalId: "goal-1", agentRole: "custom-slow",
      status: "assigned", assignedTo: "local://worker-test", maxRetries: 2,
    });
    vi.spyOn(SlowHarness.prototype, "execute").mockImplementation(async () => {
      await new Promise<void>((resolve) => { SlowHarness.release = resolve; });
      if (outcome === "throw") throw new Error("late error");
      return { success: outcome === "success", output: "old attempt", artifacts: [], costCents: 9, duration: 1 };
    });
    const running = (pool as any).runWorker("worker-test", task, new AbortController().signal);
    await waitFor(() => SlowHarness.release !== null);
    failTask(db, task.id, "retry", true);
    const newAttempt = assignTask(db, task.id, "local://worker-test");
    expect(newAttempt).not.toBe(task.attemptId);
    const before = getTaskById(db, task.id);
    SlowHarness.release?.();
    await running;
    expect(getTaskById(db, task.id)).toEqual(before);
  });

  it.each(["complete", "fail", "sql"])("revokes the worker context before a late direct %s write", async (operation) => {
    registry.register("custom-slow", SlowHarness);
    const pool = createPool();
    const task = insertTask(db, {
      id: "task-direct-late", goalId: "goal-1", agentRole: "custom-slow",
      status: "assigned", assignedTo: "local://worker-test", maxRetries: 2,
    });
    let context!: HarnessContext;
    vi.spyOn(SlowHarness.prototype, "initialize").mockImplementation(async (_task, ctx) => { context = ctx; });
    let rejected = false;
    vi.spyOn(SlowHarness.prototype, "execute").mockImplementation(async () => {
      await new Promise<void>((resolve) => { SlowHarness.release = resolve; });
      try {
        // complete/fail deliberately use the raw connection captured by a
        // harness; their inherited async scope must still reject the write.
        if (operation === "complete") completeTask(db, task.id, { success: true, output: "late", artifacts: [], costCents: 0, duration: 1 });
        if (operation === "fail") failTask(db, task.id, "late", true);
        if (operation === "sql") context.db.prepare("UPDATE task_graph SET title='late' WHERE id=?").run(task.id);
      } catch (error) { rejected = error instanceof StaleTaskAttemptError; }
      return { success: true, output: "old attempt", artifacts: [], costCents: 0, duration: 1 };
    });
    const running = (pool as any).runWorker("worker-test", task, new AbortController().signal);
    await waitFor(() => SlowHarness.release !== null);
    failTask(db, task.id, "retry", true);
    assignTask(db, task.id, "local://worker-test");
    const before = getTaskById(db, task.id);
    SlowHarness.release?.();
    await running;
    expect(rejected).toBe(true);
    expect(getTaskById(db, task.id)).toEqual(before);
  });

  it("keeps workers spawned during shutdown registered in every pool for the connection", async () => {
    registry.register("custom-slow", SlowHarness);
    const pool = createPool();
    const resumedPool = createPool();
    const releases: Array<() => void> = [];
    const contexts: HarnessContext[] = [];
    vi.spyOn(SlowHarness.prototype, "initialize").mockImplementation(async (_task, context) => { contexts.push(context); });
    vi.spyOn(SlowHarness.prototype, "execute").mockImplementation(async () => {
      await new Promise<void>((resolve) => { releases.push(resolve); });
      return { success: true, output: "done", artifacts: [], costCents: 0, duration: 1 };
    });
    const start = (id: string, target: LocalWorkerPool) => {
      const task = insertTask(db, { id, goalId: "goal-1", agentRole: "custom-slow", status: "pending", assignedTo: null, maxRetries: 0 });
      const worker = target.spawn(task);
      assignTask(db, task.id, worker.address, worker.attemptId);
      return worker;
    };
    const first = start("task-stop", pool);
    await waitFor(() => releases.length === 1);
    const stopping = pool.shutdown();
    const second = start("task-next-cycle", resumedPool);
    await waitFor(() => releases.length === 2);
    expect(first.address).not.toBe(second.address);
    expect(contexts[0].abortSignal.aborted).toBe(true);
    expect(contexts[1].abortSignal.aborted).toBe(false);
    releases[0]();
    await stopping;
    expect(pool.getActiveCount()).toBe(1);
    expect(pool.hasWorker(second.address, second.attemptId)).toBe(true);
    expect(resumedPool.hasWorker(second.address, second.attemptId)).toBe(true);
    expect(pool.hasWorker(second.address, first.attemptId)).toBe(false);
    releases[1]();
    await waitFor(() => pool.getActiveCount() === 0);
    expect(getTaskById(db, "task-next-cycle")?.status).toBe("completed");
  });

  it("gives orchestrator-role harnesses a 50-turn default budget", async () => {
    registry.register("custom-planner", OrchestratorBudgetHarness);
    const pool = createPool();
    const task = insertTask(db, {
      id: "task-orchestrator-budget",
      goalId: "goal-1",
      agentRole: "custom-planner",
      status: "assigned",
      assignedTo: "local://worker-test",
      maxRetries: 0,
    });

    await (pool as any).runWorker("worker-test", task, new AbortController().signal);

    expect(OrchestratorBudgetHarness.capturedBudget).toBe(50);
  });

  it("runs the real orchestrator harness through planner-backed delegation and persists plan artifacts", async () => {
    const plannerOutput: PlannerOutput = {
      analysis: "Plan delegated work",
      strategy: "Create an implementation task and exit cleanly",
      customRoles: [],
      tasks: [
        {
          title: "Implement planned subtask",
          description: "Carry out the planned implementation step.",
          agentRole: "executor",
          dependencies: [],
          estimatedCostCents: 100,
          priority: 55,
          timeoutMs: 60_000,
        },
      ],
      risks: ["None"],
      estimatedTotalCostCents: 100,
      estimatedTimeMinutes: 10,
    };

    const workerInference = new PlannerAwareWorkerInference(
      [plannerOutput],
      [
        {
          content: "",
          toolCalls: [
            {
              id: "delegate-1",
              function: { name: "delegate_task", arguments: JSON.stringify({ plan_task_index: 0 }) },
            },
          ],
        },
        {
          content: "",
          toolCalls: [
            {
              id: "done-1",
              function: { name: "task_done", arguments: JSON.stringify({ summary: "Delegated the planner-backed work.", success: true }) },
            },
          ],
        },
      ],
    );

    const task = insertTask(db, {
      id: "task-orchestrator-run",
      goalId: "goal-1",
      agentRole: "orchestrator",
      status: "assigned",
      assignedTo: "local://worker-test",
      maxRetries: 0,
    });

    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    try {
      const pool = new LocalWorkerPool({
        db,
        conway: new MockConwayClient(),
        inference: workerInference as any,
        harnessRegistry: registry,
        identity: createTestIdentity(),
        config: createTestConfig(),
        allowedEditRoot: process.cwd(),
        workspaceBasePath: path.join(tempHome, ".automaton", "workspace"),
      });

      await (pool as any).runWorker("worker-test", task, new AbortController().signal);
    } finally {
      process.env.HOME = originalHome;
    }

    const row = getTaskById(db, task.id);
    expect(row?.status).toBe("completed");
    expect(row?.result).toMatchObject({ success: true, output: "Delegated the planner-backed work." });

    const delegated = db.prepare(
      "SELECT parent_id AS parentId, title, agent_role AS agentRole FROM task_graph WHERE goal_id = ? AND parent_id = ?",
    ).all("goal-1", "task-orchestrator-run") as Array<{ parentId: string; title: string; agentRole: string | null }>;
    expect(delegated.some((entry) => entry.title === "Implement planned subtask" && entry.agentRole === "executor")).toBe(true);

    const planDir = path.join(tempHome, ".automaton", "workspace", "goal-1", "attempts", task.attemptId!, "subplans", "task-orchestrator-run");
    expect(fs.existsSync(path.join(planDir, "plan.json"))).toBe(true);
    expect(fs.existsSync(path.join(planDir, "plan.md"))).toBe(true);
  });
});

function insertGoal(db: ReturnType<typeof createInMemoryDb>, id: string): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "Goal", "Goal description", "active", new Date().toISOString());
}

function insertTask(
  db: ReturnType<typeof createInMemoryDb>,
  overrides: {
    id: string;
    goalId: string;
    agentRole: string;
    status: string;
    assignedTo: string | null;
    maxRetries: number;
  },
): TaskNode {
  db.prepare(
    `INSERT INTO task_graph (
      id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies, max_retries, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id,
    overrides.goalId,
    "Task",
    "Task description",
    overrides.status,
    overrides.assignedTo,
    overrides.agentRole,
    50,
    JSON.stringify([]),
    overrides.maxRetries,
    new Date().toISOString(),
  );

  if (overrides.status === "assigned" || overrides.status === "running") {
    db.prepare("UPDATE task_graph SET attempt_id = ? WHERE id = ?").run(ulid(), overrides.id);
  }

  const row = getTaskById(db, overrides.id);
  if (!row) {
    throw new Error(`Failed to load task ${overrides.id}`);
  }

  return {
    id: row.id,
    parentId: row.parentId,
    goalId: row.goalId,
    title: row.title,
    description: row.description,
    status: row.status,
    assignedTo: row.assignedTo,
    attemptId: row.attemptId,
    agentRole: row.agentRole,
    priority: row.priority,
    dependencies: row.dependencies,
    result: row.result as TaskResult | null,
    metadata: {
      estimatedCostCents: row.estimatedCostCents,
      actualCostCents: row.actualCostCents,
      maxRetries: row.maxRetries,
      retryCount: row.retryCount,
      timeoutMs: row.timeoutMs,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
