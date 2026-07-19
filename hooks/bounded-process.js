import { spawn } from "node:child_process";
import { existsSync, readFileSync, readSync } from "node:fs";
import { delimiter, join } from "node:path";

export const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
export const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;

const MAX_CONCURRENT_PROCESSES = 4;
const MAX_QUEUED_PROCESSES = 32;
const TERMINATION_GRACE_MS = 125;
const INTERNAL_CONTAINED_ENV = "HASNA_HOOKS_INTERNAL_CONTAINED";
const INTERNAL_NETWORK_ENV = "HASNA_HOOKS_INTERNAL_NETWORK";

function isBubblewrapPidNamespace() {
  if (process.platform !== "linux") return false;
  try {
    const initCommand = readFileSync("/proc/1/cmdline", "utf8").split("\0");
    return initCommand[0]?.endsWith("/bwrap")
      && initCommand.includes("--die-with-parent")
      && initCommand.includes("--unshare-pid");
  } catch {
    return false;
  }
}

const INHERITED_CONTAINMENT = process.env[INTERNAL_CONTAINED_ENV] === "1" && isBubblewrapPidNamespace();
const INHERITED_NETWORK = process.env[INTERNAL_NETWORK_ENV] === "deny" ? "deny" : "allow";

const SAFE_ENV_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "USER",
  "LOGNAME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "CLAUDE_CODE_TASK_LIST_ID",
  "CLAUDE_ENV_FILE",
  "CLAUDE_PROJECT_DIR",
  "CHECK_TASKS_DISABLED",
  "CHECK_TASKS_KEYWORDS",
  "CODEWITH_AGENT_NAME",
  "CODEWITH_RUN_ID",
  "CODEWITH_SUBAGENT",
  "CODEWITH_TASK_ID",
  "CODEWITH_WORKSPACE_ROOTS",
  "CONVERSATIONS_AGENT_ID",
  "COST_WATCH_BUDGET",
  "HASNA_ACTIVE_REPO_ROOTS",
  "HASNA_ACTIVE_WORKTREE_ROOTS",
  "HASNA_HOOKS_CACHE_DIR",
  "HASNA_HOOKS_CODEWITH_CONFIG_PATH",
  "HASNA_HOOKS_DATA_DIR",
  "HASNA_HOOKS_DB_PATH",
  "HASNA_HOOKS_IDENTITY_CACHE_MS",
  "HASNA_HOOKS_SESSION_START_CACHE_MS",
  "HASNA_HOOKS_STOP_SYNC_TASK_COMMENT",
  "HASNA_REPOS_WORKTREES_ROOT",
  "HASNA_RUN_ID",
  "HASNA_SUBAGENT",
  "HASNA_TASK_ID",
  "HASNA_WORKSPACE_ROOTS",
  "HOOKS_AGENT_NAME",
  "HOOKS_DATA_DIR",
  "HOOKS_DB_PATH",
  "HOOKS_FLEET_AGENT",
  "HOOKS_FLEET_CATCHUP_DISABLE",
  "HOOKS_FLEET_GATE_DISABLE",
  "HOOKS_FLEET_GATE_TTL_MS",
  "HOOKS_FLEET_SINCE",
  "HOOKS_FLEET_TIMEOUT_MS",
  "HOOKS_RETENTION_DAYS",
  "HOOKS_RULES_CHECK_DISABLE",
  "HOOKS_RULES_CONFIG_SLUG",
  "HOOKS_RULES_EXPECTED_VERSION",
  "HOOKS_RULES_FILES",
  "HOOKS_SOUND_FILE",
  "HOOKS_SPACE",
  "RUN_ID",
  "SMSG_AGENT_ID",
  "SMSG_PROJECT_ID",
  "TASK_ID",
  "VIRTUAL_ENV",
  "NVM_DIR",
]);

const FORBIDDEN_ENV_NAMES = new Set([
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "RUBYOPT",
  "PERL5OPT",
  "PYTHONINSPECT",
  "PYTHONSTARTUP",
]);

const SENSITIVE_ENV_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|AUTHORIZATION|COOKIE|WEBHOOK|DATABASE_?URL|DB_?URL)(?:_|$)|^(?:AWS|AZURE|GOOGLE|GITHUB|GITLAB|NPM|OPENAI|ANTHROPIC|STRIPE|TWILIO|SLACK)_/i;

let activeProcesses = 0;
const processQueue = [];

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), maximum);
}

