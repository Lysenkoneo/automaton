/**
 * Colony Messaging
 *
 * Typed inter-agent messaging with pluggable transport.
 * Uses local SQLite message queues by default (no external relay required).
 * Transport can be swapped to social relay when backend becomes available.
 */

import type { AutomatonDatabase, InboxMessage, SocialClientInterface } from "../types.js";
import { insertEvent } from "../state/database.js";
import { createLogger } from "../observability/logger.js";
import { ulid } from "ulid";
import type BetterSqlite3 from "better-sqlite3";
import { taskFailureResult, type TaskResult } from "./task-graph.js";
import { RESULT_QUEUE_PREFIX, stageTaskResultBeforeAck } from "./result-inbox.js";

const logger = createLogger("orchestration.messaging");

const MAX_INBOX_BATCH = 200;
const SEND_RETRIES = 3;
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000] as const;

const MESSAGE_TYPES = [
  "task_assignment",
  "task_result",
  "status_report",
  "resource_request",
  "knowledge_share",
  "customer_request",
  "alert",
  "shutdown_request",
  "peer_query",
  "peer_response",
] as const;

const PRIORITY_ORDER = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
} as const;

// ─── Types ──────────────────────────────────────────────────────

export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface AgentMessage {
  id: string;
  type: MessageType;
  from: string;
  to: string;
  goalId: string | null;
  taskId: string | null;
  /** Optional for non-task/legacy messages; required for new task assignments. */
  attemptId?: string;
  content: string;
  priority: "low" | "normal" | "high" | "critical";
  requiresResponse: boolean;
  expiresAt: string | null;
  createdAt: string;
}

export interface ProcessedMessage {
  queueKey?: string;
  message: AgentMessage;
  handledBy: string;
  success: boolean;
  error?: string;
}

interface MessageEnvelope {
  protocol: "colony_message_v1";
  sentAt: string;
  message: AgentMessage;
}

interface PendingInboxMessage {
  inboxId: string;
  message: AgentMessage;
}

// ─── Transport Interface ────────────────────────────────────────

/**
 * Pluggable message transport. Implementations handle the actual
 * delivery mechanism. The default LocalDBTransport writes directly
 * to SQLite inbox tables.
 */
export interface MessageTransport {
  /** Deliver a message to the recipient. */
  deliver(to: string, envelope: string): Promise<void>;
  /** List known recipient addresses (for broadcast). */
  getRecipients(): string[];
}

/**
 * Local SQLite-based transport.
 * Writes messages directly to the inbox_messages table in the local DB.
 * Works for parent↔child communication on the same machine.
 * No external relay server required.
 */
export class LocalDBTransport implements MessageTransport {
  constructor(
    private readonly db: AutomatonDatabase,
    private readonly recipientDatabase?: (address: string) => AutomatonDatabase,
  ) {}

  async deliver(to: string, envelope: string): Promise<void> {
    // Write directly to inbox_messages table
    const id = ulid();
    const fromAddress = this.db.getIdentity("address") ?? "unknown";
    const recipient = this.recipientDatabase?.(to) ?? this.db;
    recipient.raw.prepare(
      `INSERT INTO inbox_messages (id, from_address, to_address, content, received_at, status)
       VALUES (?, ?, ?, ?, datetime('now'), 'received')`,
    ).run(id, fromAddress, to, envelope);
  }

  getRecipients(): string[] {
    const children = this.db.getChildren();
    return children.map((c) => c.address);
  }
}

/** The relay preserves the complete typed envelope, including attemptId. */
export class SocialRelayTransport implements MessageTransport {
  constructor(private readonly social: SocialClientInterface, private readonly recipients: () => string[]) {}
  async deliver(to: string, envelope: string): Promise<void> { await this.social.send(to, envelope); }
  getRecipients(): string[] { return this.recipients(); }
}

// ─── Colony Messaging ───────────────────────────────────────────

export class ColonyMessaging {
  constructor(
    private readonly transport: MessageTransport,
    private readonly db: AutomatonDatabase,
  ) {}

