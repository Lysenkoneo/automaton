import fs from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { AgentWorkspace } from "./workspace.js";
import { assertTaskAttempt, withAttemptTransaction, type TaskAttempt } from "./task-attempt.js";

interface PublishedWorkspace {
  outputs: Record<string, { content: string; role: string }>;
  decisions: string;
  deletedOutputs?: string[];
}

function key(goalId: string): string { return `worker.workspace.${goalId}`; }

function published(db: Database, goalId: string): PublishedWorkspace {
  const row = db.prepare("SELECT value FROM kv WHERE key=?").get(key(goalId)) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : { outputs: {}, decisions: "" };
}

function mergeOutputs(existing: PublishedWorkspace, committed: PublishedWorkspace): PublishedWorkspace["outputs"] {
  const outputs = { ...existing.outputs, ...committed.outputs };
  for (const name of committed.deletedOutputs ?? []) delete outputs[name];
  return outputs;
}

function capture(workspace: AgentWorkspace): PublishedWorkspace {
  const outputs = Object.fromEntries(workspace.listOutputs().map((file) => [
    path.relative(path.join(workspace.basePath, "outputs"), file.path),
    { content: fs.readFileSync(file.path, "utf8"), role: file.agentRole },
  ]));
  const decisionsPath = path.join(workspace.basePath, "context", "decisions.md");
  return { outputs, decisions: fs.existsSync(decisionsPath) ? fs.readFileSync(decisionsPath, "utf8") : "" };
}

function restore(workspace: AgentWorkspace, snapshot: PublishedWorkspace): void {
  for (const [name, output] of Object.entries(snapshot.outputs)) workspace.writeOutput(output.role, name, output.content);
  fs.writeFileSync(path.join(workspace.basePath, "context", "decisions.md"), snapshot.decisions, "utf8");
}

/** Seed a private attempt with committed goal artifacts, including preexisting files. */
export function seedAttemptWorkspace(db: Database, goal: AgentWorkspace, attempt: AgentWorkspace): PublishedWorkspace {
  const existing = capture(goal);
  const committed = published(db, goal.goalId);
  const snapshot = {
    outputs: mergeOutputs(existing, committed),
    decisions: existing.decisions + committed.decisions,
  };
  restore(attempt, snapshot);
  return snapshot;
}

/** Fence at the publication source, including direct calls with a captured connection. */
export function publishAttemptWorkspace(db: Database, workspace: AgentWorkspace, initial: PublishedWorkspace, attempt: TaskAttempt): void {
  withAttemptTransaction(db, () => {
    assertTaskAttempt(db, attempt);
    const task = db.prepare("SELECT goal_id FROM task_graph WHERE id=?").get(attempt.taskId) as { goal_id: string };
    if (task.goal_id !== workspace.goalId) throw new Error("Workspace goal does not match task attempt");
    const current = capture(workspace);
    const latest = published(db, workspace.goalId);
    const deleted = new Set(latest.deletedOutputs ?? []);
    for (const name of Object.keys(initial.outputs)) {
      if (!(name in current.outputs)) { delete latest.outputs[name]; deleted.add(name); }
    }
    for (const [name, output] of Object.entries(current.outputs)) {
      if (output.content !== initial.outputs[name]?.content) {
        latest.outputs = { ...latest.outputs, [name]: output };
        deleted.delete(name);
      }
    }
    latest.deletedOutputs = [...deleted];
    // logDecision only appends. Do not republish inherited decisions or allow
    // one attempt to erase decisions published concurrently by another task.
    if (!current.decisions.startsWith(initial.decisions)) throw new Error("Attempt cannot rewrite inherited decisions");
    latest.decisions += current.decisions.slice(initial.decisions.length);
    db.prepare("INSERT OR REPLACE INTO kv (key,value,updated_at) VALUES (?,?,datetime('now'))")
      .run(key(workspace.goalId), JSON.stringify(latest));
  });
}

/** Parent planners see committed artifacts through a private snapshot too. */
export function createPublishedGoalWorkspace(db: Database, goalId: string, basePath?: string): AgentWorkspace {
  const goal = new AgentWorkspace(goalId, basePath);
  const snapshot = published(db, goalId);
  // Keep the original goal directory authoritative for parent-owned files.
  // Never copy worker data there: a worker may still have a shell writing it.
  const viewsPath = path.join(goal.basePath, "views");
  fs.mkdirSync(viewsPath, { recursive: true });
  const view = new AgentWorkspace(goalId, fs.mkdtempSync(path.join(viewsPath, "parent-")));
  const existing = capture(goal);
  restore(view, { outputs: mergeOutputs(existing, snapshot), decisions: existing.decisions + snapshot.decisions });
  return view;
}
