/**
 * Parent-Child Messaging
 *
 * Relay-based communication between parent and child automatons.
 * Replaces unauthenticated filesystem-based messageChild().
 */

import type { SocialClientInterface, ParentChildMessage } from "../types.js";
import { MESSAGE_LIMITS } from "../types.js";
import { ulid } from "ulid";
import { validateOutgoingTaskContent } from "../orchestration/messaging.js";

function relayContent(content: string, type: string): string {
  validateOutgoingTaskContent(content);
  if (type === "task_assignment" || type === "task_result") {
    const parsed = JSON.parse(content);
    const message = parsed.protocol === "colony_message_v1" ? parsed.message : parsed;
    if (message?.type !== type) throw new Error("Typed task relay requires a complete colony message with attemptId");
    // Preserve the typed envelope, rather than burying it in an untyped wrapper.
    return content;
  }
  return JSON.stringify({ type, content, sentAt: new Date().toISOString() });
}

/**
 * Send a message to a child via the social relay.
 */
export async function sendToChild(
  social: SocialClientInterface,
  childAddress: string,
  content: string,
  type: string = "parent_message",
): Promise<{ id: string }> {
  if (content.length > MESSAGE_LIMITS.maxContentLength) {
    throw new Error(`Message too long: ${content.length} bytes (max ${MESSAGE_LIMITS.maxContentLength})`);
  }

  const result = await social.send(childAddress, relayContent(content, type));

  return { id: result.id };
}

/**
 * Send a message to the parent via the social relay.
 */
export async function sendToParent(
  social: SocialClientInterface,
  parentAddress: string,
  content: string,
  type: string = "child_message",
): Promise<{ id: string }> {
  if (content.length > MESSAGE_LIMITS.maxContentLength) {
    throw new Error(`Message too long: ${content.length} bytes (max ${MESSAGE_LIMITS.maxContentLength})`);
  }

  const result = await social.send(parentAddress, relayContent(content, type));

  return { id: result.id };
}