  async send(message: AgentMessage): Promise<void> {
    validateMessage(message);
    if ((message.type === "task_assignment" || message.type === "task_result") && !taskMessageAttemptId(message)) {
      throw new Error("Cannot send legacy task message without attemptId");
    }

    const envelope: MessageEnvelope = {
      protocol: "colony_message_v1",
      sentAt: new Date().toISOString(),
      message,
    };

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= SEND_RETRIES; attempt += 1) {
      try {
        await this.transport.deliver(message.to, JSON.stringify(envelope));
        this.logActionEvent("message_sent", message);
        return;
      } catch (error) {
        lastError = normalizeError(error);
        const isFinalAttempt = attempt === SEND_RETRIES;
        logger.warn("Message send attempt failed", {
          messageId: message.id,
          to: message.to,
          attempt: attempt + 1,
          isFinalAttempt,
          error: lastError.message,
        });

        if (isFinalAttempt) break;
        await sleep(RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
      }
    }

    throw new Error(
      `Failed to send message ${message.id} after ${SEND_RETRIES + 1} attempts: ${lastError?.message ?? "unknown error"}`,
    );
  }

  async processInbox(): Promise<ProcessedMessage[]> {
    // Give task results their own batch: ordinary traffic cannot starve them.
    const readBatch = (results: boolean): InboxMessage[] => this.db.raw.prepare(`
      SELECT inbox_messages.* FROM inbox_messages LEFT JOIN kv retry
      ON retry.key = 'colony.inbox-retry.' || inbox_messages.id
      WHERE processed_at IS NULL AND COALESCE(json_extract(retry.value, '$.quarantined'), 0) = 0
      AND COALESCE(json_extract(retry.value, '$.nextRetryAt'), 0) <= ?
      AND (COALESCE(CASE WHEN json_valid(content) THEN
        COALESCE(json_extract(content, '$.message.type'), json_extract(content, '$.type')) END, '') = 'task_result') = ?
      ORDER BY received_at, id LIMIT ?`).all(Date.now(), results ? 1 : 0, MAX_INBOX_BATCH)
      .map((row: any): InboxMessage => ({
        id: row.id, from: row.from_address, to: row.to_address ?? "", content: row.content,
        signedAt: row.received_at, createdAt: row.received_at, replyTo: row.reply_to ?? undefined,
      }));
    const inbox = [...readBatch(true), ...readBatch(false)];
    const pending: PendingInboxMessage[] = [];
    const processed: ProcessedMessage[] = [];

    for (const row of inbox) {
      const retry = this.retryState(`colony.inbox-retry.${row.id}`);
      if (retry.quarantined || retry.nextRetryAt > Date.now()) continue;
      try {
        const message = parseInboundMessage(row);
        pending.push({ inboxId: row.id, message });
      } catch (error) {
        const err = normalizeError(error);
        const rejected = createRejectedMessage(row);
        // Invalid messages are durably quarantined, never reported as handled.
        this.db.raw.transaction(() => {
          this.db.raw.prepare("INSERT OR REPLACE INTO kv (key,value,updated_at) VALUES (?,?,datetime('now'))")
            .run(`colony.inbox-quarantine.${row.id}`, JSON.stringify({ message: row, error: err.message }));
          this.db.raw.prepare("UPDATE inbox_messages SET processed_at=datetime('now') WHERE id=?").run(row.id);
        }).immediate();
        processed.push({
          message: rejected,
          handledBy: "rejectMalformedMessage",
          success: false,
          error: err.message,
        });
        logger.warn("Rejected malformed inbound message", {
          inboxId: row.id,
          from: row.from,
          error: err.message,
        });
      }
    }

    // Process critical priority first
    pending.sort((a, b) => {
      const priorityDelta = PRIORITY_ORDER[a.message.priority] - PRIORITY_ORDER[b.message.priority];
      if (priorityDelta !== 0) return priorityDelta;
      return a.message.createdAt.localeCompare(b.message.createdAt);
    });

    for (const item of pending) {
      let handledBy = "unknown";
      try {
        handledBy = await this.routeMessage(item.message);
        const queueKey = item.message.type === "task_result"
          ? this.db.raw.transaction(() => {
              const key = stageTaskResultBeforeAck(this.db.raw, item.inboxId, item.message);
              this.db.markInboxMessageProcessed(item.inboxId);
              return key;
            }).immediate()
          : null;
        if (item.message.type !== "task_result") this.db.markInboxMessageProcessed(item.inboxId);
        this.releaseInboxMessage(item.inboxId);
        processed.push({
          ...(queueKey ? { queueKey } : {}),
          message: item.message,
          handledBy,
          success: true,
        });
      } catch (error) {
        const err = normalizeError(error);
        this.retryInboxMessage(item.inboxId, error);
        processed.push({
          message: item.message,
          handledBy,
          success: false,
          error: err.message,
        });
        logger.error("Failed to handle inbox message", err, {
          messageId: item.message.id,
          type: item.message.type,
          from: item.message.from,
          to: item.message.to,
        });
      }
    }

    return processed;
  }

