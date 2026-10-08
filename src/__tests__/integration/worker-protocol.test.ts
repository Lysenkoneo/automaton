import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase, getTaskById, insertTask } from "../../state/database.js";
import { CREATE_TABLES, MIGRATION_V9, MIGRATION_V10, MIGRATION_V11 } from "../../state/schema.js";
import { Orchestrator } from "../../orchestration/orchestrator.js";
import { ColonyMessaging, LocalDBTransport, SocialRelayTransport, validateOutgoingTaskContent } from "../../orchestration/messaging.js";
import { assignTask, createGoal, failTask, completeTask } from "../../orchestration/task-graph.js";
import { TaskAttemptScope } from "../../orchestration/task-attempt.js";
import { createTestIdentity } from "../mocks.js";
import { sendToChild, sendToParent } from "../../replication/messaging.js";
import { createBuiltinTools } from "../../agent/tools.js";
import type { AutomatonDatabase, SocialClientInterface, ToolContext } from "../../types.js";

const RESULT = { success: true, output: "remote done", artifacts: [], costCents: 0, duration: 1 };

describe("integration/worker attempt protocol", () => {
  let dir: string;
  const databases: AutomatonDatabase[] = [];
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-protocol-")); });
  afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  function open(name: string, address: string) {
    const db = createDatabase(path.join(dir, name));
    db.setIdentity("address", address); databases.push(db); return db;
  }
  function orchestrator(db: AutomatonDatabase, messaging: ColonyMessaging, alive = () => true) {
    const identity = createTestIdentity();
    return new Orchestrator({
      db: db.raw, identity, messaging, isWorkerAlive: alive,
      agentTracker: { getIdle: () => [{ address: "0xchild", name: "Child", role: "generalist", status: "healthy" }], getBestForTask: () => null, register: vi.fn(), updateStatus: vi.fn() },
      funding: { fundChild: async () => ({ success: true }), recallCredits: async () => ({ success: true, amountCents: 0 }), getBalance: async () => 1000 },
      inference: {} as any, config: { disableSpawn: true, defaultTaskFundingCents: 0 },
    });
  }
  function ready(db: AutomatonDatabase) {
    const goal = createGoal(db.raw, "Goal", "Goal");
    const taskId = insertTask(db.raw, { goalId: goal.id, title: "Task", description: "Task" });
    db.setKV("orchestrator.state", JSON.stringify({ phase: "executing", goalId: goal.id, replanCount: 0 }));
    return taskId;
  }

  it("exchanges an assignment and a bound result across two databases, preserving the receipt after restart", async () => {
    const parent = open("parent.db", createTestIdentity().address);
    let child = open("child.db", "0xchild");
    const route = (to: string) => to === "0xchild" ? child : parent;
    const parentMessaging = new ColonyMessaging(new LocalDBTransport(parent, route), parent);
    const taskId = ready(parent);
    const orc = orchestrator(parent, parentMessaging);
    expect((await orc.tick()).tasksAssigned).toBe(1);
    const workerMessaging = new ColonyMessaging(new LocalDBTransport(child, route), child);
    const [entry] = await workerMessaging.processInbox();
    expect(entry.success).toBe(true);
    const token = getTaskById(parent.raw, taskId)!.attemptId!;
    expect(entry.message.attemptId).toBe(token);
    expect(JSON.parse(entry.message.content).attemptId).toBe(token);
    child.close(); databases.splice(databases.indexOf(child), 1);
    child = open("child.db", "0xchild");
    const resumed = new ColonyMessaging(new LocalDBTransport(child, route), child);
    const received = resumed.getReceivedTaskAssignment(token)!;
    await resumed.executeTaskAssignment(received, async (assignment) => {
      expect(Object.isFrozen(assignment)).toBe(true);
      expect(assignment.attemptId).toBe(token); return RESULT;
    });
    expect((await orc.tick()).tasksCompleted).toBe(1);
    expect(getTaskById(parent.raw, taskId)).toMatchObject({ status: "completed", result: { ...RESULT, attemptId: token } });
  });

  it("processes a queued valid result before dead-worker recovery", async () => {
    const parent = open("parent.db", createTestIdentity().address);
    const child = open("child.db", "0xchild");
    const taskId = ready(parent);
    const token = assignTask(parent.raw, taskId, "0xchild");
    const producer = new ColonyMessaging(new LocalDBTransport(child, () => parent), child);
    await producer.send(producer.createMessage({ type: "task_result", to: createTestIdentity().address, taskId, attemptId: token, content: JSON.stringify({ taskId, result: RESULT }) }));
    const messaging = new ColonyMessaging(new LocalDBTransport(parent), parent);
    const tick = await orchestrator(parent, messaging, () => false).tick();
    expect(tick.tasksCompleted).toBe(1);
    expect(tick.tasksAssigned).toBe(0);
    expect(getTaskById(parent.raw, taskId)).toMatchObject({ status: "completed", attemptId: token });
  });

  function enqueue(db: AutomatonDatabase, message: any) {
    db.raw.prepare("INSERT INTO inbox_messages (id,from_address,to_address,content,received_at,status) VALUES (?,?,?,?,datetime('now'),'received')")
      .run(message.id, message.from, message.to, JSON.stringify(message));
  }

  it("protects only the matching attempt when its result is the 201st queued result", async () => {
    const parent = open("batch.db", createTestIdentity().address);
    const messaging = new ColonyMessaging(new LocalDBTransport(parent), parent);
    const taskId = ready(parent); const token = assignTask(parent.raw, taskId, "0xchild");
    const other = insertTask(parent.raw, { goalId: getTaskById(parent.raw, taskId)!.goalId, title: "dead", description: "dead" });
    const old = assignTask(parent.raw, other, "0xdead");
    parent.runTransaction(() => {
      for (let i = 0; i < 200; i++) enqueue(parent, { ...messaging.createMessage({ type: "task_result", to: "parent", taskId: "missing", attemptId: "irrelevant", content: JSON.stringify({ taskId: "missing", result: RESULT }) }), id: `batch-${String(i).padStart(3, "0")}` });
      enqueue(parent, { ...messaging.createMessage({ type: "task_result", to: "parent", taskId, attemptId: token, content: JSON.stringify({ taskId, result: RESULT }) }), id: "zzz-result", taskId: null, from: "0xchild" });
    });
    const orc = orchestrator(parent, messaging, () => false);
    await orc.tick();
    expect(getTaskById(parent.raw, taskId)?.attemptId).toBe(token);
    expect(getTaskById(parent.raw, other)?.attemptId).not.toBe(old);
    expect((await orc.tick()).tasksCompleted).toBe(1);
  });

  it("ordinary traffic cannot starve results or dead-worker recovery", async () => {
    const parent = open("ordinary.db", createTestIdentity().address);
    const messaging = new ColonyMessaging(new LocalDBTransport(parent), parent);
    const taskId = ready(parent); let token = assignTask(parent.raw, taskId, "0xchild");
    const done = insertTask(parent.raw, { goalId: getTaskById(parent.raw, taskId)!.goalId, title: "done", description: "done" });
    const doneToken = assignTask(parent.raw, done, "0xchild");
    const orc = orchestrator(parent, messaging, () => false);
    for (let tick = 0; tick < 2; tick++) {
      parent.runTransaction(() => {
        for (let i = 0; i < 401; i++) enqueue(parent, messaging.createMessage({ type: "status_report", to: "parent", content: "ordinary" }));
      });
      if (!tick) enqueue(parent, { ...messaging.createMessage({ type: "task_result", to: "parent", taskId: done, attemptId: doneToken, content: JSON.stringify({ taskId: done, result: RESULT }) }), from: "0xchild" });
      await orc.tick();
      expect(getTaskById(parent.raw, done)?.status).toBe("completed");
      expect(getTaskById(parent.raw, taskId)?.attemptId).not.toBe(token);
      token = getTaskById(parent.raw, taskId)!.attemptId!;
      expect(parent.getUnprocessedInboxMessages(1000).length).toBeGreaterThan(200);
    }
  });

  it("quarantines a persistently failing result without blocking others or losing its payload", async () => {
    const parent = open("poison.db", createTestIdentity().address);
    const messaging = new ColonyMessaging(new LocalDBTransport(parent), parent);
    const bad = ready(parent); const badToken = assignTask(parent.raw, bad, "0xchild");
    const good = insertTask(parent.raw, { goalId: getTaskById(parent.raw, bad)!.goalId, title: "good", description: "good" });
    const goodToken = assignTask(parent.raw, good, "0xchild");
    for (const [taskId, attemptId] of [[bad, badToken], [good, goodToken]]) enqueue(parent, { ...messaging.createMessage({ type: "task_result", to: "parent", taskId, attemptId, content: JSON.stringify({ taskId, result: RESULT }) }), from: "0xchild" });
    parent.raw.exec(`CREATE TRIGGER poison BEFORE UPDATE ON task_graph WHEN OLD.id='${bad}' AND NEW.status='completed' BEGIN SELECT RAISE(ABORT,'poison'); END`);
    const orc = orchestrator(parent, messaging, () => false);
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now);
    await orc.tick();
    expect(getTaskById(parent.raw, good)?.status).toBe("completed");
    const row = parent.raw.prepare("SELECT key,value FROM kv WHERE key LIKE 'colony.result.%'").get() as { key: string; value: string };
    const payload = row.value;
    expect(messaging.getPendingTaskResults()).toHaveLength(0); // backoff
    for (const offset of [2000, 5000, 10000]) { vi.mocked(Date.now).mockReturnValue(now + offset); await orc.tick(); }
    expect(JSON.parse(parent.getKV(`colony.result-retry.${row.key}`)!)).toMatchObject({ attempts: 3, quarantined: true });
    expect(parent.getKV(row.key)).toBe(payload);
    expect(getTaskById(parent.raw, bad)?.attemptId).toBe(badToken);
    parent.raw.exec("DROP TRIGGER poison"); messaging.releaseTaskResult(row.key);
    expect((await orc.tick()).tasksCompleted).toBe(1);
  });

  it("quarantines repeated staging failures without acknowledging or blocking later results", async () => {
    const parent = open("source-poison.db", createTestIdentity().address);
    const messaging = new ColonyMessaging(new LocalDBTransport(parent), parent);
    const bad = ready(parent); const token = assignTask(parent.raw, bad, "0xchild");
    const poisoned = { ...messaging.createMessage({ type: "task_result", to: "parent", taskId: bad, attemptId: token, content: JSON.stringify({ taskId: bad, result: RESULT }) }), id: "source-poison", from: "0xchild" };
    enqueue(parent, poisoned);
    parent.raw.exec("CREATE TRIGGER source_failure BEFORE INSERT ON kv WHEN NEW.key='colony.result.source-poison' BEGIN SELECT RAISE(ABORT,'source poison'); END");
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now);
    const orc = orchestrator(parent, messaging, () => false);
    for (const offset of [0, 2000, 5000]) { vi.mocked(Date.now).mockReturnValue(now + offset); await orc.tick(); }
    expect(JSON.parse(parent.getKV("colony.inbox-retry.source-poison")!)).toMatchObject({ attempts: 3, quarantined: true });
    expect(parent.getUnprocessedInboxMessages(10)).toHaveLength(1);
    expect(getTaskById(parent.raw, bad)?.attemptId).toBe(token);
    const good = insertTask(parent.raw, { goalId: getTaskById(parent.raw, bad)!.goalId, title: "good", description: "good" });
    const goodToken = assignTask(parent.raw, good, "0xchild");
    enqueue(parent, { ...messaging.createMessage({ type: "task_result", to: "parent", taskId: good, attemptId: goodToken, content: JSON.stringify({ taskId: good, result: RESULT }) }), from: "0xchild" });
    expect((await orc.tick()).tasksCompleted).toBe(1);
    parent.raw.exec("DROP TRIGGER source_failure"); messaging.releaseInboxMessage(poisoned.id);
    expect((await orc.tick()).tasksCompleted).toBe(1);
  });

  it.each(["messaging", "agent-turn"])("leaves an assignment unacknowledged when receipt persistence fails through %s", async (path) => {
    const child = open("receipt.db", "0xchild");
    const messaging = new ColonyMessaging(new LocalDBTransport(child), child);
    const assignment = messaging.createMessage({ type: "task_assignment", to: "0xchild", taskId: "task", attemptId: "attempt", content: JSON.stringify({ taskId: "task", attemptId: "attempt" }) });
    enqueue(child, assignment);
    child.raw.exec("CREATE TRIGGER receipt_failure BEFORE INSERT ON kv WHEN NEW.key LIKE 'colony.assignment.%' BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
    if (path === "messaging") expect((await messaging.processInbox())[0].success).toBe(false);
    else expect(() => child.markInboxMessageProcessed(assignment.id)).toThrow("receipt failure");
    expect(child.getUnprocessedInboxMessages(10)).toHaveLength(1);
    expect(messaging.getReceivedTaskAssignment("attempt")).toBeNull();
    child.raw.exec("DROP TRIGGER receipt_failure");
    messaging.releaseInboxMessage(assignment.id);
    expect((await messaging.processInbox())[0].success).toBe(true);
    expect(child.getUnprocessedInboxMessages(10)).toHaveLength(0);
    expect(messaging.getReceivedTaskAssignment("attempt")).toEqual(assignment);
  });

  it.each(["messaging", "agent-turn"])("replays a result after a crash following the %s acknowledgement without applying it twice", async (acknowledger) => {
    let parent = open("crash.db", createTestIdentity().address);
    const child = open("child.db", "0xchild");
    const taskId = ready(parent); const token = assignTask(parent.raw, taskId, "0xchild");
    const producer = new ColonyMessaging(new LocalDBTransport(child, () => parent), child);
    const message = producer.createMessage({ type: "task_result", to: createTestIdentity().address, taskId, attemptId: token, content: JSON.stringify({ taskId, result: { ...RESULT, costCents: 7 } }) });
    await producer.send(message);
    const source = parent.raw.prepare("SELECT id FROM inbox_messages LIMIT 1").get() as { id: string };
    const messaging = new ColonyMessaging(new LocalDBTransport(parent), parent);
    if (acknowledger === "messaging") await messaging.processInbox();
    else parent.runTransaction(() => parent.markInboxMessageProcessed(source.id));
    expect(parent.getUnprocessedInboxMessages(10)).toHaveLength(0);
    expect(messaging.getPendingTaskResults()).toHaveLength(1);
    // Restart from the persisted database before any completion was applied.
    parent.close(); databases.splice(databases.indexOf(parent), 1);
    parent = open("crash.db", createTestIdentity().address);
    const resumed = new ColonyMessaging(new LocalDBTransport(parent), parent);
    const orc = orchestrator(parent, resumed, () => false);
    expect((await orc.tick()).tasksCompleted).toBe(1);
    expect(resumed.getPendingTaskResults()).toHaveLength(0);
    expect(getTaskById(parent.raw, taskId)).toMatchObject({ status: "completed", actualCostCents: 7 });
    // A duplicated transport delivery or repeated generic ack is harmless.
    await producer.send(message); parent.markInboxMessageProcessed(source.id);
    parent.setKV("orchestrator.state", JSON.stringify({ phase: "executing", goalId: getTaskById(parent.raw, taskId)!.goalId, replanCount: 0 }));
    expect((await orc.tick()).tasksCompleted).toBe(0);
    expect(getTaskById(parent.raw, taskId)?.actualCostCents).toBe(7);
    expect(resumed.getPendingTaskResults()).toHaveLength(0);
  });

  it("rolls completion and dequeue back together and retries a storage failure without failing the goal", async () => {
    const parent = open("rollback.db", createTestIdentity().address);
    const child = open("child.db", "0xchild");
    const taskId = ready(parent); const token = assignTask(parent.raw, taskId, "0xchild");
    const producer = new ColonyMessaging(new LocalDBTransport(child, () => parent), child);
    await producer.send(producer.createMessage({ type: "task_result", to: createTestIdentity().address, taskId, attemptId: token, content: JSON.stringify({ taskId, result: { ...RESULT, costCents: 7 } }) }));
    const messaging = new ColonyMessaging(new LocalDBTransport(parent), parent);
    // Fail the dequeue, after the completion statements have executed.
    parent.raw.exec("CREATE TRIGGER reject_dequeue BEFORE DELETE ON kv WHEN OLD.key LIKE 'colony.result.%' BEGIN SELECT RAISE(ABORT,'dequeue failed'); END");
    const orc = orchestrator(parent, messaging, () => false);
    expect((await orc.tick()).phase).toBe("executing");
    expect(getTaskById(parent.raw, taskId)).toMatchObject({ status: "assigned", actualCostCents: 0 });
    expect(messaging.getPendingTaskResults()).toHaveLength(0); // retry is deferred, payload remains durable
    expect(parent.raw.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'colony.result.%'").get()).toEqual({ n: 1 });
    parent.raw.exec("DROP TRIGGER reject_dequeue");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    expect((await orc.tick()).tasksCompleted).toBe(1);
    expect(getTaskById(parent.raw, taskId)?.actualCostCents).toBe(7);
    expect(messaging.getPendingTaskResults()).toHaveLength(0);
  });

  it("replays a result accepted before expiry even after its transport TTL has elapsed", async () => {
    const parent = open("expiry.db", createTestIdentity().address);
    const child = open("child.db", "0xchild");
    const taskId = ready(parent); const token = assignTask(parent.raw, taskId, "0xchild");
    const producer = new ColonyMessaging(new LocalDBTransport(child, () => parent), child);
    const now = Date.now();
    await producer.send(producer.createMessage({ type: "task_result", to: createTestIdentity().address, taskId, attemptId: token, expiresAt: new Date(now + 60_000).toISOString(), content: JSON.stringify({ taskId, result: RESULT }) }));
    const messaging = new ColonyMessaging(new LocalDBTransport(parent), parent);
    await messaging.processInbox();
    vi.spyOn(Date, "now").mockReturnValue(now + 120_000);
    expect((await orchestrator(parent, messaging).tick()).tasksCompleted).toBe(1);
    expect(messaging.getPendingTaskResults()).toHaveLength(0);
  });

  it("allows only one of two SQLite consumers to apply and account for the same durable result", async () => {
    const parent = open("two-consumers.db", createTestIdentity().address);
    const child = open("child.db", "0xchild");
    const taskId = ready(parent); const token = assignTask(parent.raw, taskId, "0xchild");
    const producer = new ColonyMessaging(new LocalDBTransport(child, () => parent), child);
    await producer.send(producer.createMessage({ type: "task_result", to: createTestIdentity().address, taskId, attemptId: token, content: JSON.stringify({ taskId, result: { ...RESULT, costCents: 7 } }) }));
    const one = new ColonyMessaging(new LocalDBTransport(parent), parent);
    await one.processInbox();
    const second = open("two-consumers.db", createTestIdentity().address);
    const two = new ColonyMessaging(new LocalDBTransport(second), second);
    const a = one.getPendingTaskResults()[0]; const b = two.getPendingTaskResults()[0];
    const attempt = { taskId, workerAddress: "0xchild", attemptId: token };
    one.consumeTaskResult(a.queueKey!, parent.raw, () => completeTask(parent.raw, taskId, { ...RESULT, costCents: 7 }, attempt));
    const applyAgain = vi.fn(() => completeTask(second.raw, taskId, { ...RESULT, costCents: 7 }, attempt));
    expect(two.consumeTaskResult(b.queueKey!, second.raw, applyAgain)).toBeNull();
    expect(applyAgain).not.toHaveBeenCalled();
    expect(getTaskById(second.raw, taskId)?.actualCostCents).toBe(7);
  });

  it("does not acknowledge a result when its durable staging fails", async () => {
    const parent = open("staging.db", createTestIdentity().address);
    const child = open("child.db", "0xchild");
    const taskId = ready(parent); const token = assignTask(parent.raw, taskId, "0xchild");
    const producer = new ColonyMessaging(new LocalDBTransport(child, () => parent), child);
    await producer.send(producer.createMessage({ type: "task_result", to: createTestIdentity().address, taskId, attemptId: token, content: JSON.stringify({ taskId, result: RESULT }) }));
    const messaging = new ColonyMessaging(new LocalDBTransport(parent), parent);
    parent.raw.exec("CREATE TRIGGER reject_staging BEFORE INSERT ON kv WHEN NEW.key LIKE 'colony.result.%' BEGIN SELECT RAISE(ABORT,'staging failed'); END");
    expect((await messaging.processInbox())[0].success).toBe(false);
    expect(parent.getUnprocessedInboxMessages(10)).toHaveLength(1);
    expect(messaging.getPendingTaskResults()).toHaveLength(0);
  });

  it.each([false, true])("retains nonzero remote failure costs, executorThrows=%s", async (throws) => {
    const parent = open("failure-cost.db", createTestIdentity().address);
    const child = open("child.db", "0xchild");
    const taskId = ready(parent); const token = assignTask(parent.raw, taskId, "0xchild");
    const messaging = new ColonyMessaging(new LocalDBTransport(parent), parent);
    const worker = new ColonyMessaging(new LocalDBTransport(child, () => parent), child);
    const assignment = messaging.createMessage({ type: "task_assignment", to: "0xchild", taskId, attemptId: token, content: JSON.stringify({ taskId, attemptId: token }) });
    await worker.executeTaskAssignment(assignment, async () => {
      if (throws) throw Object.assign(new Error("costly failure"), { costCents: 9 });
      return { ...RESULT, success: false, output: "costly failure", costCents: 9 };
    });
    await orchestrator(parent, messaging).tick();
    expect(getTaskById(parent.raw, taskId)).toMatchObject({ status: "pending", actualCostCents: 9, result: { costCents: 9, attemptId: token, success: false } });
  });

  it("blocks complete_task without an original token, across same-address reassignment and legacy replanning", async () => {
    const parent = open("authority.db", createTestIdentity().address);
    const taskId = ready(parent); const address = createTestIdentity().address;
    parent.raw.prepare("UPDATE task_graph SET status='assigned',assigned_to=?,attempt_id=NULL WHERE id=?").run(address, taskId);
    const tool = createBuiltinTools("sandbox").find((entry) => entry.name === "complete_task")!;
    const ctx = { db: parent, identity: createTestIdentity() } as unknown as ToolContext;
    expect(await tool.execute({ task_id: taskId, output: "legacy" }, ctx)).toMatch(/Blocked/);
    const failed = insertTask(parent.raw, { goalId: getTaskById(parent.raw, taskId)!.goalId, title: "Failed", description: "Failed", status: "failed" });
    const before = parent.raw.prepare("SELECT * FROM task_graph").all();
    parent.setKV("orchestrator.state", JSON.stringify({ phase: "replanning", goalId: getTaskById(parent.raw, taskId)!.goalId, failedTaskId: failed, replanCount: 0 }));
    const messaging = new ColonyMessaging(new LocalDBTransport(parent), parent);
    expect((await orchestrator(parent, messaging).tick()).phase).toBe("replanning");
    expect(parent.raw.prepare("SELECT * FROM task_graph").all()).toEqual(before);
    // Model a trusted operator's reset after neutralization, then a retry.
    parent.raw.prepare("UPDATE task_graph SET status='pending',assigned_to=NULL WHERE id=?").run(taskId);
    const old = assignTask(parent.raw, taskId, address);
    failTask(parent.raw, taskId, "retry", true);
    const current = assignTask(parent.raw, taskId, address);
    expect(await tool.execute({ task_id: taskId, attempt_id: old, output: "old" }, ctx)).toMatch(/Blocked/);
    expect(await tool.execute({ task_id: taskId, output: "missing" }, ctx)).toMatch(/Blocked/);
    expect(getTaskById(parent.raw, taskId)).toMatchObject({ status: "assigned", attemptId: current });
    expect(await tool.execute({ task_id: taskId, attempt_id: current, output: "current" }, ctx)).toMatch(/marked as completed/);
  });

  it.each([["same", true], ["other", true], ["same", false], ["other", false]] as const)("keeps the original remote token across awaits after reassignment to %s address, success=%s", async (address, success) => {
    const parent = open("parent.db", createTestIdentity().address);
    const child = open("child.db", "0xchild");
    const taskId = ready(parent);
    const token = assignTask(parent.raw, taskId, "0xchild");
    const sender = new ColonyMessaging(new LocalDBTransport(parent), parent);
    const assignment = sender.createMessage({ type: "task_assignment", to: "0xchild", taskId, attemptId: token, content: JSON.stringify({ taskId, attemptId: token }) });
    const worker = new ColonyMessaging(new LocalDBTransport(child, () => parent), child);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = worker.executeTaskAssignment(assignment, async () => { await gate; if (!success) throw new Error("old failure"); return RESULT; });
    failTask(parent.raw, taskId, "retry", true);
    const replacement = assignTask(parent.raw, taskId, address === "same" ? "0xchild" : "0xother");
    release(); await pending;
    await orchestrator(parent, sender).tick();
    expect(getTaskById(parent.raw, taskId)).toMatchObject({ status: "assigned", attemptId: replacement, result: { success: false } });
  });

  it("reports an executor exception with its received token and schedules retry for the next tick", async () => {
    const parent = open("parent.db", createTestIdentity().address);
    const child = open("child.db", "0xchild");
    const taskId = ready(parent); const token = assignTask(parent.raw, taskId, "0xchild");
    const messaging = new ColonyMessaging(new LocalDBTransport(parent), parent);
    const worker = new ColonyMessaging(new LocalDBTransport(child, () => parent), child);
    const assignment = messaging.createMessage({ type: "task_assignment", to: "0xchild", taskId, attemptId: token, content: JSON.stringify({ taskId, attemptId: token }) });
    await worker.executeTaskAssignment(assignment, async () => { throw new Error("executor failed"); });
    const tick = await orchestrator(parent, messaging).tick();
    expect(tick.tasksAssigned).toBe(0);
    expect(getTaskById(parent.raw, taskId)).toMatchObject({ status: "pending", attemptId: null, retryCount: 1, result: { success: false, output: "executor failed", attemptId: token } });
  });

  it("rejects legacy execution and ambiguous generic relay messages before side effects", async () => {
    const child = open("child.db", "0xchild");
    const messaging = new ColonyMessaging(new LocalDBTransport(child), child);
    const legacy = messaging.createMessage({ type: "task_assignment", to: "0xchild", taskId: "task", content: "{}" });
    const execute = vi.fn();
    await expect(messaging.executeTaskAssignment(legacy, execute)).rejects.toThrow(/Legacy/);
    expect(execute).not.toHaveBeenCalled();
    expect(() => validateOutgoingTaskContent(JSON.stringify({ ...legacy, type: "task_result" }))).toThrow(/attemptId/);
    expect(() => validateOutgoingTaskContent(JSON.stringify({ ...legacy, attemptId: "one", content: JSON.stringify({ attemptId: "two" }) }))).toThrow(/conflicting/);
    const send = vi.fn().mockResolvedValue({ id: "relay" });
    const tool = createBuiltinTools("sandbox").find((entry) => entry.name === "send_message")!;
    const context = { social: { send } } as unknown as ToolContext;
    await expect(tool.execute({ to_address: "parent", content: JSON.stringify({ ...legacy, type: "task_result" }) }, context)).rejects.toThrow(/attemptId/);
    expect(send).not.toHaveBeenCalled();
    const bound = { ...legacy, type: "task_result", attemptId: "attempt" };
    await tool.execute({ to_address: "parent", content: JSON.stringify(bound) }, context);
    expect(send).toHaveBeenCalledWith("parent", JSON.stringify(bound), undefined);
  });

  it.each(["0xchild", createTestIdentity().address])("preserves a populated V11 active assignment to %s and rejects its legacy result without recovering it", async (address) => {
    const file = path.join(dir, "legacy.db");
    const legacy = new Database(file);
    legacy.exec(CREATE_TABLES); legacy.exec(MIGRATION_V9); legacy.exec(MIGRATION_V10); legacy.exec(MIGRATION_V11);
    legacy.prepare("INSERT INTO schema_version(version) VALUES (11)").run();
    legacy.prepare("INSERT INTO goals(id,title,description,status,created_at) VALUES ('g','Goal','Goal','active',datetime('now'))").run();
    legacy.prepare("INSERT INTO task_graph(id,goal_id,title,description,status,assigned_to,dependencies,created_at) VALUES ('t','g','Task','Important data','running',?,'[]',datetime('now'))").run(address);
    legacy.close();
    const migrated = open("legacy.db", createTestIdentity().address);
    migrated.setKV("orchestrator.state", JSON.stringify({ phase: "executing", goalId: "g", replanCount: 0 }));
    const messaging = new ColonyMessaging(new LocalDBTransport(migrated), migrated);
    vi.spyOn(messaging, "processInbox").mockResolvedValue([{ success: true, handledBy: "legacy", message: { ...messaging.createMessage({ type: "task_result", to: createTestIdentity().address, taskId: "t", content: JSON.stringify({ taskId: "t", result: RESULT }) }), from: address } }]);
    const tick = await orchestrator(migrated, messaging, () => false).tick();
    expect(tick.tasksAssigned).toBe(0); expect(tick.tasksCompleted).toBe(0);
    expect(getTaskById(migrated.raw, "t")).toMatchObject({ status: "running", assignedTo: address, description: "Important data", attemptId: null, result: null });
    expect(migrated.raw.prepare("SELECT MAX(version) AS v FROM schema_version").get()).toEqual({ v: 12 });
  });

  it("preserves the typed envelope through the social relay", async () => {
    const send = vi.fn().mockResolvedValue({ id: "relay" });
    const transport = new SocialRelayTransport({ send } as unknown as SocialClientInterface, () => ["child"]);
    const envelope = JSON.stringify({ protocol: "colony_message_v1", message: { attemptId: "attempt" } });
    await transport.deliver("child", envelope);
    expect(send).toHaveBeenCalledWith("child", envelope);
  });

  it("preserves bound messages through both parent/child relay producers and rejects legacy payloads", async () => {
    const child = open("relay.db", "0xchild");
    const messaging = new ColonyMessaging(new LocalDBTransport(child), child);
    const send = vi.fn().mockResolvedValue({ id: "relay" });
    const social = { send } as unknown as SocialClientInterface;
    const assignment = messaging.createMessage({ type: "task_assignment", to: "child", taskId: "task", attemptId: "attempt", content: JSON.stringify({ taskId: "task", attemptId: "attempt" }) });
    await sendToChild(social, "child", JSON.stringify(assignment), "task_assignment");
    const result = messaging.createTaskResultMessage(assignment, RESULT);
    await sendToParent(social, assignment.from, JSON.stringify(result), "task_result");
    expect(send.mock.calls.map((call) => JSON.parse(call[1]).attemptId)).toEqual(["attempt", "attempt"]);
    await expect(sendToParent(social, "parent", JSON.stringify({ type: "task_result", content: "done" }), "task_result")).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("documents with a deterministic interleaving that an already-started external write can finish after revocation", async () => {
    const db = open("external.db", createTestIdentity().address);
    const taskId = ready(db); const token = assignTask(db.raw, taskId, "worker");
    const scope = new TaskAttemptScope(db.raw, { taskId, workerAddress: "worker", attemptId: token });
    let release!: () => void; let externalWrites = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const external = scope.guardOperations({ write: async () => { await gate; externalWrites++; } });
    const pending = external.write();
    failTask(db.raw, taskId, "retry", true); assignTask(db.raw, taskId, "new");
    release(); await pending;
    expect(externalWrites).toBe(1);
    expect(() => external.write()).toThrow(/no longer owns/);
  });
});
