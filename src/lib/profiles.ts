/**
 * Agent profile management — identity system for hooks
 *
 * Each agent instance gets a unique 8-char UUID stored at ~/.hasna/hooks/profiles/<id>.json.
 * Profiles are injected into HookInput when hooks are run with --profile <id>,
 * allowing hooks to identify which agent is calling them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface AgentProfile {
  agent_id: string;
  agent_type: "claude" | "gemini" | "custom";
  name?: string;
  created_at: string;
  last_seen_at: string;
  preferences: Record<string, unknown>;
}

export interface CreateProfileInput {
  agent_type: "claude" | "gemini" | "custom";
  name?: string;
}

function resolveProfilesDir(): string {
  const newDir = join(homedir(), ".hasna", "hooks", "profiles");
  const oldDir = join(homedir(), ".hooks", "profiles");

  // Auto-migrate: copy old profiles to new location if needed
  if (!existsSync(newDir) && existsSync(oldDir)) {
    mkdirSync(join(homedir(), ".hasna", "hooks"), { recursive: true });
    cpSync(oldDir, newDir, { recursive: true });
  }

  return newDir;
}

const PROFILES_DIR = resolveProfilesDir();

function ensureProfilesDir(): void {
  if (!existsSync(PROFILES_DIR)) {
    mkdirSync(PROFILES_DIR, { recursive: true });
  }
}

function profilePath(id: string): string {
  return join(PROFILES_DIR, `${id}.json`);
}

function shortUuid(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function getProfilesDir(): string {
  return PROFILES_DIR;
}

export function createProfile(input: CreateProfileInput): AgentProfile {
  ensureProfilesDir();

  const id = shortUuid();
  const now = new Date().toISOString();

  const profile: AgentProfile = {
    agent_id: id,
    agent_type: input.agent_type,
    created_at: now,
    last_seen_at: now,
    preferences: {},
  };

  if (input.name) {
    profile.name = input.name;
  }

  writeFileSync(profilePath(id), JSON.stringify(profile, null, 2) + "\n");
  return profile;
}

export function getProfile(id: string): AgentProfile | null {
  const path = profilePath(id);
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function listProfiles(): AgentProfile[] {
  if (!existsSync(PROFILES_DIR)) return [];

  try {
    const files = readdirSync(PROFILES_DIR).filter((f) => f.endsWith(".json"));
    const profiles: AgentProfile[] = [];

    for (const file of files) {
      try {
        const content = readFileSync(join(PROFILES_DIR, file), "utf-8");
        profiles.push(JSON.parse(content));
      } catch {
        // Skip corrupt files
      }
    }

    return profiles.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
  } catch {
    return [];
  }
}

export function updateProfile(
  id: string,
  data: Partial<Pick<AgentProfile, "name" | "preferences">>
): AgentProfile | null {
  const profile = getProfile(id);
  if (!profile) return null;

  if (data.name !== undefined) profile.name = data.name;
  if (data.preferences !== undefined) profile.preferences = data.preferences;

  writeFileSync(profilePath(id), JSON.stringify(profile, null, 2) + "\n");
  return profile;
}

export function deleteProfile(id: string): boolean {
  const path = profilePath(id);
  if (!existsSync(path)) return false;

  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

export function touchProfile(id: string): void {
  const profile = getProfile(id);
  if (!profile) return;

  profile.last_seen_at = new Date().toISOString();
  writeFileSync(profilePath(id), JSON.stringify(profile, null, 2) + "\n");
}

/** Export all profiles as a JSON bundle for cross-machine backup */
export function exportProfiles(): AgentProfile[] {
  return listProfiles();
}

/** Import profiles from a JSON bundle, skipping duplicates by agent_id */
export function importProfiles(profiles: AgentProfile[]): { imported: number; skipped: number } {
  ensureProfilesDir();
  let imported = 0;
  let skipped = 0;

  for (const profile of profiles) {
    if (!profile.agent_id || !profile.agent_type) {
      skipped++;
      continue;
    }
    const path = profilePath(profile.agent_id);
    if (existsSync(path)) {
      skipped++;
      continue;
    }
    writeFileSync(path, JSON.stringify(profile, null, 2) + "\n");
    imported++;
  }

  return { imported, skipped };
}
