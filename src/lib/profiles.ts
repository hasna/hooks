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

const PROFILES_DIR = join(homedir(), ".hasna", "hooks", "profiles");
const LEGACY_PROFILES_DIR = join(homedir(), ".hooks", "profiles");

function migrateProfilesIfNeeded(): void {
  // Migration is a mutation and therefore happens only on an explicitly
  // mutating profile operation, never merely because the module was imported.
  if (!existsSync(PROFILES_DIR) && existsSync(LEGACY_PROFILES_DIR)) {
    mkdirSync(join(homedir(), ".hasna", "hooks"), { recursive: true });
    cpSync(LEGACY_PROFILES_DIR, PROFILES_DIR, { recursive: true });
  }
}

function ensureProfilesDir(): void {
  migrateProfilesIfNeeded();
  if (!existsSync(PROFILES_DIR)) {
    mkdirSync(PROFILES_DIR, { recursive: true });
  }
}

function profilePath(id: string, readOnly = false): string {
  if (readOnly && !existsSync(PROFILES_DIR) && existsSync(LEGACY_PROFILES_DIR)) {
    return join(LEGACY_PROFILES_DIR, `${id}.json`);
  }
  return join(PROFILES_DIR, `${id}.json`);
}

function readableProfilesDir(): string {
  if (existsSync(PROFILES_DIR)) return PROFILES_DIR;
  return LEGACY_PROFILES_DIR;
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
  const path = profilePath(id, true);
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function listProfiles(): AgentProfile[] {
  const profilesDir = readableProfilesDir();
  if (!existsSync(profilesDir)) return [];

  try {
    const files = readdirSync(profilesDir).filter((f) => f.endsWith(".json"));
    const profiles: AgentProfile[] = [];

    for (const file of files) {
      try {
        const content = readFileSync(join(profilesDir, file), "utf-8");
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
  migrateProfilesIfNeeded();
  const profile = getProfile(id);
  if (!profile) return null;

  if (data.name !== undefined) profile.name = data.name;
  if (data.preferences !== undefined) profile.preferences = data.preferences;

  writeFileSync(profilePath(id), JSON.stringify(profile, null, 2) + "\n");
  return profile;
}

export function deleteProfile(id: string): boolean {
  migrateProfilesIfNeeded();
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
  migrateProfilesIfNeeded();
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
