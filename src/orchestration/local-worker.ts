/**
 * Local Agent Worker
 *
 * Runs inference-driven task execution in-process as an async background task.
 * Each worker executes through a harness chosen by role via HarnessRegistry.
 */

import path from "node:path";
import os from "node:os";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";
import type { HarnessContext, WorkerInferenceClient } from "../agent/harness-types.js";
import { buildWisdomFromGoal, createBudgetFromTask } from "../agent/harness-types.js";
import { HarnessRegistry } from "../agent/harness-registry.js";
import { completeTask, failTask, taskFailureResult } from "./task-graph.js";
import type { TaskNode } from "./task-graph.js";
import { AgentWorkspace } from "./workspace.js";
import { getTaskById } from "../state/database.js";
import { TaskAttemptScope, type TaskAttempt } from "./task-attempt.js";
import { seedAttemptWorkspace, publishAttemptWorkspace } from "./workspace-publication.js";
import type {
  AutomatonConfig,
  AutomatonIdentity,
  AutomatonTool,
  ConwayClient,
  InputSource,
  SpendTrackerInterface,
  ToolContext,
} from "../types.js";
import type { Database } from "better-sqlite3";
import type { PolicyEngine } from "../agent/policy-engine.js";

const logger = createLogger("orchestration.local-worker");
const DEFAULT_ALLOWED_EDIT_ROOT = process.cwd();
type ActiveWorkers = Map<string, { promise: Promise<void>; abortController: AbortController; attemptId: string }>;
// A sleeping loop may construct another pool while its workers are still running.
// Keep liveness for the lifetime of the database connection, not the loop cycle.
const workersByDatabase = new WeakMap<Database, ActiveWorkers>();

interface LocalWorkerConfig {
  db: Database;
  inference: WorkerInferenceClient;
  conway: ConwayClient;
  maxTurns?: number;
  harnessRegistry: HarnessRegistry;
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  allowedEditRoot?: string;
  workspaceBasePath?: string;
  tools?: AutomatonTool[];
  toolContext?: ToolContext;
  policyEngine?: PolicyEngine;
  spendTracker?: SpendTrackerInterface;
  inputSource?: InputSource;
}

export class LocalWorkerPool {
  private readonly activeWorkers: ActiveWorkers;

  constructor(private readonly config: LocalWorkerConfig) {
    this.activeWorkers = workersByDatabase.get(config.db) ?? new Map();
    workersByDatabase.set(config.db, this.activeWorkers);
  }

  private ownsTask(workerId: string, taskId: string, attemptId: string): boolean {
    const task = getTaskById(this.config.db, taskId);
    return !!attemptId && task?.attemptId === attemptId && task.assignedTo === `local://${workerId}` &&
      (task.status === "assigned" || task.status === "running");
  }

  spawn(task: TaskNode): { address: string; name: string; sandboxId: string; attemptId: string } {
    const attemptId = task.attemptId ?? ulid();
    const workerTask = { ...task, attemptId };
    const workerId = `local-worker-${ulid()}`;
    const workerName = `worker-${task.agentRole ?? "generalist"}-${workerId.slice(-6)}`;
    const address = `local://${workerId}`;
    const abortController = new AbortController();

    // Let the orchestrator persist the assignment returned by spawn before even
    // an immediately resolving harness can publish its result.
    const workerPromise = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.runWorker(workerId, workerTask, abortController.signal))
      .catch((error) => {
        logger.error("Local worker crashed", error instanceof Error ? error : new Error(String(error)), {
          workerId,
          taskId: task.id,
        });
        try {
          if (!this.ownsTask(workerId, task.id, attemptId)) return;
          failTask(
            this.config.db,
            task.id,
            `Worker crashed: ${error instanceof Error ? error.message : String(error)}`,
            true,
            { taskId: task.id, workerAddress: address, attemptId },
            taskFailureResult(error),
          );
        } catch {
          // Task may already be in a terminal state.
        }
      })
      .finally(() => {
        this.activeWorkers.delete(workerId);
      });