  getPendingTaskResults(): ProcessedMessage[] {
    const rows = this.db.raw.prepare("SELECT key,value FROM kv WHERE key LIKE ? ORDER BY key")
      .all(RESULT_QUEUE_PREFIX + "%") as { key: string; value: string }[];
    return rows.flatMap((row) => {
      const state = this.resultRetryState(row.key);
      if (state.quarantined || state.nextRetryAt > Date.now()) return [];
      try {
        const message = JSON.parse(row.value) as AgentMessage;
        validateMessage(message);
        return [{ queueKey: row.key, message, success: true, handledBy: "durableTaskResult" }];
      } catch (error) {
        this.retryTaskResult(row.key, error);
        return [];
      }
    });
  }

  private retryState(key: string): { attempts: number; nextRetryAt: number; quarantined: boolean } {
    const row = this.db.raw.prepare("SELECT value FROM kv WHERE key=?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : { attempts: 0, nextRetryAt: 0, quarantined: false };
  }

  private resultRetryState(queueKey: string) { return this.retryState(`colony.result-retry.${queueKey}`); }

  private retryInboxMessage(inboxId: string, error: unknown): void {
    this.db.raw.transaction(() => {
      const key = `colony.inbox-retry.${inboxId}`;
      const attempts = this.retryState(key).attempts + 1;
      this.db.raw.prepare("INSERT OR REPLACE INTO kv (key,value,updated_at) VALUES (?,?,datetime('now'))")
        .run(key, JSON.stringify({ attempts, nextRetryAt: Date.now() + 1000 * 2 ** Math.min(attempts - 1, 10), quarantined: attempts >= 3, error: normalizeError(error).message }));
      // Keep the source unacknowledged, including assignments without a receipt.
    }).immediate();
  }

  releaseInboxMessage(inboxId: string): void {
    this.db.raw.prepare("DELETE FROM kv WHERE key=?").run(`colony.inbox-retry.${inboxId}`);
  }

  /** Keep the original payload; after three failures an operator must inspect and release it. */
  retryTaskResult(queueKey: string, error: unknown): void {
    this.db.raw.transaction(() => {
      if (!this.db.raw.prepare("SELECT 1 FROM kv WHERE key=?").get(queueKey)) return;
      const attempts = this.resultRetryState(queueKey).attempts + 1;
      this.db.raw.prepare("INSERT OR REPLACE INTO kv (key,value,updated_at) VALUES (?,?,datetime('now'))")
        .run(`colony.result-retry.${queueKey}`, JSON.stringify({ attempts, nextRetryAt: Date.now() + 1000 * 2 ** Math.min(attempts - 1, 10), quarantined: attempts >= 3, error: normalizeError(error).message }));
    }).immediate();
  }

  releaseTaskResult(queueKey: string): void {
    this.db.raw.prepare("DELETE FROM kv WHERE key=?").run(`colony.result-retry.${queueKey}`);
  }

  /** Include deferred/quarantined results, but block only their original task attempt. */
  hasPendingTaskResult(taskId: string, attemptId: string): boolean {
    const rows = this.db.raw.prepare(`SELECT content AS value FROM inbox_messages WHERE processed_at IS NULL AND
      CASE WHEN json_valid(content) THEN COALESCE(json_extract(content, '$.message.type'), json_extract(content, '$.type')) END = 'task_result'
      UNION ALL SELECT value FROM kv WHERE key LIKE ?`).all(RESULT_QUEUE_PREFIX + "%") as { value: string }[];
    return rows.some(row => {
      try {
        const message = extractAgentMessage(JSON.parse(row.value)) as AgentMessage;
        let payload: any = {};
        try { payload = JSON.parse(message.content); } catch { /* legacy content */ }
        return message.type === "task_result" && (message.taskId ?? payload?.taskId) === taskId && taskMessageAttemptId(message) === attemptId;
      } catch { return false; }
    });
  }

  /** Retained for callers that need general inbox presence, not task recovery. */
  hasUnprocessedInbox(): boolean {
    return !!this.db.raw.prepare("SELECT 1 FROM inbox_messages WHERE processed_at IS NULL LIMIT 1").get();
  }

  /** Completion/discard and dequeue use one connection and one SQLite transaction. */
  consumeTaskResult<T>(queueKey: string, db: BetterSqlite3.Database, apply: () => T): T | null {
    if (db !== this.db.raw) throw new Error("Result application must use the messaging database connection");
    if (!queueKey.startsWith(RESULT_QUEUE_PREFIX)) throw new Error("Invalid result queue key");
    return db.transaction(() => {
      if (!db.prepare("SELECT 1 FROM kv WHERE key=?").get(queueKey)) return null;
      const result = apply();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Result application must be synchronous");
      db.prepare("DELETE FROM kv WHERE key=?").run(queueKey);
      db.prepare("DELETE FROM kv WHERE key=?").run(`colony.result-retry.${queueKey}`);
      return result;
    }).immediate();
  }

  async broadcast(content: string, priority: "high" | "critical"): Promise<void> {
    const recipients = this.transport.getRecipients();
    if (recipients.length === 0) return;

    const fromAddress = this.db.getIdentity("address") ?? "unknown";
    const createdAt = new Date().toISOString();

    await Promise.all(recipients.map((to) =>
      this.send({
        id: ulid(),
        type: "alert",
        from: fromAddress,
        to,
        goalId: null,
        taskId: null,
        content,
        priority,
        requiresResponse: false,
        expiresAt: null,
        createdAt,
      }),
    ));
  }

  /** Bind the reply to the received assignment, never to the latest task/address. */
  createTaskResultMessage(assignment: AgentMessage, result: TaskResult): AgentMessage {
    validateMessage(assignment);
    if (assignment.type !== "task_assignment") throw new Error("Expected task assignment");
    const attemptId = taskMessageAttemptId(assignment);
    if (!attemptId || !assignment.taskId) throw new Error("Legacy assignment has no attemptId; execution requires operator intervention");
    if (result.attemptId && result.attemptId !== attemptId) throw new Error("Result attemptId conflicts with assignment");
    return this.createMessage({
      type: "task_result", to: assignment.from, goalId: assignment.goalId ?? undefined,
      taskId: assignment.taskId, attemptId,
      content: JSON.stringify({ taskId: assignment.taskId, attemptId, result: { ...result, attemptId } }),
    });
  }

  getReceivedTaskAssignment(attemptId: string): Readonly<AgentMessage> | null {
    const row = this.db.raw.prepare("SELECT value FROM kv WHERE key=?").get(`colony.assignment.${attemptId}`) as { value: string } | undefined;
    if (!row) return null;
    const assignment = JSON.parse(row.value) as AgentMessage;
    validateMessage(assignment);
    if (assignment.type !== "task_assignment" || taskMessageAttemptId(assignment) !== attemptId) throw new Error("Invalid persisted task receipt");
    return Object.freeze(assignment);
  }

  /** Remote executors must retain this assignment across awaits and restarts. */
  async executeTaskAssignment(assignment: AgentMessage, execute: (assignment: Readonly<AgentMessage>) => Promise<TaskResult>): Promise<void> {
    // Validate before invoking any executor, including when this API is called directly.
    this.createTaskResultMessage(assignment, { success: true, output: "", artifacts: [], costCents: 0, duration: 0 });
    const received = Object.freeze({ ...assignment });
    const startedAt = Date.now();
    let result: TaskResult;
    try {
      result = await execute(received);
    } catch (error) {
      result = { ...taskFailureResult(error), duration: Date.now() - startedAt };
    }
    await this.send(this.createTaskResultMessage(received, result));
  }

  /** Create a pre-filled message for sending. */
  createMessage(params: {
    type: MessageType;
    to: string;
    content: string;
    goalId?: string;
    taskId?: string;
    attemptId?: string;
    priority?: AgentMessage["priority"];
    requiresResponse?: boolean;
    expiresAt?: string;
  }): AgentMessage {
    const fromAddress = this.db.getIdentity("address") ?? "unknown";
    return {
      id: ulid(),
      type: params.type,
      from: fromAddress,
      to: params.to,
      goalId: params.goalId ?? null,
      taskId: params.taskId ?? null,
      ...(params.attemptId ? { attemptId: params.attemptId } : {}),
      content: params.content,
      priority: params.priority ?? "normal",
      requiresResponse: params.requiresResponse ?? false,
      expiresAt: params.expiresAt ?? null,
      createdAt: new Date().toISOString(),
    };
  }

  private async routeMessage(message: AgentMessage): Promise<string> {
    switch (message.type) {
      case "task_assignment":
        await this.handleTaskAssignment(message);
        return "handleTaskAssignment";
      case "task_result":
        await this.handleTaskResult(message);
        return "handleTaskResult";
      case "status_report":
        await this.handleStatusReport(message);
        return "handleStatusReport";
      case "resource_request":
        await this.handleResourceRequest(message);
        return "handleResourceRequest";
      case "knowledge_share":
        await this.handleKnowledgeShare(message);
        return "handleKnowledgeShare";
      case "customer_request":
        await this.handleCustomerRequest(message);
        return "handleCustomerRequest";
      case "alert":
        await this.handleAlert(message);
        return "handleAlert";
      case "shutdown_request":
        await this.handleShutdownRequest(message);
        return "handleShutdownRequest";
      case "peer_query":
        await this.handlePeerQuery(message);
        return "handlePeerQuery";
      case "peer_response":
        await this.handlePeerResponse(message);
        return "handlePeerResponse";
      default:
        throw new Error(`unsupported message type: ${message.type satisfies never}`);
    }
  }

  // ─── Message Handlers (stubs — orchestrator wires real logic) ──

  private async handleTaskAssignment(message: AgentMessage): Promise<void> {
    const attemptId = taskMessageAttemptId(message);
    if (!attemptId) throw new Error("Legacy task assignment rejected: attemptId required");
    // Retain the original receipt, keyed by attempt rather than worker/task, for
    // an executor that resumes after restart. Never replace it with a newer task.
    const receiptKey = `colony.assignment.${attemptId}`;
    this.db.raw.transaction(() => {
      const existing = this.db.raw.prepare("SELECT value FROM kv WHERE key=?").get(receiptKey) as { value: string } | undefined;
      if (existing && existing.value !== JSON.stringify(message)) throw new Error("Attempt receipt conflicts with an existing assignment");
      this.db.raw.prepare("INSERT OR REPLACE INTO kv (key,value,updated_at) VALUES (?,?,datetime('now'))").run(receiptKey, JSON.stringify(message));
    }).immediate();
    this.logActionEvent("task_assignment_received", message);
  }

  private async handleTaskResult(message: AgentMessage): Promise<void> {
    this.logActionEvent("task_result_received", message);
  }

  private async handleStatusReport(message: AgentMessage): Promise<void> {
    this.logActionEvent("status_report_received", message);
  }

  private async handleResourceRequest(message: AgentMessage): Promise<void> {
    this.logActionEvent("resource_request_received", message);
  }

  private async handleKnowledgeShare(message: AgentMessage): Promise<void> {
    this.logActionEvent("knowledge_share_received", message);
  }

  private async handleCustomerRequest(message: AgentMessage): Promise<void> {
    this.logActionEvent("customer_request_received", message);
  }

  private async handleAlert(message: AgentMessage): Promise<void> {
    logger.warn("Alert received", {
      messageId: message.id,
      from: message.from,
      priority: message.priority,
    });
    this.logActionEvent("alert_received", message);
  }

  private async handleShutdownRequest(message: AgentMessage): Promise<void> {
    logger.warn("Shutdown request received", {
      messageId: message.id,
      from: message.from,
    });
    this.logActionEvent("shutdown_request_received", message);
  }

  private async handlePeerQuery(message: AgentMessage): Promise<void> {
    this.logActionEvent("peer_query_received", message);
  }

  private async handlePeerResponse(message: AgentMessage): Promise<void> {
    this.logActionEvent("peer_response_received", message);
  }

  private logActionEvent(action: string, message: AgentMessage): void {
    try {
      insertEvent(this.db.raw, {
        type: "action",
        agentAddress: message.from,
        goalId: message.goalId,
        taskId: message.taskId,
        content: JSON.stringify({
          action,
          messageId: message.id,
          messageType: message.type,
          to: message.to,
          priority: message.priority,
        }),
        tokenCount: Math.ceil(message.content.length / 4),
      });
    } catch (error) {
      logger.warn("Failed to write action event for message", {
        messageId: message.id,
        error: normalizeError(error).message,
      });
    }
  }
}

/** Support tokens in the envelope or JSON content, but reject contradictions. */
export function taskMessageAttemptId(message: AgentMessage): string | null {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(message.content); } catch { /* legacy text */ }
  if (!payload || typeof payload !== "object") payload = {};
  if (typeof payload.taskId === "string" && message.taskId && payload.taskId !== message.taskId) throw new Error("Conflicting task IDs");
  const nested = payload.result && typeof payload.result === "object" ? payload.result as Record<string, unknown> : {};
  const tokens = [message.attemptId, payload.attemptId, nested.attemptId].filter((token) => token !== undefined);
  if (tokens.some((token) => typeof token !== "string" || !token.trim()) || new Set(tokens).size > 1) {
    throw new Error("Invalid or conflicting task attemptId");
  }
  return tokens[0] as string | undefined ?? null;
}