function byteLength(value) {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  return 0;
}

function failedResult(message, overrides = {}) {
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    error: message,
    ...overrides,
  };
}

function acquireProcessSlot(waitMs) {
  if (activeProcesses < MAX_CONCURRENT_PROCESSES) {
    activeProcesses += 1;
    return Promise.resolve("acquired");
  }
  if (processQueue.length >= MAX_QUEUED_PROCESSES) return Promise.resolve("full");
  return new Promise((resolve) => {
    const entry = { resolve, timer: null, active: true };
    entry.timer = setTimeout(() => {
      if (!entry.active) return;
      entry.active = false;
      const index = processQueue.indexOf(entry);
      if (index !== -1) processQueue.splice(index, 1);
      resolve("timeout");
    }, Math.max(1, waitMs));
    processQueue.push(entry);
  });
}

function releaseProcessSlot() {
  while (processQueue.length > 0) {
    const next = processQueue.shift();
    if (!next?.active) continue;
    next.active = false;
    clearTimeout(next.timer);
    next.resolve("acquired");
    return;
  }
  activeProcesses = Math.max(0, activeProcesses - 1);
}

function safeEnvironment(source, extraNames = []) {
  const output = {};
  for (const name of extraNames) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || FORBIDDEN_ENV_NAMES.has(name) || SENSITIVE_ENV_NAME.test(name)) {
      return { error: `environment name '${name}' is not permitted` };
    }
  }
  const names = new Set([...SAFE_ENV_NAMES, ...extraNames]);
  for (const name of names) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || FORBIDDEN_ENV_NAMES.has(name)) continue;
    const value = source?.[name];
    if (typeof value === "string") output[name] = value;
  }
  if (!output.PATH) output.PATH = "/usr/local/bin:/usr/bin:/bin";
  if (INHERITED_CONTAINMENT) {
    output[INTERNAL_CONTAINED_ENV] = "1";
    output[INTERNAL_NETWORK_ENV] = INHERITED_NETWORK;
  }
  return { env: output };
}