    this.activeWorkers.set(workerId, { promise: workerPromise, abortController, attemptId });
    return { address, name: workerName, sandboxId: workerId, attemptId };
  }

  getActiveCount(): number {
    return this.activeWorkers.size;
  }

  hasWorker(addressOrId: string, attemptId?: string): boolean {
    const id = addressOrId.replace("local://", "");
    const worker = this.activeWorkers.get(id);
    return !!worker && (!attemptId || worker.attemptId === attemptId);
  }

  async shutdown(): Promise<void> {
    const stopping = [...this.activeWorkers.values()];
    for (const worker of stopping) {
      worker.abortController.abort();
    }
    // Each worker removes only its own entry in finally. Workers spawned while
    // shutdown waits belong to the next cycle and must remain visible.
    await Promise.allSettled(stopping.map((worker) => worker.promise));
  }

  private async runWorker(workerId: string, task: TaskNode, signal: AbortSignal): Promise<void> {
    const attempt: TaskAttempt = { taskId: task.id, workerAddress: `local://${workerId}`, attemptId: task.attemptId ?? "" };
    const scope = new TaskAttemptScope(this.config.db, attempt);
    return scope.run(() => this.executeWorker(workerId, task, signal, scope));
  }

  private async executeWorker(workerId: string, task: TaskNode, signal: AbortSignal, scope: TaskAttemptScope): Promise<void> {
    scope.assertActive();
    const harness = this.config.harnessRegistry.createForRole(task.agentRole);
    // Planner artifacts are private to the attempt; stale plans cannot overwrite
    // files read by a later attempt. Project/tool writes still need isolation.
    const workspace = new AgentWorkspace(
      task.goalId,
      path.join(this.config.workspaceBasePath ?? path.join(os.homedir(), ".automaton", "workspace"),
        task.goalId, "attempts", scope.attempt.attemptId),
    );
    const initialWorkspace = scope.write(scope.db, () => seedAttemptWorkspace(
      this.config.db,
      new AgentWorkspace(task.goalId, path.dirname(path.dirname(workspace.basePath))),
      workspace,
    ));
    const allowedEditRoot = path.resolve(this.config.allowedEditRoot ?? DEFAULT_ALLOWED_EDIT_ROOT);
    const workerIdentity = createWorkerIdentity(this.config.identity, workerId, task.agentRole);
    const context: HarnessContext = {
      workspaceRoot: workspace.basePath,
      allowedEditRoot,
      workspace: scope.guardSynchronousOperations(workspace),
      identity: workerIdentity,
      config: this.config.config,
      db: scope.db,
      conway: scope.guardOperations(this.config.conway),
      inference: {
        chat: async (params) => {
          scope.assertActive();
          const result = await this.config.inference.chat(params);
          scope.assertActive();
          return result;
        },
      },
      budget: createBudgetFromTask(task),
      wisdom: buildWisdomFromGoal(this.config.db, task.goalId, workspace),
      abortSignal: signal,
      assertActive: scope.assertActive,
      attemptId: scope.attempt.attemptId,
      goalId: task.goalId,
      toolCatalog: this.config.tools,
      toolContext: this.config.toolContext
        ? {
            ...this.config.toolContext,
            identity: workerIdentity,
            db: scope.guardAutomatonDatabase(this.config.toolContext.db),
            conway: scope.guardOperations(this.config.toolContext.conway),
            social: this.config.toolContext.social ? scope.guardOperations(this.config.toolContext.social) : undefined,
          }
        : undefined,
      policyEngine: this.config.policyEngine ? scope.guardSynchronousOperations(this.config.policyEngine) : undefined,
      spendTracker: this.config.spendTracker ? scope.guardSynchronousOperations(this.config.spendTracker) : undefined,
      inputSource: this.config.inputSource,
    };

    if (this.config.maxTurns) {
      context.budget.maxTurns = this.config.maxTurns;
    }
    if (harness.id === "orchestrator" && !this.config.maxTurns) {
      context.budget.maxTurns = Math.max(context.budget.maxTurns, 50);
    }

    logger.info(
      `[WORKER ${workerId}] Starting task "${task.title}" (${task.id}), role: ${task.agentRole ?? "generalist"}, harness: ${harness.id}`,
    );

    try {
      await harness.initialize(task, context);
      const result = await harness.execute();

      if (!this.ownsTask(workerId, task.id, scope.attempt.attemptId)) return;

      if (result.success) {
        scope.write(scope.db, () => {
          publishAttemptWorkspace(this.config.db, workspace, initialWorkspace, scope.attempt);
          completeTask(this.config.db, task.id, result, scope.attempt);
        });
        logger.info("Local worker completed task", {
          workerId,
          taskId: task.id,
          title: task.title,
          duration: result.duration,
          harness: harness.id,
        });
      } else {
        failTask(this.config.db, task.id, result.output || "Task reported failure", true, scope.attempt, result);
        logger.warn("Local worker reported task failure", {
          workerId,
          taskId: task.id,
          title: task.title,
          harness: harness.id,
          output: result.output.slice(0, 200),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[WORKER ${workerId}] Harness execution failed: ${message}`);
      if (!this.ownsTask(workerId, task.id, scope.attempt.attemptId)) return;
      failTask(this.config.db, task.id, message, true, scope.attempt, taskFailureResult(error));
    }
  }
}

function createWorkerIdentity(
  parentIdentity: AutomatonIdentity,
  workerId: string,
  role: string | null,
): AutomatonIdentity {
  return {
    ...parentIdentity,
    name: `worker-${role ?? "generalist"}-${workerId.slice(-6)}`,
    address: `local://${workerId}`,
    sandboxId: workerId,
  };
}
