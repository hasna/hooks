import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import { Header } from "./Header.js";
import { CategorySelect } from "./CategorySelect.js";
import { HookSelect } from "./HookSelect.js";
import { SearchView } from "./SearchView.js";
import { InstallProgress } from "./InstallProgress.js";
import {
  getHooksByCategory,
  HookMeta,
  Category,
} from "../../lib/registry.js";
import { InstallResult } from "../../lib/installer.js";

type View = "main" | "browse" | "search" | "hooks" | "installing" | "done";

interface AppProps {
  initialHooks?: string[];
  overwrite?: boolean;
}

export function App({ initialHooks, overwrite = false }: AppProps) {
  const { exit } = useApp();
  const [view, setView] = useState<View>(
    initialHooks?.length ? "installing" : "main"
  );
  const [category, setCategory] = useState<Category | null>(null);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initialHooks || [])
  );
  const [results, setResults] = useState<InstallResult[]>([]);

  useInput((input, key) => {
    if (key.escape) {
      if (view === "main") {
        exit();
      }
    }
    if (input === "q") {
      exit();
    }
  });

  const handleToggle = (name: string) => {
    const newSelected = new Set(selected);
    if (newSelected.has(name)) {
      newSelected.delete(name);
    } else {
      newSelected.add(name);
    }
    setSelected(newSelected);
  };

  const handleConfirm = () => {
    if (selected.size > 0) {
      setView("installing");
    }
  };

  const handleComplete = (installResults: InstallResult[]) => {
    setResults(installResults);
    setView("done");
  };

  const mainMenuItems = [
    { label: "Browse by category", value: "browse" },
    { label: "Search hooks", value: "search" },
    { label: "Exit", value: "exit" },
  ];

  const handleMainSelect = (item: { value: string }) => {
    if (item.value === "exit") {
      exit();
    } else {
      setView(item.value as View);
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Header
        title="Hooks"
        subtitle="Install Claude Code hooks for your project"
      />

      {view === "main" && (
        <Box flexDirection="column">
          <Text marginBottom={1}>What would you like to do?</Text>
          <SelectInput items={mainMenuItems} onSelect={handleMainSelect} />
          <Box marginTop={1}>
            <Text dimColor>Press q to quit</Text>
          </Box>
        </Box>
      )}

      {view === "browse" && !category && (
        <CategorySelect
          onSelect={(cat) => {
            setCategory(cat as Category);
            setView("hooks");
          }}
          onBack={() => setView("main")}
        />
      )}

      {view === "hooks" && category && (
        <HookSelect
          hooks={getHooksByCategory(category)}
          selected={selected}
          onToggle={handleToggle}
          onConfirm={handleConfirm}
          onBack={() => {
            setCategory(null);
            setView("browse");
          }}
        />
      )}

      {view === "search" && (
        <SearchView
          selected={selected}
          onToggle={handleToggle}
          onConfirm={handleConfirm}
          onBack={() => setView("main")}
        />
      )}

      {view === "installing" && (
        <InstallProgress
          hooks={Array.from(selected)}
          overwrite={overwrite}
          onComplete={handleComplete}
        />
      )}

      {view === "done" && (
        <Box flexDirection="column">
          <Text bold color="green" marginBottom={1}>
            Installation complete!
          </Text>

          {results.filter((r) => r.success).length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold>Installed:</Text>
              {results
                .filter((r) => r.success)
                .map((r) => (
                  <Text key={r.hook} color="green">
                    {"\u2713"} {r.hook}
                  </Text>
                ))}
            </Box>
          )}

          {results.filter((r) => !r.success).length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold color="red">
                Failed:
              </Text>
              {results
                .filter((r) => !r.success)
                .map((r) => (
                  <Text key={r.hook} color="red">
                    {"\u2717"} {r.hook}: {r.error}
                  </Text>
                ))}
            </Box>
          )}

          <Box marginTop={1} flexDirection="column">
            <Text bold>What happened:</Text>
            <Text>1. Hook source copied to .hooks/</Text>
            <Text>2. Hook registered in ~/.claude/settings.json</Text>
            <Text>3. Ready to use in Claude Code sessions</Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text bold>Next steps:</Text>
            <Text dimColor>  hooks list --registered  Check active hooks</Text>
            <Text dimColor>  hooks info {"<name>"}       View hook details</Text>
          </Box>

          <Box marginTop={1}>
            <Text dimColor>Press q to exit</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