function executableOnPath(command, env) {
  if (command.includes("/")) return existsSync(command) ? command : null;
  for (const directory of (env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function prepareCommand(argv, network, env, containmentExecutable) {
  if (process.platform === "win32") {
    return { error: "hook command execution is disabled on Windows because descendant process containment is unavailable" };
  }

  if (process.platform === "linux") {
    if (INHERITED_CONTAINMENT) {
      if (INHERITED_NETWORK === "allow" && network === "deny") {
        return { error: "nested hook cannot strengthen network isolation inside an allow-network container" };
      }
      return { argv };
    }
    const configured = typeof containmentExecutable === "string" ? containmentExecutable : null;
    const bwrap = configured
      ? (existsSync(configured) ? configured : null)
      : (existsSync("/usr/bin/bwrap") ? "/usr/bin/bwrap" : executableOnPath("bwrap", env));
    if (!bwrap) return { error: "contained hook execution requires bubblewrap on Linux" };
    const networkArgs = network === "deny" ? ["--unshare-net"] : [];
    env[INTERNAL_CONTAINED_ENV] = "1";
    env[INTERNAL_NETWORK_ENV] = network;
    return {
      argv: [
        bwrap,
        "--new-session",
        "--die-with-parent",
        "--bind", "/", "/",
        "--dev-bind", "/dev", "/dev",
        "--unshare-user",
        "--unshare-pid",
        "--proc", "/proc",
        ...networkArgs,
        "--",
        ...argv,
      ],
    };
  }

  if (network === "deny" && process.platform === "darwin") {
    const sandboxExec = existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : null;
    if (!sandboxExec) return { error: "network-denied hook execution requires sandbox-exec on macOS" };
    return {
      argv: [sandboxExec, "-p", "(version 1) (allow default) (deny network*)", ...argv],
    };
  }

  if (network === "deny") {
    return { error: `network-denied hook execution is unavailable on ${process.platform}` };
  }
  return { argv };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateProcessTree(child) {
  const pid = child.pid;
  const send = (signal) => {
    if (typeof pid === "number" && pid > 0) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {}
    }
    try { child.kill(signal); } catch {}
  };

  send("SIGTERM");
  await delay(TERMINATION_GRACE_MS);
  send("SIGKILL");
  await delay(25);
}

function appendCapped(chunks, chunk, state, limit, streamName, stop) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = Math.max(0, limit - state.bytes);
  if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
  state.bytes += Math.min(buffer.byteLength, remaining);
  if (buffer.byteLength > remaining && !state.error) {
    state.error = `${streamName} exceeds ${limit} bytes`;
    stop();
  }
}

export function readBoundedStdin(maxBytes = DEFAULT_MAX_INPUT_BYTES) {
  const limit = positiveInteger(maxBytes, DEFAULT_MAX_INPUT_BYTES);
  const chunks = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(8 * 1024);
  while (true) {
    const read = readSync(0, buffer, 0, buffer.byteLength, null);
    if (read === 0) break;
    if (total + read > limit) throw new Error(`hook input exceeds ${limit} bytes`);
    chunks.push(Buffer.from(buffer.subarray(0, read)));
    total += read;
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function runBoundedProcess(argv, options = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== "string" || part.length === 0)) {
    return failedResult("hook command must be a non-empty argument vector");
  }

  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 24 * 60 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;
  const maxInputBytes = positiveInteger(options.maxInputBytes, DEFAULT_MAX_INPUT_BYTES);
  const maxStdoutBytes = positiveInteger(options.maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES);
  const maxStderrBytes = positiveInteger(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES);
  const input = options.input ?? "";
  if (typeof input !== "string" && !(input instanceof Uint8Array)) {
    return failedResult("hook input must be a string or Uint8Array");
  }
  if (byteLength(input) > maxInputBytes) {
    return failedResult(`hook input exceeds ${maxInputBytes} bytes`);
  }

  const network = options.network === "allow" ? "allow" : "deny";
  const sanitized = safeEnvironment(options.env ?? process.env, options.envAllowlist ?? []);
  if (sanitized.error) return failedResult(sanitized.error);
  const env = sanitized.env;
  const prepared = prepareCommand(argv, network, env, options.containmentExecutable);
  if (prepared.error) return failedResult(prepared.error);

  const admission = await acquireProcessSlot(Math.max(1, deadline - Date.now()));
  if (admission === "full") {
    return failedResult(`hook process queue exceeds ${MAX_QUEUED_PROCESSES} waiting commands`);
  }
  if (admission === "timeout") {
    return failedResult(`hook command timed out after ${timeoutMs} ms while waiting for a process slot`, { timedOut: true });
  }

  try {
    const executionTimeoutMs = deadline - Date.now();
    if (executionTimeoutMs <= 0) {
      return failedResult(`hook command timed out after ${timeoutMs} ms while waiting for a process slot`, { timedOut: true });
    }
    let child;
    try {
      child = spawn(prepared.argv[0], prepared.argv.slice(1), {
        cwd: options.cwd,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return failedResult("failed to start hook command");
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutState = { bytes: 0, error: null };
    const stderrState = { bytes: 0, error: null };
    let timedOut = false;
    let spawnError = null;
    let stopPromise = null;
    const stop = () => {
      if (!stopPromise) stopPromise = terminateProcessTree(child);
    };

    child.stdout?.on("data", (chunk) => appendCapped(stdoutChunks, chunk, stdoutState, maxStdoutBytes, "hook stdout", stop));
    child.stderr?.on("data", (chunk) => appendCapped(stderrChunks, chunk, stderrState, maxStderrBytes, "hook stderr", stop));
    // A fast-exiting hook may close stdin before the bounded payload flushes.
    // EPIPE is an expected child lifecycle outcome and must not crash the host.
    child.stdin?.on("error", () => {});

    const completion = new Promise((resolve) => {
      child.once("error", () => {
        spawnError = "failed to start hook command";
        resolve({ exitCode: null, signal: null });
      });
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, executionTimeoutMs);

    try {
      child.stdin?.end(input);
    } catch {
      stop();
    }

    const completed = await completion;
    clearTimeout(timer);
    if (stopPromise) await stopPromise;

    const error = spawnError
      || stdoutState.error
      || stderrState.error
      || (timedOut ? `hook command timed out after ${timeoutMs} ms` : null);
    return {
      exitCode: completed.exitCode,
      signal: completed.signal,
      stdout: Buffer.concat(stdoutChunks, stdoutState.bytes).toString("utf8"),
      stderr: Buffer.concat(stderrChunks, stderrState.bytes).toString("utf8"),
      timedOut,
      error,
    };
  } finally {
    releaseProcessSlot();
  }
}
