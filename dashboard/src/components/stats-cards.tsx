import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { BlocksIcon, FolderOpenIcon, ShieldIcon, ActivityIcon } from "lucide-react";
import type { HookMeta } from "@/types";

interface StatsCardsProps {
  hooks: HookMeta[];
}

export function StatsCards({ hooks }: StatsCardsProps) {
  const total = hooks.length;
  const categories = new Set(hooks.map((h) => h.category)).size;
  const preToolUse = hooks.filter((h) => h.event === "PreToolUse").length;
  const postToolUse = hooks.filter((h) => h.event === "PostToolUse").length;

  return (
    <div className="grid gap-4 md:grid-cols-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <BlocksIcon className="size-4" />
            Total Hooks
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{total}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <FolderOpenIcon className="size-4" />
            Categories
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{categories}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <ShieldIcon className="size-4" />
            Pre-Tool Guards
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">
            {preToolUse}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <ActivityIcon className="size-4" />
            Post-Tool Checks
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold text-green-600 dark:text-green-400">
            {postToolUse}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
