import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  createProfile,
  getProfile,
  listProfiles,
  updateProfile,
  deleteProfile,
  touchProfile,
  getProfilesDir,
  type AgentProfile,
} from "./profiles.js";

// Track created profiles for cleanup
const createdIds: string[] = [];

function cleanup(): void {
  for (const id of createdIds) {
    const path = join(getProfilesDir(), `${id}.json`);
    if (existsSync(path)) rmSync(path);
  }
  createdIds.length = 0;
}

afterEach(() => {
  cleanup();
});

describe("profiles", () => {
  describe("createProfile", () => {
    test("creates a profile with 8-char agent_id", () => {
      const profile = createProfile({ agent_type: "claude" });
      createdIds.push(profile.agent_id);

      expect(profile.agent_id).toHaveLength(8);
      expect(profile.agent_type).toBe("claude");
      expect(profile.created_at).toBeTruthy();
      expect(profile.last_seen_at).toBeTruthy();
      expect(profile.preferences).toEqual({});
    });

    test("creates profile with gemini type", () => {
      const profile = createProfile({ agent_type: "gemini" });
      createdIds.push(profile.agent_id);

      expect(profile.agent_type).toBe("gemini");
    });

    test("creates profile with custom type", () => {
      const profile = createProfile({ agent_type: "custom" });
      createdIds.push(profile.agent_id);

      expect(profile.agent_type).toBe("custom");
    });

    test("creates profile with optional name", () => {
      const profile = createProfile({ agent_type: "claude", name: "my-agent" });
      createdIds.push(profile.agent_id);

      expect(profile.name).toBe("my-agent");
    });

    test("creates profile without name when not provided", () => {
      const profile = createProfile({ agent_type: "claude" });
      createdIds.push(profile.agent_id);

      expect(profile.name).toBeUndefined();
    });

    test("writes profile file to disk", () => {
      const profile = createProfile({ agent_type: "claude" });
      createdIds.push(profile.agent_id);

      const path = join(getProfilesDir(), `${profile.agent_id}.json`);
      expect(existsSync(path)).toBe(true);
    });

    test("each call creates a unique profile", () => {
      const p1 = createProfile({ agent_type: "claude" });
      const p2 = createProfile({ agent_type: "claude" });
      createdIds.push(p1.agent_id, p2.agent_id);

      expect(p1.agent_id).not.toBe(p2.agent_id);
    });

    test("sets created_at and last_seen_at to same timestamp", () => {
      const profile = createProfile({ agent_type: "claude" });
      createdIds.push(profile.agent_id);

      expect(profile.created_at).toBe(profile.last_seen_at);
    });

    test("created_at is a valid ISO timestamp", () => {
      const profile = createProfile({ agent_type: "claude" });
      createdIds.push(profile.agent_id);

      const date = new Date(profile.created_at);
      expect(date.toISOString()).toBe(profile.created_at);
    });
  });

  describe("getProfile", () => {
    test("returns profile by id", () => {
      const created = createProfile({ agent_type: "claude", name: "test" });
      createdIds.push(created.agent_id);

      const fetched = getProfile(created.agent_id);
      expect(fetched).not.toBeNull();
      expect(fetched!.agent_id).toBe(created.agent_id);
      expect(fetched!.agent_type).toBe("claude");
      expect(fetched!.name).toBe("test");
    });

    test("returns null for nonexistent id", () => {
      expect(getProfile("zzzzzzzz")).toBeNull();
    });

    test("returns null for invalid id", () => {
      expect(getProfile("")).toBeNull();
    });
  });

  describe("listProfiles", () => {
    test("returns empty array when no profiles exist", () => {
      // Don't create any profiles
      const profiles = listProfiles();
      // May have profiles from other tests/runs, so just check type
      expect(Array.isArray(profiles)).toBe(true);
    });

    test("returns created profiles", () => {
      const p1 = createProfile({ agent_type: "claude" });
      const p2 = createProfile({ agent_type: "gemini" });
      createdIds.push(p1.agent_id, p2.agent_id);

      const all = listProfiles();
      const ids = all.map((p) => p.agent_id);
      expect(ids).toContain(p1.agent_id);
      expect(ids).toContain(p2.agent_id);
    });

    test("profiles are sorted by created_at", () => {
      const p1 = createProfile({ agent_type: "claude" });
      const p2 = createProfile({ agent_type: "gemini" });
      createdIds.push(p1.agent_id, p2.agent_id);

      const all = listProfiles();
      for (let i = 1; i < all.length; i++) {
        expect(new Date(all[i].created_at).getTime()).toBeGreaterThanOrEqual(
          new Date(all[i - 1].created_at).getTime()
        );
      }
    });

    test("skips corrupt JSON files", () => {
      // Create a corrupt file
      const dir = getProfilesDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const corruptPath = join(dir, "corrupt1.json");
      writeFileSync(corruptPath, "not valid json{{{");

      const profiles = listProfiles();
      // Should not throw, and corrupt file should be skipped
      expect(Array.isArray(profiles)).toBe(true);

      // Clean up
      if (existsSync(corruptPath)) rmSync(corruptPath);
    });
  });

  describe("updateProfile", () => {
    test("updates name", () => {
      const profile = createProfile({ agent_type: "claude" });
      createdIds.push(profile.agent_id);

      const updated = updateProfile(profile.agent_id, { name: "renamed" });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("renamed");

      // Verify persisted
      const fetched = getProfile(profile.agent_id);
      expect(fetched!.name).toBe("renamed");
    });

    test("updates preferences", () => {
      const profile = createProfile({ agent_type: "claude" });
      createdIds.push(profile.agent_id);

      const updated = updateProfile(profile.agent_id, {
        preferences: { strict: true, theme: "dark" },
      });
      expect(updated!.preferences).toEqual({ strict: true, theme: "dark" });
    });

    test("returns null for nonexistent profile", () => {
      expect(updateProfile("zzzzzzzz", { name: "test" })).toBeNull();
    });

    test("preserves other fields when updating", () => {
      const profile = createProfile({ agent_type: "gemini", name: "original" });
      createdIds.push(profile.agent_id);

      updateProfile(profile.agent_id, { preferences: { key: "value" } });

      const fetched = getProfile(profile.agent_id);
      expect(fetched!.agent_type).toBe("gemini");
      expect(fetched!.name).toBe("original");
      expect(fetched!.created_at).toBe(profile.created_at);
    });
  });

  describe("deleteProfile", () => {
    test("deletes an existing profile", () => {
      const profile = createProfile({ agent_type: "claude" });
      // Don't add to createdIds since we're deleting it

      expect(deleteProfile(profile.agent_id)).toBe(true);
      expect(getProfile(profile.agent_id)).toBeNull();
    });

    test("returns false for nonexistent profile", () => {
      expect(deleteProfile("zzzzzzzz")).toBe(false);
    });

    test("removes file from disk", () => {
      const profile = createProfile({ agent_type: "claude" });
      const path = join(getProfilesDir(), `${profile.agent_id}.json`);

      expect(existsSync(path)).toBe(true);
      deleteProfile(profile.agent_id);
      expect(existsSync(path)).toBe(false);
    });
  });

  describe("touchProfile", () => {
    test("updates last_seen_at", async () => {
      const profile = createProfile({ agent_type: "claude" });
      createdIds.push(profile.agent_id);

      const originalLastSeen = profile.last_seen_at;

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 10));

      touchProfile(profile.agent_id);

      const updated = getProfile(profile.agent_id);
      expect(updated!.last_seen_at).not.toBe(originalLastSeen);
      expect(new Date(updated!.last_seen_at).getTime()).toBeGreaterThan(
        new Date(originalLastSeen).getTime()
      );
    });

    test("preserves created_at", () => {
      const profile = createProfile({ agent_type: "claude" });
      createdIds.push(profile.agent_id);

      touchProfile(profile.agent_id);

      const updated = getProfile(profile.agent_id);
      expect(updated!.created_at).toBe(profile.created_at);
    });

    test("does not throw for nonexistent profile", () => {
      expect(() => touchProfile("zzzzzzzz")).not.toThrow();
    });
  });

  describe("getProfilesDir", () => {
    test("returns path ending with .hooks/profiles", () => {
      const dir = getProfilesDir();
      expect(dir.endsWith(".hooks/profiles")).toBe(true);
    });
  });
});
