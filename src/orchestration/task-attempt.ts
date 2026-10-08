import { AsyncLocalStorage } from "node:async_hooks";
import type { Database, Statement } from "better-sqlite3";
import type { AutomatonDatabase } from "../types.js";

export interface TaskAttempt {
  taskId: string;
  workerAddress: string;
  attemptId: string;
}

export class StaleTaskAttemptError extends Error {
  constructor() {
    super("Task attempt no longer owns its assignment");
    this.name = "StaleTaskAttemptError";
  }
}

export function assertTaskAttempt(db: Database, attempt: TaskAttempt): void {
  const row = db.prepare(
    "SELECT status, assigned_to, attempt_id FROM task_graph WHERE id = ?",
  ).get(attempt.taskId) as { status: string; assigned_to: string | null; attempt_id: string | null } | undefined;
  if (!row || !attempt.attemptId || row.attempt_id !== attempt.attemptId ||
      row.assigned_to !== attempt.workerAddress || !["assigned", "running"].includes(row.status)) {
    throw new StaleTaskAttemptError();
  }
}

const activeAttempt = new AsyncLocalStorage<TaskAttemptScope>();

/** All task-graph transactions, including calls with a captured raw connection,
 * inherit the executing worker's attempt. Acquire the write lock before checking
 * ownership so another SQLite connection cannot reassign between check and write.
 */
export function withAttemptTransaction<T>(db: Database, fn: () => T): T {
  const scope = activeAttempt.getStore();
  return scope ? scope.write(db, fn) : db.transaction(fn)();
}

/** Revocable capabilities for trusted in-process harnesses; not a JS sandbox. */
export class TaskAttemptScope {
  readonly db: Database;
  private depth = 0;

  constructor(private readonly raw: Database, readonly attempt: TaskAttempt) {
    this.db = new Proxy(raw, {
      get: (target, key) => {
        if (key === "prepare") return (sql: string) => {
          // Do not expose SQL transaction control or connection/schema mutation.
          if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
            throw new Error("Worker database only supports data statements");
          }
          return this.statement(target.prepare(sql));
        };
        if (key === "transaction") return (fn: (...args: unknown[]) => unknown) => {
          const run = (...args: unknown[]) => this.write(this.db, () => fn(...args));
          return Object.assign(run, {
            deferred: (...args: unknown[]) => this.write(this.db, () => fn(...args), "deferred"),
            immediate: run,
            exclusive: (...args: unknown[]) => this.write(this.db, () => fn(...args), "exclusive"),
          });
        };
        const value = Reflect.get(target, key, target);
        if (typeof value === "function") {
          throw new Error(`Worker database capability unavailable: ${String(key)}`);
        }
        return value;
      },
    });
  }

  assertActive = (): void => { assertTaskAttempt(this.raw, this.attempt); };

  run<T>(fn: () => T): T {
    return activeAttempt.run(this, fn);
  }

  write<T>(db: Database, fn: () => T, mode: "deferred" | "immediate" | "exclusive" = "immediate"): T {
    if (db !== this.raw && db !== this.db) throw new Error("Worker cannot write through another database connection");
    // Nested calls still need a savepoint: their caller may catch an error and
    // continue the outer transaction. Ownership was checked under its write lock.
    if (this.depth > 0) return this.raw.transaction(() => this.synchronous(fn)).immediate();
    return this.raw.transaction(() => {
      this.assertActive();
      this.depth++;
      try {
        return this.synchronous(fn);
      } finally {
        this.depth--;
      }
    })[mode]();
  }

  private synchronous<T>(fn: () => T): T {
    const result = fn();
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new Error("Worker database transactions must be synchronous");
    }
    return result;
  }

  private statement(statement: Statement): Statement {
    const proxy: Statement = new Proxy(statement, {
      get: (target, key) => {
        if (key === "database") return this.db;
        if (key === "iterate") return (...args: unknown[]) =>
          this.write(this.db, () => target.all(...args))[Symbol.iterator]();
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => this.write(this.db, () => {
          const result = value.apply(target, args);
          return result === target ? proxy : result;
        });
      },
    });
    return proxy;
  }

  guardAutomatonDatabase(db: AutomatonDatabase): AutomatonDatabase {
    if (db.raw !== this.raw && db.raw !== this.db) throw new Error("Worker database helper uses another connection");
    return new Proxy(db, {
      get: (target, key) => {
        if (key === "raw") return this.db;
        if (key === "close") return () => { throw new Error("Worker cannot close the shared database"); };
        const value = Reflect.get(target, key, target);
        return typeof value === "function"
          ? (...args: unknown[]) => this.write(this.raw, () => value.apply(target, args))
          : value;
      },
    });
  }

  guardSynchronousOperations<T extends object>(object: T): T {
    return new Proxy(object, {
      get: (target, key) => {
        const value = Reflect.get(target, key, target);
        return typeof value === "function"
          ? (...args: unknown[]) => this.write(this.raw, () => value.apply(target, args))
          : value;
      },
    });
  }

  /** Check before starting an external operation. An operation already in flight
   * cannot be revoked by a JS proxy; file/command isolation is still required.
   */
  guardOperations<T extends object>(object: T): T {
    return new Proxy(object, {
      get: (target, key) => {
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? (...args: unknown[]) => {
          this.assertActive();
          const result = value.apply(target, args);
          return key === "createScopedClient" && result && typeof result === "object"
            ? this.guardOperations(result) : result;
        } : value;
      },
    });
  }
}
