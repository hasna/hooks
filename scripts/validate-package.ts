import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type PackageJson = {
  name: string;
  types?: string;
  exports?: Record<string, unknown>;
};

type PackEntry = {
  filename: string;
  files: Array<{ path: string }>;
};

const root = process.cwd();

function normalizePackagePath(path: string): string {
  return path.replace(/^\.\//, "");
}

function run(command: string, args: string[], options: { cwd?: string } = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const rendered = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${rendered}`);
  }

  return result.stdout;
}

async function readPackageJson(path: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path, "utf8")) as PackageJson;
}

function collectExportTypes(value: unknown, paths: Set<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (typeof record.types === "string") paths.add(normalizePackagePath(record.types));
  for (const nested of Object.values(record)) collectExportTypes(nested, paths);
}

function collectRequiredTypePaths(pkg: PackageJson): string[] {
  const paths = new Set<string>();
  if (pkg.types) paths.add(normalizePackagePath(pkg.types));
  if (pkg.exports) collectExportTypes(pkg.exports, paths);
  return [...paths].sort();
}

function assertPackedTypes(pkg: PackageJson, pack: PackEntry): void {
  const packedPaths = new Set(pack.files.map((file) => file.path));
  const missing = collectRequiredTypePaths(pkg).filter((path) => !packedPaths.has(path));

  if (missing.length > 0) {
    throw new Error(`Packed package is missing declaration files referenced by package.json: ${missing.join(", ")}`);
  }
}

function runTsc(args: string[], cwd: string): void {
  const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  run(tsc, args, { cwd });
}

async function validateConsumerImports(pkg: PackageJson): Promise<void> {
  const tempRoot = join(root, "temp");
  await mkdir(tempRoot, { recursive: true });
  const workspace = await mkdtemp(join(tempRoot, "hasna-hooks-pack-"));
  try {
    const tarballJson = run("npm", ["pack", "--json", "--ignore-scripts", "--dry-run=false", "--pack-destination", workspace]);
    const [tarball] = JSON.parse(tarballJson) as PackEntry[];
    if (!tarball?.filename) throw new Error("npm pack did not return a tarball filename");

    const packageDir = join(workspace, "consumer", "node_modules", "@hasna", "hooks");
    await mkdir(packageDir, { recursive: true });
    run("tar", ["-xzf", join(workspace, tarball.filename), "-C", packageDir, "--strip-components=1"]);

    const consumerDir = join(workspace, "consumer");
    await writeFile(join(consumerDir, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
    const consumerFile = join(consumerDir, "consumer.ts");
    await writeFile(
      consumerFile,
      [
        `import { HOOKS, type HookInput } from "${pkg.name}";`,
        `import { getStorageStatus, type StorageStatus } from "${pkg.name}/storage";`,
        "",
        "const input: HookInput = { cwd: process.cwd() };",
        "const hookCount: number = HOOKS.length;",
        "const status: StorageStatus = getStorageStatus();",
        "void input;",
        "void hookCount;",
        "void status;",
        "",
      ].join("\n"),
    );

    runTsc([
      "--noEmit",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "--skipLibCheck",
      "--strict",
      "--types",
      "bun-types",
      consumerFile,
    ], dirname(consumerFile));

    runTsc([
      "--noEmit",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--strict",
      "--types",
      "bun-types",
      consumerFile,
    ], dirname(consumerFile));
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  const pkg = await readPackageJson(join(root, "package.json"));
  const packJson = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  const [pack] = JSON.parse(packJson) as PackEntry[];
  if (!pack) throw new Error("npm pack --dry-run did not return package metadata");

  assertPackedTypes(pkg, pack);
  await validateConsumerImports(pkg);

  console.log("Package validation passed: packed declarations are present and Bundler/NodeNext TypeScript consumer imports resolve.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
