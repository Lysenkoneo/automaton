import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInMemoryDb } from "./test-db.js";
import { createDatabase, getTaskById, insertTask, withTransaction } from "../../state/database.js";
import { CREATE_TABLES, MIGRATION_V9, MIGRATION_V10, MIGRATION_V11 } from "../../state/schema.js";
import { assignTask, completeTask, decomposeGoal, failTask } from "../../orchestration/task-graph.js";
import { assertTaskAttempt, StaleTaskAttemptError, TaskAttemptScope } from "../../orchestration/task-attempt.js";
import { GeneralHarness } from "../../agent/harnesses/general-harness.js";
import { AgentWorkspace } from "../../orchestration/workspace.js";
import { createTestConfig, createTestIdentity } from "../mocks.js";
import type { AutomatonDatabase, ConwayClient } from "../../types.js";

const RESULT = { success: true, output: "done", artifacts: [], costCents: 3, duration: 1 };

describe("task attempt ownership", () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let tempDir: string;

  beforeEach(() => {
    db = createInMemoryDb();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-attempt-"));
    db.prepare("INSERT INTO goals (id,title,description,status,created_at) VALUES ('goal','Goal','Goal','active',datetime('now'))").run();
    db.prepare("INSERT INTO task_graph (id,goal_id,title,description,status,dependencies,created_at) VALUES ('task','goal','Task','Task','pending','[]',datetime('now'))").run();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function attempt(address = "local://same") {
    return { taskId: "task", workerAddress: address, attemptId: assignTask(db, "task", address) };
  }

  function reassign(address = "local://same") {
    failTask(db, "task", "retry", true);
    return attempt(address);
  }

  it("creates fresh persisted IDs for retries at the same address and records the result's ID", () => {
    const first = attempt();
    expect(getTaskById(db, "task")?.attemptId).toBe(first.attemptId);
    failTask(db, "task", "retry", true, first);
    expect(getTaskById(db, "task")).toMatchObject({ status: "pending", assignedTo: null, attemptId: null, retryCount: 1 });
    expect(getTaskById(db, "task")?.result).toMatchObject({ attemptId: first.attemptId, success: false });
    const second = attempt();
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(() => assertTaskAttempt(db, first)).toThrow(StaleTaskAttemptError);
    completeTask(db, "task", RESULT, second);
    expect(getTaskById(db, "task")?.result).toMatchObject({ ...RESULT, attemptId: second.attemptId });
  });

  it("cannot reuse a retired token after recovery or retry", () => {
    const first = attempt();
    failTask(db, "task", "retry", true, first);
    expect(() => assignTask(db, "task", first.workerAddress, first.attemptId)).toThrow(/UNIQUE/);
    expect(getTaskById(db, "task")).toMatchObject({ status: "pending", attemptId: null, assignedTo: null });
    const next = attempt();
    expect(next.attemptId).not.toBe(first.attemptId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_attempts WHERE task_id='task'").get()).toEqual({ count: 2 });
  });

  it("gives tasks inserted already assigned their own persisted attempt", () => {
    const id = insertTask(db, { goalId: "goal", title: "Assigned", description: "Assigned", status: "assigned", assignedTo: "worker" });
    const row = getTaskById(db, id)!;
    expect(row.attemptId).toEqual(expect.any(String));
    expect(db.prepare("SELECT task_id, worker_address FROM task_attempts WHERE attempt_id=?").get(row.attemptId))
      .toEqual({ task_id: id, worker_address: "worker" });
  });

  it.each(["local://same", "local://other"])("rejects explicit old complete/fail calls after reassignment to %s", (address) => {
    const first = attempt();
    reassign(address);
    const before = getTaskById(db, "task");
    expect(() => completeTask(db, "task", RESULT, first)).toThrow(StaleTaskAttemptError);
    expect(() => failTask(db, "task", "late failure", true, first)).toThrow(StaleTaskAttemptError);
    expect(getTaskById(db, "task")).toEqual(before);
  });

  it.each(["complete", "fail"])("rejects an inherited late %s call with the captured raw connection", async (operation) => {
    const first = attempt();
    const scope = new TaskAttemptScope(db, first);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = scope.run(async () => {
      await gate;
      if (operation === "complete") completeTask(db, "task", RESULT);
      else failTask(db, "task", "late", true);
    });
    reassign();
    const before = getTaskById(db, "task");
    release();
    await expect(running).rejects.toThrow(StaleTaskAttemptError);
    expect(getTaskById(db, "task")).toEqual(before);
  });

  it.each(["run", "get", "all", "iterate", "transaction", "complete", "fail", "graph", "automaton"])(
    "rejects late shared-state writes through %s, including previously prepared statements", (operation) => {
      const scope = new TaskAttemptScope(db, attempt());
      const statement = scope.db.prepare("INSERT INTO kv (key,value,updated_at) VALUES (?, 'late', datetime('now')) RETURNING key").bind("late");
      const automaton = scope.guardAutomatonDatabase({
        raw: db,
        setKV: (key: string, value: string) => {
          db.prepare("INSERT INTO kv (key,value,updated_at) VALUES (?,?,datetime('now'))").run(key, value);
        },
      } as AutomatonDatabase);
      reassign();
      const before = getTaskById(db, "task");
      const write = () => {
        if (operation === "run") statement.run();
        if (operation === "get") statement.get();
        if (operation === "all") statement.all();
        if (operation === "iterate") statement.iterate().next();
        if (operation === "transaction") scope.db.transaction(() => statement.run())();
        if (operation === "complete") completeTask(scope.db, "task", RESULT);
        if (operation === "fail") failTask(scope.db, "task", "late", true);
        if (operation === "graph") decomposeGoal(scope.db, "goal", [{
          parentId: "task", goalId: "goal", title: "Late child", description: "Late child", status: "pending",
          assignedTo: null, agentRole: "generalist", priority: 50, dependencies: [], result: null,
        }]);
        if (operation === "automaton") automaton.setKV("late", "late");
      };
      expect(write).toThrow(StaleTaskAttemptError);
      expect(getTaskById(db, "task")).toEqual(before);
      expect(db.prepare("SELECT * FROM kv WHERE key='late'").get()).toBeUndefined();
      expect(db.prepare("SELECT COUNT(*) AS count FROM task_graph").get()).toEqual({ count: 1 });
    },
  );

  it("keeps normal compound writes atomic even when they complete the owning task", () => {
    const scope = new TaskAttemptScope(db, attempt());
    scope.run(() => completeTask(scope.db, "task", RESULT));
    expect(getTaskById(db, "task")?.result).toMatchObject({ ...RESULT, attemptId: scope.attempt.attemptId });
    expect(() => scope.db.prepare("UPDATE task_graph SET title='late' WHERE id='task'").run())
      .toThrow(StaleTaskAttemptError);
  });

  it("rolls back all changes in a failed scoped transaction", () => {
    const scope = new TaskAttemptScope(db, attempt());
    expect(() => withTransaction(scope.db, () => {
      scope.db.prepare("UPDATE task_graph SET title='temporary' WHERE id='task'").run();
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(getTaskById(db, "task")?.title).toBe("Task");
  });

  it("rolls back a nested transaction even if the outer transaction catches its error", () => {
    const scope = new TaskAttemptScope(db, attempt());
    scope.db.transaction(() => {
      scope.db.prepare("UPDATE task_graph SET title='outer' WHERE id='task'").run();
      try {
        withTransaction(scope.db, () => {
          scope.db.prepare("UPDATE task_graph SET description='nested' WHERE id='task'").run();
          throw new Error("nested rollback");
        });
      } catch { /* The outer write should still commit. */ }
    })();
    expect(getTaskById(db, "task")).toMatchObject({ title: "outer", description: "Task" });
  });

  it("revokes clients created before reassignment and synchronous state helpers", () => {
    const scope = new TaskAttemptScope(db, attempt());
    let calls = 0;
    const conway = scope.guardOperations({ createScopedClient: () => ({ writeFile: () => { calls++; } }) });
    const childClient = conway.createScopedClient();
    const recorder = scope.guardSynchronousOperations({ record: () => {
      db.prepare("UPDATE task_graph SET description='late' WHERE id='task'").run();
    } });
    reassign();
    expect(() => childClient.writeFile()).toThrow(StaleTaskAttemptError);
    expect(() => recorder.record()).toThrow(StaleTaskAttemptError);
    expect(calls).toBe(0);
    expect(getTaskById(db, "task")?.description).toBe("Task");
  });

  it("migrates a V11 database without discarding tasks and persists attempts across reopen", () => {
    const file = path.join(tempDir, "state.db");
    const legacy = new Database(file);
    legacy.exec(CREATE_TABLES);
    legacy.exec(MIGRATION_V9);
    legacy.exec(MIGRATION_V10);
    legacy.exec(MIGRATION_V11);
    legacy.prepare("INSERT INTO schema_version(version) VALUES (11)").run();
    legacy.prepare("INSERT INTO goals (id,title,description,status,created_at) VALUES ('g','Goal','Goal','active',datetime('now'))").run();
    legacy.prepare("INSERT INTO task_graph (id,goal_id,title,description,status,dependencies,created_at) VALUES ('t','g','Task','Task','pending','[]',datetime('now'))").run();
    legacy.close();
    const migrated = createDatabase(file);
    const token = assignTask(migrated.raw, "t", "worker");
    migrated.close();
    const reopened = createDatabase(file);
    try {
      expect(getTaskById(reopened.raw, "t")).toMatchObject({ title: "Task", assignedTo: "worker", attemptId: token });
      expect(reopened.raw.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: 12 });
    } finally { reopened.close(); }
  });

  it("checks ownership while holding the SQLite write lock against another connection", () => {
    const file = path.join(tempDir, "locked.db");
    const first = createDatabase(file);
    first.raw.prepare("INSERT INTO goals (id,title,description,status,created_at) VALUES ('g','Goal','Goal','active',datetime('now'))").run();
    first.raw.prepare("INSERT INTO task_graph (id,goal_id,title,description,status,dependencies,created_at) VALUES ('t','g','Task','Task','pending','[]',datetime('now'))").run();
    const token = assignTask(first.raw, "t", "worker");
    const second = new Database(file, { timeout: 0 });
    const scope = new TaskAttemptScope(first.raw, { taskId: "t", workerAddress: "worker", attemptId: token });
    try {
      scope.write(scope.db, () => {
        expect(() => second.prepare("UPDATE task_graph SET attempt_id='new' WHERE id='t'").run())
          .toThrow(/locked/);
        scope.db.prepare("UPDATE task_graph SET title='owned write' WHERE id='t'").run();
      });
      second.prepare("UPDATE task_graph SET attempt_id='new' WHERE id='t'").run();
      expect(() => scope.db.prepare("UPDATE task_graph SET title='late' WHERE id='t'").run()).toThrow(StaleTaskAttemptError);
      expect(getTaskById(first.raw, "t")?.title).toBe("owned write");
    } finally { second.close(); first.close(); }
  });

  it("rolls V12 back on a DDL conflict without changing existing task data or schema version", () => {
    const file = path.join(tempDir, "migration-conflict.db");
    const legacy = new Database(file);
    legacy.exec(CREATE_TABLES); legacy.exec(MIGRATION_V9); legacy.exec(MIGRATION_V10); legacy.exec(MIGRATION_V11);
    legacy.prepare("INSERT INTO schema_version(version) VALUES (11)").run();
    legacy.prepare("INSERT INTO goals(id,title,description,status,created_at) VALUES ('g','Goal','Goal','active',datetime('now'))").run();
    legacy.prepare("INSERT INTO task_graph(id,goal_id,title,description,status,assigned_to,dependencies,result,created_at) VALUES ('t','g','Task','Data','running','worker','[]','{\"important\":true}',datetime('now'))").run();
    // Simulate an inconsistent preexisting schema; the second V12 instruction fails.
    legacy.exec("CREATE TABLE task_attempts (existing_data TEXT)");
    legacy.prepare("INSERT INTO task_attempts VALUES ('preserve')").run();
    const before = legacy.prepare("SELECT * FROM task_graph").all();
    legacy.close();
    expect(() => createDatabase(file)).toThrow(/already exists/);
    const reopened = new Database(file);
    try {
      expect(reopened.prepare("SELECT * FROM task_graph").all()).toEqual(before);
      expect(reopened.prepare("SELECT * FROM task_attempts").all()).toEqual([{ existing_data: "preserve" }]);
      expect(reopened.prepare("SELECT MAX(version) AS v FROM schema_version").get()).toEqual({ v: 11 });
      expect(reopened.pragma("table_info(task_graph)")).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "attempt_id" })]));
      expect(reopened.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally { reopened.close(); }
  });

  it("rejects a database wrapper backed by a different connection before it writes", () => {
    const other = createInMemoryDb();
    try {
      const scope = new TaskAttemptScope(db, attempt());
      expect(() => scope.guardAutomatonDatabase({ raw: other } as AutomatonDatabase)).toThrow(/another connection/);
    } finally { other.close(); }
  });

  it("cannot commit a stale write from an inherited deferred WAL transaction", () => {
    const file = path.join(tempDir, "snapshot.db");
    const first = createDatabase(file);
    const second = new Database(file, { timeout: 0 });
    first.raw.prepare("INSERT INTO goals(id,title,description,status,created_at) VALUES ('g','Goal','Goal','active',datetime('now'))").run();
    const id = insertTask(first.raw, { goalId: "g", title: "Original", description: "Task" });
    const token = assignTask(first.raw, id, "worker");
    const scope = new TaskAttemptScope(first.raw, { taskId: id, workerAddress: "worker", attemptId: token });
    try {
      expect(() => first.raw.transaction(() => {
        first.raw.prepare("SELECT * FROM task_graph WHERE id=?").get(id);
        second.prepare("UPDATE task_graph SET attempt_id='new' WHERE id=?").run(id);
        scope.db.prepare("UPDATE task_graph SET title='stale' WHERE id=?").run(id);
      })()).toThrow(/locked/);
      expect(getTaskById(first.raw, id)).toMatchObject({ title: "Original", attemptId: "new" });
    } finally { second.close(); first.close(); }
  });

  it("preserves deferred read transactions while another WAL connection holds the write lock", () => {
    const file = path.join(tempDir, "read-lock.db");
    const first = createDatabase(file);
    first.raw.pragma("busy_timeout = 0");
    first.raw.prepare("INSERT INTO goals(id,title,description,status,created_at) VALUES ('g','Goal','Goal','active',datetime('now'))").run();
    const id = insertTask(first.raw, { goalId: "g", title: "Original", description: "Task" });
    const token = assignTask(first.raw, id, "worker");
    const scope = new TaskAttemptScope(first.raw, { taskId: id, workerAddress: "worker", attemptId: token });
    const second = new Database(file, { timeout: 0 });
    try {
      second.exec("BEGIN IMMEDIATE");
      second.prepare("UPDATE task_graph SET title='uncommitted' WHERE id=?").run(id);
      expect(withTransaction(first.raw, () => getTaskById(first.raw, id)?.title)).toBe("Original");
      const read = scope.db.transaction(() => scope.db.prepare("SELECT title FROM task_graph WHERE id=?").get(id));
      expect(read.deferred()).toEqual({ title: "Original" });
      expect(() => read.immediate()).toThrow(/locked/);
    } finally { second.exec("ROLLBACK"); second.close(); first.close(); }
  });

  it("honors exclusive scoped transactions and rolls a nested savepoint back independently", () => {
    const file = path.join(tempDir, "exclusive.db");
    const first = createDatabase(file);
    first.raw.pragma("journal_mode = DELETE");
    first.raw.prepare("INSERT INTO goals(id,title,description,status,created_at) VALUES ('g','Goal','Goal','active',datetime('now'))").run();
    const id = insertTask(first.raw, { goalId: "g", title: "Original", description: "Task" });
    const token = assignTask(first.raw, id, "worker");
    const second = new Database(file, { timeout: 0 });
    const read = second.prepare("SELECT title FROM task_graph WHERE id=?");
    const scope = new TaskAttemptScope(first.raw, { taskId: id, workerAddress: "worker", attemptId: token });
    try {
      scope.db.transaction(() => {
        expect(() => read.get(id)).toThrow(/locked/);
        scope.db.prepare("UPDATE task_graph SET title='outer' WHERE id=?").run(id);
        expect(() => scope.db.transaction(() => {
          scope.db.prepare("UPDATE task_graph SET title='inner' WHERE id=?").run(id);
          throw new Error("inner rollback");
        }).deferred()).toThrow("inner rollback");
      }).exclusive();
      expect(read.get(id)).toEqual({ title: "outer" });
    } finally { second.close(); first.close(); }
  });

  it("rejects a local file fallback when ownership changes while the remote write awaits", async () => {
    const first = attempt();
    const scope = new TaskAttemptScope(db, first);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const conway = scope.guardOperations({ writeFile: async () => { await gate; throw new Error("remote unavailable"); } } as unknown as ConwayClient);
    const harness = new GeneralHarness();
    await harness.initialize({
      id: "task", parentId: null, goalId: "goal", title: "Task", description: "Task", status: "assigned",
      assignedTo: first.workerAddress, attemptId: first.attemptId, agentRole: "generalist", priority: 50, dependencies: [], result: null,
      metadata: { estimatedCostCents: 0, actualCostCents: 0, maxRetries: 3, retryCount: 0, timeoutMs: 1000,
        createdAt: new Date().toISOString(), startedAt: null, completedAt: null },
    }, {
      db: scope.db, workspaceRoot: tempDir, allowedEditRoot: tempDir, workspace: new AgentWorkspace("goal", path.join(tempDir, "workspace")),
      identity: createTestIdentity(), config: createTestConfig(), conway,
      inference: { chat: async () => ({ content: "" }) },
      budget: { maxTurns: 1, maxCostCents: 10, timeoutMs: 1000, turnsUsed: 0, costUsedCents: 0, startedAt: 0 },
      wisdom: { conventions: [], successes: [], failures: [], gotchas: [] }, abortSignal: new AbortController().signal,
      goalId: "goal", assertActive: scope.assertActive,
    });
    const writing = harness.getToolDefs().find((tool) => tool.name === "write_file")!
      .execute({ path: "late.txt", content: "late" });
    reassign();
    release();
    await expect(writing).rejects.toThrow(StaleTaskAttemptError);
    expect(fs.existsSync(path.join(tempDir, "late.txt"))).toBe(false);
  });
});
