import React from "react";
import { HookMeta } from "../../lib/registry.js";
import { DataTable } from "./DataTable.js";

interface HookSelectProps {
  hooks: HookMeta[];
  selected: Set<string>;
  onToggle: (name: string) => void;
  onConfirm: () => void;
  onBack: () => void;
}

export function HookSelect({
  hooks,
  selected,
  onToggle,
  onConfirm,
  onBack,
}: HookSelectProps) {
  return (
    <DataTable
      hooks={hooks}
      selected={selected}
      onToggle={onToggle}
      onConfirm={onConfirm}
      onBack={onBack}
    />
  );
}
