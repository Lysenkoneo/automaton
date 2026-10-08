import type { Database } from "better-sqlite3";

export const RESULT_QUEUE_PREFIX = "colony.result.";

/** Caller holds the same transaction as the inbox acknowledgement. */
export function stageTaskResultBeforeAck(db: Database, inboxId: string, acceptedMessage?: { type: string }): string | null {
  const row = db.prepare("SELECT content FROM inbox_messages WHERE id=?").get(inboxId) as { content: string } | undefined;
  if (!row) return null;
  let parsed: any;
  try { parsed = JSON.parse(row.content); } catch { return null; }
  const message = acceptedMessage ?? (parsed?.protocol === "colony_message_v1" ? parsed.message : parsed);
  if (message?.type !== "task_result") return null;
  // A previously accepted result must remain replayable after its transport TTL.
  if (!acceptedMessage && message.expiresAt && Date.parse(message.expiresAt) < Date.now()) return null;
  const key = RESULT_QUEUE_PREFIX + inboxId;
  db.prepare("INSERT OR IGNORE INTO kv (key,value,updated_at) VALUES (?,?,datetime('now'))")
    .run(key, JSON.stringify(message));
  return key;
}

/** Generic agent-turn acknowledgements must persist the assignment receipt too. */
export function stageTaskAssignmentBeforeAck(db: Database, inboxId: string): void {
  const row = db.prepare("SELECT content FROM inbox_messages WHERE id=?").get(inboxId) as { content: string } | undefined;
  if (!row) return;
  let parsed: any;
  try { parsed = JSON.parse(row.content); } catch { return; }
  const message = parsed?.protocol === "colony_message_v1" ? parsed.message : parsed;
  if (message?.type !== "task_assignment") return;
  let payload: any = {};
  try { payload = JSON.parse(message.content); } catch { /* token may be in envelope */ }
  const tokens = [message.attemptId, payload?.attemptId].filter(value => value !== undefined);
  if (!tokens.length || tokens.some(value => typeof value !== "string" || !value.trim()) || new Set(tokens).size !== 1)
    throw new Error("Assignment acknowledgement requires an unambiguous attemptId");
  const key = `colony.assignment.${tokens[0]}`;
  const value = JSON.stringify(message);
  const existing = db.prepare("SELECT value FROM kv WHERE key=?").get(key) as { value: string } | undefined;
  if (existing && existing.value !== value) throw new Error("Conflicting assignment receipt");
  db.prepare("INSERT OR IGNORE INTO kv (key,value,updated_at) VALUES (?,?,datetime('now'))").run(key, value);
}
