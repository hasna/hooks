import { useState } from "react";
import { DownloadIcon, RefreshCwIcon, CheckIcon } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { StatsCards } from "@/components/stats-cards";
import { HooksTable } from "@/components/hooks-table";
import { Button } from "@/components/ui/button";
import { HOOKS } from "@/data";

function CopyButton({
  label,
  command,
  icon: Icon,
}: {
  label: string;
  command: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={handleCopy} className="gap-1.5 text-xs">
      {copied ? (
        <CheckIcon className="size-3.5 text-green-500" />
      ) : (
        <Icon className="size-3.5" />
      )}
      {copied ? "Copied!" : label}
    </Button>
  );
}

export function App() {
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <img
              src="/logo.jpg"
              alt="Hasna"
              className="h-7 w-auto rounded"
            />
            <h1 className="text-base font-semibold">
              Hasna{" "}
              <span className="font-normal text-muted-foreground">
                Hooks
              </span>
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <CopyButton
              label="Install All"
              command="npx @hasna/hooks install --all"
              icon={DownloadIcon}
            />
            <CopyButton
              label="Update"
              command="bun install -g @hasna/hooks@latest"
              icon={RefreshCwIcon}
            />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-6">
        <StatsCards hooks={HOOKS} />
        <HooksTable data={HOOKS} />
      </main>
    </div>
  );
}
