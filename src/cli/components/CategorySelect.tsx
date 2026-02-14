import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { CATEGORIES, getHooksByCategory } from "../../lib/registry.js";

interface CategorySelectProps {
  onSelect: (category: string) => void;
  onBack?: () => void;
}

export function CategorySelect({ onSelect, onBack }: CategorySelectProps) {
  const items: Array<{ label: string; value: string }> = CATEGORIES.map((cat) => ({
    label: `${cat} (${getHooksByCategory(cat).length})`,
    value: cat,
  }));

  if (onBack) {
    items.unshift({ label: "\u2190 Back", value: "__back__" });
  }

  const handleSelect = (item: { value: string }) => {
    if (item.value === "__back__" && onBack) {
      onBack();
    } else {
      onSelect(item.value);
    }
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}><Text bold>
        Select a category:
      </Text></Box>
      <SelectInput items={items} onSelect={handleSelect} />
    </Box>
  );
}
