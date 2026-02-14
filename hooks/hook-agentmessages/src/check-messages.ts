#!/usr/bin/env bun
/**
 * Stop hook for service-message
 *
 * Runs when Claude finishes a response. Checks for unread messages
 * and notifies Claude if there are any pending messages.
 *
 * This is efficient because it only runs after Claude completes a turn,
 * not continuously polling.
 */

import { homedir } from 'os';
import { join } from 'path';
import { readdir } from 'fs/promises';

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  stop_hook_active?: boolean;
}

interface Message {
  id: string;
  timestamp: number;
  from: string;
  to: string;
  project: string;
  subject: string;
  body: string;
  read?: boolean;
}

const SERVICE_DIR = join(homedir(), '.service', 'service-message');

/**
 * Sanitize ID to prevent path traversal attacks
 */
function sanitizeId(id: string): string | null {
  if (!id || typeof id !== 'string') return null;
  // Only allow alphanumeric, dash, underscore
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  // Reject path traversal attempts
  if (id.includes('..') || id.includes('/') || id.includes('\\')) return null;
  return id;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const file = Bun.file(path);
    if (await file.exists()) {
      return await file.json();
    }
  } catch {}
  return null;
}

async function getUnreadMessages(agentId: string, projectId?: string): Promise<Message[]> {
  const messages: Message[] = [];
  const messagesDir = join(SERVICE_DIR, 'messages');

  try {
    const rawProjects = projectId ? [projectId] : await readdir(messagesDir);
    // Sanitize all project names to prevent path traversal
    const projects = rawProjects.map(p => sanitizeId(p)).filter((p): p is string => p !== null);

    for (const proj of projects) {
      // Check inbox
      const inboxDir = join(messagesDir, proj, 'inbox', agentId);
      try {
        const files = await readdir(inboxDir);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          // Sanitize filename to prevent path traversal
          const safeFile = sanitizeId(file.replace('.json', ''));
          if (!safeFile) continue;
          const msg = await readJson<Message>(join(inboxDir, `${safeFile}.json`));
          if (msg && !msg.read) {
            messages.push(msg);
          }
        }
      } catch {}

      // Check broadcast
      const broadcastDir = join(messagesDir, proj, 'broadcast');
      try {
        const files = await readdir(broadcastDir);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          // Sanitize filename to prevent path traversal
          const safeFile = sanitizeId(file.replace('.json', ''));
          if (!safeFile) continue;
          const msg = await readJson<Message>(join(broadcastDir, `${safeFile}.json`));
          if (msg && !msg.read && msg.from !== agentId) {
            messages.push(msg);
          }
        }
      } catch {}
    }
  } catch {}

  return messages.sort((a, b) => b.timestamp - a.timestamp);
}

async function main() {
  // Get agent ID from environment (set by session-start hook)
  const rawAgentId = process.env.SMSG_AGENT_ID;
  const rawProjectId = process.env.SMSG_PROJECT_ID;

  // Sanitize IDs to prevent path traversal
  const agentId = rawAgentId ? sanitizeId(rawAgentId) : null;
  const projectId = rawProjectId ? sanitizeId(rawProjectId) : undefined;

  if (!agentId) {
    // Agent not configured or invalid, skip silently
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Check for unread messages
  const unreadMessages = await getUnreadMessages(agentId, projectId);

  if (unreadMessages.length === 0) {
    // No messages, continue normally
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Format message summary in a friendly way
  const msgList = unreadMessages.slice(0, 3).map(msg => {
    const time = new Date(msg.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const preview = msg.body.slice(0, 60).replace(/\n/g, ' ');
    return `📨 **${msg.subject}** from \`${msg.from}\` (${time})\n   ${preview}${msg.body.length > 60 ? '...' : ''}`;
  }).join('\n\n');

  const moreNote = unreadMessages.length > 3
    ? `\n\n_...and ${unreadMessages.length - 3} more message(s)_`
    : '';

  // Inject message in a friendly, readable format
  console.log(JSON.stringify({
    continue: true,
    stopReason: `📬 **You have ${unreadMessages.length} unread message(s):**\n\n${msgList}${moreNote}\n\n💡 Use \`service-message inbox\` to see all messages or \`service-message read <id>\` to read one.`
  }));
}

main().catch(() => {
  // Don't block on errors
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
});
