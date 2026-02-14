import { ThemeToggle } from "@/components/theme-toggle";
import { StatsCards } from "@/components/stats-cards";
import { HooksTable } from "@/components/hooks-table";
import { HOOKS } from "@/data";

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
          <ThemeToggle />
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
