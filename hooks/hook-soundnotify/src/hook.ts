#!/usr/bin/env bun

/**
 * Claude Code Hook: soundnotify
 *
 * Stop hook that plays a system sound when Claude finishes a session.
 *
 * Platform support:
 * - macOS: afplay (built-in)
 * - Linux: paplay (PulseAudio) or aplay (ALSA) fallback
 *
 * Configuration:
 * - HOOKS_SOUND_FILE env var: path to a custom sound file
 *
 * Runs async (fire-and-forget) — does not block session exit.
 * Always outputs { continue: true }.
 */

import { readFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import { platform } from "os";

interface HookInput {
  session_id: string;
  cwd: string;
}

interface HookOutput {
  continue: true;
}

/**
 * Default sound files per platform
 */
const DEFAULT_SOUNDS: Record<string, string> = {
  darwin: "/System/Library/Sounds/Glass.aiff",
  linux: "/usr/share/sounds/freedesktop/stereo/complete.oga",
};

/**
 * Fallback sound files for Linux
 */
const LINUX_FALLBACK_SOUNDS: string[] = [
  "/usr/share/sounds/freedesktop/stereo/complete.oga",
  "/usr/share/sounds/freedesktop/stereo/bell.oga",
  "/usr/share/sounds/freedesktop/stereo/message.oga",
];

/**
 * Read and parse JSON from stdin
 */
function readStdinJson(): HookInput | null {
  try {
    const input = readFileSync(0, "utf-8").trim();
    if (!input) return null;
    return JSON.parse(input);
  } catch {
    return null;
  }
}

/**
 * Find an available sound file
 */
function findSoundFile(): string | null {
  // Check env var first
  const envSound = process.env.HOOKS_SOUND_FILE;
  if (envSound && existsSync(envSound)) {
    return envSound;
  }

  const os = platform();

  if (os === "darwin") {
    const defaultSound = DEFAULT_SOUNDS.darwin;
    if (existsSync(defaultSound)) {
      return defaultSound;
    }
    return null;
  }

  if (os === "linux") {
    for (const sound of LINUX_FALLBACK_SOUNDS) {
      if (existsSync(sound)) {
        return sound;
      }
    }
    return null;
  }

  return null;
}

/**
 * Get the appropriate audio player command for the current platform
 */
function getPlayerCommand(soundFile: string): { cmd: string; args: string[] } | null {
  const os = platform();

  if (os === "darwin") {
    return { cmd: "afplay", args: [soundFile] };
  }

  if (os === "linux") {
    // Prefer paplay for PulseAudio, fallback to aplay for ALSA
    if (soundFile.endsWith(".oga") || soundFile.endsWith(".ogg")) {
      return { cmd: "paplay", args: [soundFile] };
    }
    return { cmd: "aplay", args: [soundFile] };
  }

  return null;
}

/**
 * Play the sound asynchronously (fire-and-forget)
 */
function playSound(soundFile: string): void {
  const player = getPlayerCommand(soundFile);
  if (!player) {
    console.error(`[hook-soundnotify] No audio player available for ${platform()}`);
    return;
  }

  try {
    const child = spawn(player.cmd, player.args, {
      stdio: "ignore",
      detached: true,
    });

    // Unref so the process doesn't keep the parent alive
    child.unref();

    console.error(`[hook-soundnotify] Playing: ${soundFile}`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[hook-soundnotify] Failed to play sound: ${errMsg}`);
  }
}

/**
 * Output hook response
 */
function respond(): void {
  const output: HookOutput = { continue: true };
  console.log(JSON.stringify(output));
}

/**
 * Main hook execution
 */
export function run(): void {
  // Read stdin (we don't really need the input, but follow the protocol)
  readStdinJson();

  const soundFile = findSoundFile();

  if (!soundFile) {
    console.error("[hook-soundnotify] No sound file found, skipping");
    respond();
    return;
  }

  // Fire-and-forget — play sound async
  playSound(soundFile);

  // Always continue
  respond();
}

if (import.meta.main) {
  run();
}
