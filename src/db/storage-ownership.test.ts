/**
 * Storage-ownership guard for @hasna/hooks.
 *
 * @hasna/cloud is RETIRED. Its npm deprecation notice reads: "is retired and no
 * longer supported by Hasna. The source repo has been deleted. Do not add new
 * dependencies on it; services now own their storage (local SQLite /
 * self-hosted API)." Its GitHub repo is gone, so nothing can be patched there
 * ever again — a dependency on it is unfixable by construction.
 *
 * This package owns its storage directly through bun:sqlite. PR #16 (merged
 * 2026-07-30, six days AFTER the deprecation) replaced that with the
 * @hasna/cloud SqliteAdapter; this guard exists so the swap cannot land again
 * unnoticed.
 *
 * EVERY assertion below is paired with a positive control asserting that the
 * same reader/scanner DOES find something that is genuinely present. Without
 * those, a broken reader returning `{}` or an empty file list would make this
 * whole file pass while checking nothing.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { createTestDb } from "./index";

const RETIRED = "@hasna/cloud";
/** A dependency this package genuinely declares — the control for the manifest reader. */
const CONTROL_DEP = "@hasna/events";
/** A token that genuinely appears in src/ — the control for the tree scanner. */
const CONTROL_IMPORT = "bun:sqlite";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

const MANIFEST_DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function readManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
}

/** Every package name declared in any dependency field of package.json. */
function declaredDependencies(): string[] {
  const manifest = readManifest();
  const names: string[] = [];
  for (const field of MANIFEST_DEP_FIELDS) {
    const block = manifest[field];
    if (block && typeof block === "object") names.push(...Object.keys(block));
  }
  return names;
}

/**
 * This guard file names the retired package in its own prose and constants, so
 * it matches its own scan. Excluding exactly this one path — and nothing else —
 * keeps the scan honest: any other file that mentions the package still fails.
 */
const SELF = join(import.meta.dir, import.meta.file);

/** Every .ts/.tsx file under src/, recursively, except this guard itself. */
function sourceFiles(dir: string = SRC_ROOT): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(full);
  }
  return found.filter((file) => file !== SELF);
}

function filesContaining(token: string): string[] {
  return sourceFiles().filter((file) => readFileSync(file, "utf-8").includes(token));
}

describe("storage ownership: no dependency on the retired @hasna/cloud", () => {
  test("package.json declares no @hasna/cloud in any dependency field", () => {
    const declared = declaredDependencies();

    // POSITIVE CONTROL: the reader must actually see this manifest's contents.
    // If package.json were unreadable or the field names wrong, `declared` would
    // be empty and the real assertion below would pass while checking nothing.
    expect(declared).toContain(CONTROL_DEP);

    expect(declared).not.toContain(RETIRED);
  });

  test("no source file imports @hasna/cloud", () => {
    // POSITIVE CONTROL: the scanner must be able to find a token that IS there.
    // A scanner that walked the wrong directory would return [] for everything.
    expect(filesContaining(CONTROL_IMPORT).length).toBeGreaterThan(0);

    expect(filesContaining(RETIRED)).toEqual([]);
  });

  test("the database handle is a bun:sqlite Database, owned by this package", () => {
    const db = createTestDb();
    try {
      // Behavioural, not textual: swapping in any adapter wrapper fails here
      // even if the import string were laundered past the scan above.
      expect(db).toBeInstanceOf(Database);

      // And it is a working handle, not merely the right class.
      db.exec("CREATE TABLE probe (id TEXT PRIMARY KEY)");
      db.run("INSERT INTO probe (id) VALUES (?)", ["row1"]);
      const row = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM probe").get();
      expect(row?.count).toBe(1);
    } finally {
      db.close();
    }
  });
});