/** Generic relay producers must not emit an unbound typed task message. */
export function validateOutgoingTaskContent(content: string): void {
  let candidate: unknown;
  try { candidate = extractAgentMessage(JSON.parse(content)); } catch { return; }
  const message = candidate as AgentMessage;
  if (message.type !== "task_assignment" && message.type !== "task_result") return;
  validateMessage(message);
  if (!taskMessageAttemptId(message)) throw new Error("Typed task message requires attemptId; legacy/ambiguous messages cannot be sent");
}

// ─── Helpers ────────────────────────────────────────────────────

function extractAgentMessage(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("parsed payload must be an object");
  }

  const maybeEnvelope = parsed as Partial<MessageEnvelope>;
  if (maybeEnvelope.protocol === "colony_message_v1" && maybeEnvelope.message) {
    return maybeEnvelope.message;
  }

  return parsed;
}

function parseInboundMessage(row: InboxMessage): AgentMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.content);
  } catch {
    throw new Error("inbox content is not valid JSON");
  }

  const candidate = extractAgentMessage(parsed);
  validateMessage(candidate);

  const msg = candidate as AgentMessage;
  if (msg.expiresAt && Date.parse(msg.expiresAt) < Date.now()) {
    throw new Error("message is expired");
  }

  return msg;
}

