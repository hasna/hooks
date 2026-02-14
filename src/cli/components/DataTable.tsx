import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { HookMeta } from "../../lib/registry.js";

const COL_CHECK = 5;
const COL_NAME = 18;
const COL_VERSION = 9;
const COL_EVENT = 14;
const COL_DESC = 40;

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 3) + "..." : str;
}

function pad(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : str + " ".repeat(width - str.length);
}

interface DataTableProps {
  hooks: HookMeta[];
  selected: Set<string>;
  onToggle: (name: string) => void;
  onConfirm: () => void;
  onBack: () => void;
}

export function DataTable({
  hooks,
  selected,
  onToggle,
  onConfirm,
  onBack,
}: DataTableProps) {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow) {
      setCursor((c) => Math.min(hooks.length - 1, c + 1));
    } else if (key.return || input === " ") {
      if (hooks[cursor]) {
        onToggle(hooks[cursor].name);
      }
    } else if (input === "i" && selected.size > 0) {
      onConfirm();
    } else if (key.escape) {
      onBack();
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>
          Select hooks (up/down to navigate, space/enter to toggle, esc to go back):
        </Text>
      </Box>

      {/* Header */}
      <Box>
        <Text dimColor>
          {pad("", COL_CHECK)}
          {pad("Name", COL_NAME)}
          {pad("Version", COL_VERSION)}
          {pad("Event", COL_EVENT)}
          {"Description"}
        </Text>
      </Box>
      <Box marginBottom={0}>
        <Text dimColor>
          {pad("─".repeat(COL_CHECK - 1), COL_CHECK)}
          {pad("─".repeat(COL_NAME - 1), COL_NAME)}
          {pad("─".repeat(COL_VERSION - 1), COL_VERSION)}
          {pad("─".repeat(COL_EVENT - 1), COL_EVENT)}
          {"─".repeat(COL_DESC)}
        </Text>
      </Box>

      {/* Rows */}
      {hooks.map((hook, i) => {
        const isHighlighted = i === cursor;
        const isSelected = selected.has(hook.name);
        const check = isSelected ? "[x]" : "[ ]";

        return (
          <Box key={hook.name}>
            <Text
              bold={isHighlighted}
              inverse={isHighlighted}
            >
              {pad(` ${check}`, COL_CHECK)}
              {pad(hook.displayName, COL_NAME)}
              {pad(hook.version, COL_VERSION)}
              {pad(hook.event, COL_EVENT)}
              {truncate(hook.description, COL_DESC)}
            </Text>
          </Box>
        );
      })}

      {/* Footer */}
      <Box marginTop={1} flexDirection="row" gap={2}>
        <Text dimColor>[esc] Back</Text>
        {selected.size > 0 && (
          <Text color="green" bold>
            {selected.size} selected
          </Text>
        )}
      </Box>

      {selected.size > 0 && (
        <Box marginTop={0}>
          <Text dimColor>
            Selected: {Array.from(selected).join(", ")}
          </Text>
        </Box>
      )}

      {selected.size > 0 && (
        <Box marginTop={1}>
          <Text>
            Press{" "}
            <Text bold color="cyan">
              i
            </Text>
            {" "}to install selected ({selected.size})
          </Text>
        </Box>
      )}
    </Box>
  );
}
