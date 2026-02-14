#!/usr/bin/env bun
/**
 * SessionStart hook for service-message
 *
 * Does NOT auto-generate agents. Agent must be registered via:
 *   service-message init
 *
 * Auto-registers project and session if agent exists.
 */

import { homedir } from 'os';
import { join, basename } from 'path';
import { mkdir, appendFile } from 'fs/promises';

interface HookInput {
  session_id?: string;
  cwd?: string;
  model?: string;
}

interface Agent {
  id: string;
  name: string;
  createdAt: number;
  lastSeen?: number;
}

interface Project {
  id: string;
  name: string;
  path?: string;
  createdAt: number;
}

interface Session {
  id: string;
  agentId: string;
  projectId: string;
  startedAt: number;
}

interface Config {
  agentId?: string;
}

const SERVICE_DIR = join(homedir(), '.service', 'service-message');

async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {}
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

async function writeJson(path: string, data: unknown): Promise<void> {
  await Bun.write(path, JSON.stringify(data, null, 2));
}

async function readStdinWithTimeout(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('{}'), timeoutMs);

    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      resolve(data || '{}');
    });
    process.stdin.on('error', () => {
      clearTimeout(timeout);
      resolve('{}');
    });

    if (process.stdin.isTTY) {
      clearTimeout(timeout);
      resolve('{}');
    }
  });
}

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

/**
 * Get existing agent - does NOT create one
 */
async function getAgent(): Promise<Agent | null> {
  const configPath = join(SERVICE_DIR, 'config.json');
  const config = await readJson<Config>(configPath);

  if (!config?.agentId) {
    return null;
  }

  // Sanitize agentId to prevent path traversal
  const safeAgentId = sanitizeId(config.agentId);
  if (!safeAgentId) {
    return null;
  }

  const agentsDir = join(SERVICE_DIR, 'agents');
  const agent = await readJson<Agent>(join(agentsDir, `${safeAgentId}.json`));

  if (agent) {
    // Verify agent.id matches safeAgentId to prevent tampering
    if (agent.id !== safeAgentId) {
      return null;
    }
    // Update lastSeen
    agent.lastSeen = Date.now();
    await writeJson(join(agentsDir, `${safeAgentId}.json`), agent);
  }

  return agent;
}

function getProjectNameFromPath(projectDir: string): string {
  if (projectDir === '/' || projectDir === homedir()) {
    return 'root';
  }

  const folderName = basename(projectDir);
  if (!folderName || folderName === '.' || folderName === '..') {
    return 'root';
  }

  return folderName;
}

function normalizeId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'default';
}

async function getOrCreateProject(projectDir: string): Promise<Project> {
  const projectsDir = join(SERVICE_DIR, 'projects');
  await ensureDir(projectsDir);

  const projectName = getProjectNameFromPath(projectDir);
  const projectId = normalizeId(projectName);

  const existingProject = await readJson<Project>(join(projectsDir, `${projectId}.json`));
  if (existingProject) {
    if (existingProject.path !== projectDir) {
      existingProject.path = projectDir;
      await writeJson(join(projectsDir, `${projectId}.json`), existingProject);
    }
    return existingProject;
  }

  const project: Project = {
    id: projectId,
    name: projectName,
    path: projectDir,
    createdAt: Date.now(),
  };

  await writeJson(join(projectsDir, `${projectId}.json`), project);
  return project;
}

async function startSession(agentId: string, projectId: string, claudeSessionId: string): Promise<Session> {
  const sessionsDir = join(SERVICE_DIR, 'sessions');
  await ensureDir(sessionsDir);

  const rawSessionId = claudeSessionId || `local-${Date.now()}`;
  // Sanitize session ID - only keep alphanumeric chars
  const safeSessionId = rawSessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'default';
  const sessionId = `cs-${safeSessionId}`;

  const existingSession = await readJson<Session>(join(sessionsDir, `${sessionId}.json`));
  if (existingSession) {
    return existingSession;
  }

  const session: Session = {
    id: sessionId,
    agentId,
    projectId,
    startedAt: Date.now(),
  };

  await writeJson(join(sessionsDir, `${sessionId}.json`), session);
  return session;
}

async function main() {
  const stdinData = await readStdinWithTimeout(2000);

  let input: HookInput = {};
  try {
    input = JSON.parse(stdinData);
  } catch {}

  const sessionId = input.session_id || `local-${Date.now()}`;
  const cwd = input.cwd || process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;
  const envFile = process.env.CLAUDE_ENV_FILE;

  await ensureDir(SERVICE_DIR);

  // Get existing agent - do NOT create one
  const agent = await getAgent();

  if (!agent) {
    // No agent configured - silently continue without setting env vars
    // User needs to run: service-message init
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Auto-register project and session
  const project = await getOrCreateProject(projectDir);
  const session = await startSession(agent.id, project.id, sessionId);

  if (envFile) {
    try {
      // Escape values to prevent shell injection
      const escapeShellValue = (val: string) => val.replace(/[`$"\\]/g, '\\$&');
      const envContent = [
        `export SMSG_AGENT_ID="${escapeShellValue(agent.id)}"`,
        `export SMSG_SESSION_ID="${escapeShellValue(session.id)}"`,
        `export SMSG_PROJECT_ID="${escapeShellValue(project.id)}"`,
      ].join('\n') + '\n';
      await appendFile(envFile, envContent);
    } catch {}
  }

  console.log(JSON.stringify({ continue: true }));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
});
