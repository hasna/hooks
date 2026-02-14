import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { searchHooks, HookMeta } from "../../lib/registry.js";
import { DataTable } from "./DataTable.js";

interface SearchViewProps {
  selected: Set<string>;
  onToggle: (name: string) => void;
  onConfirm: () => void;
  onBack: () => void;
}

export function SearchView({
  selected,
  onToggle,
  onConfirm,
  onBack,
}: SearchViewProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HookMeta[]>([]);
  const [mode, setMode] = useState<"search" | "select">("search");

  useEffect(() => {
    if (query.length >= 2) {
      setResults(searchHooks(query));
    } else {
      setResults([]);
    }
  }, [query]);

  useInput((input, key) => {
    if (key.escape) {
      if (mode === "select") {
        setMode("search");
      } else {
        onBack();
      }
    }
    if (key.downArrow && mode === "search" && results.length > 0) {
      setMode("select");
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Search: </Text>
        {mode === "search" && (
          <TextInput
            value={query}
            onChange={setQuery}
            placeholder="Type to search hooks..."
          />
        )}
        {mode === "select" && (
          <Text>{query}</Text>
        )}
      </Box>

      {query.length < 2 && (
        <Text dimColor>Type at least 2 characters to search</Text>
      )}

      {query.length >= 2 && results.length === 0 && (
        <Text dimColor>No hooks found for "{query}"</Text>
      )}

      {results.length > 0 && mode === "search" && (
        <Text dimColor>
          Found {results.length} hook(s) — press down arrow to browse results
        </Text>
      )}

      {results.length > 0 && mode === "select" && (
        <DataTable
          hooks={results}
          selected={selected}
          onToggle={onToggle}
          onConfirm={onConfirm}
          onBack={() => setMode("search")}
        />
      )}
    </Box>
  );
}
