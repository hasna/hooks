import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { installHook, InstallResult } from "../../lib/installer.js";
import { getHook } from "../../lib/registry.js";

interface InstallProgressProps {
  hooks: string[];
  overwrite?: boolean;
  onComplete: (results: InstallResult[]) => void;
}

export function InstallProgress({
  hooks,
  overwrite = false,
  onComplete,
}: InstallProgressProps) {
  const [results, setResults] = useState<InstallResult[]>([]);
  const [current, setCurrent] = useState(0);
  const [installing, setInstalling] = useState(true);

  useEffect(() => {
    const install = async () => {
      const newResults: InstallResult[] = [];

      for (let i = 0; i < hooks.length; i++) {
        setCurrent(i);
        await new Promise((r) => setTimeout(r, 100));

        const result = installHook(hooks[i], { overwrite });
        newResults.push(result);
        setResults([...newResults]);
      }

      setInstalling(false);
      onComplete(newResults);
    };

    install();
  }, [hooks, overwrite]);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>
          {installing
            ? `Installing hooks (${current + 1}/${hooks.length})...`
            : "Installation complete!"}
        </Text>
      </Box>

      {hooks.map((name, i) => {
        const result = results[i];
        const isCurrent = i === current && installing;
        const meta = getHook(name);

        return (
          <Box key={name} flexDirection="column">
            {isCurrent && !result && (
              <Text color="cyan">
                <Spinner type="dots" /> {name}
              </Text>
            )}
            {result?.success && (
              <Box flexDirection="column">
                <Text color="green">{"\u2713"} {name}</Text>
                {meta && (
                  <Text dimColor>
                    {"  "}{meta.event}{meta.matcher ? ` [${meta.matcher}]` : ""}
                  </Text>
                )}
              </Box>
            )}
            {result && !result.success && (
              <Text color="red">
                {"\u2717"} {name} - {result.error}
              </Text>
            )}
            {!isCurrent && !result && (
              <Text dimColor>{"\u25CB"} {name}</Text>
            )}
          </Box>
        );
      })}

      {!installing && (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color="green">
              {results.filter((r) => r.success).length} installed
            </Text>
            {results.some((r) => !r.success) && (
              <Text color="red">
                , {results.filter((r) => !r.success).length} failed
              </Text>
            )}
          </Text>
          <Text dimColor>
            Hooks installed to .hooks/ and registered in ~/.claude/settings.json
          </Text>
        </Box>
      )}
    </Box>
  );
}