function validateMessage(message: unknown): asserts message is AgentMessage {
  if (!message || typeof message !== "object") {
    throw new Error("message must be an object");
  }

  const value = message as Partial<AgentMessage>;

  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("message.id is required");
  }
  if (!isMessageType(value.type)) {
    throw new Error(`invalid message.type: ${String(value.type)}`);
  }
  if (typeof value.from !== "string" || value.from.length === 0) {
    throw new Error("message.from is required");
  }
  if (typeof value.to !== "string" || value.to.length === 0) {
    throw new Error("message.to is required");
  }
  if (typeof value.content !== "string") {
    throw new Error("message.content must be string");
  }
  if (!isPriority(value.priority)) {
    throw new Error(`invalid message.priority: ${String(value.priority)}`);
  }
  if (typeof value.requiresResponse !== "boolean") {
    throw new Error("message.requiresResponse must be boolean");
  }
  if (typeof value.createdAt !== "string" || !isIsoDate(value.createdAt)) {
    throw new Error("message.createdAt must be an ISO date string");
  }
  if (value.type === "task_assignment" || value.type === "task_result") taskMessageAttemptId(value as AgentMessage);
}

function createRejectedMessage(row: InboxMessage): AgentMessage {
  return {
    id: ulid(),
    type: "alert",
    from: row.from,
    to: row.to,
    goalId: null,
    taskId: null,
    content: row.content,
    priority: "high",
    requiresResponse: false,
    expiresAt: null,
    createdAt: row.createdAt,
  };
}

function isMessageType(value: unknown): value is MessageType {
  return typeof value === "string" && (MESSAGE_TYPES as readonly string[]).includes(value);
}

function isPriority(value: unknown): value is "low" | "normal" | "high" | "critical" {
  return value === "low" || value === "normal" || value === "high" || value === "critical";
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return !Number.isNaN(Date.parse(value));
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
