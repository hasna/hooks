export type HookNetworkAccess = "deny" | "allow";

export interface BoundedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Extra non-sensitive names to forward; loader and credential-like names are rejected. */
  envAllowlist?: readonly string[];
  input?: string | Uint8Array;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  network?: HookNetworkAccess;
  /** Override the platform containment binary path, primarily for deterministic validation. */
  containmentExecutable?: string;
}

export interface BoundedProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
}

export const DEFAULT_MAX_INPUT_BYTES: number;
export const DEFAULT_MAX_STDOUT_BYTES: number;
export const DEFAULT_MAX_STDERR_BYTES: number;
export const DEFAULT_TIMEOUT_MS: number;

export function readBoundedStdin(maxBytes?: number): string;
export function runBoundedProcess(argv: string[], options?: BoundedProcessOptions): Promise<BoundedProcessResult>;
