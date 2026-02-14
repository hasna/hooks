import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowUpDownIcon,
  ChevronDownIcon,
  CopyIcon,
  CheckIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { HookMeta } from "@/types";

function EventBadge({ event }: { event: HookMeta["event"] }) {
  switch (event) {
    case "PreToolUse":
      return (
        <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300 border-0">
          PreToolUse
        </Badge>
      );
    case "PostToolUse":
      return (
        <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 border-0">
          PostToolUse
        </Badge>
      );
    case "Stop":
      return (
        <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 border-0">
          Stop
        </Badge>
      );
    case "Notification":
      return (
        <Badge className="bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300 border-0">
          Notification
        </Badge>
      );
  }
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = React.useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="flex items-center gap-1">
      <code className="rounded border bg-muted px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground">
        {command}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        onClick={handleCopy}
      >
        {copied ? (
          <CheckIcon className="size-3 text-green-500" />
        ) : (
          <CopyIcon className="size-3" />
        )}
      </Button>
    </div>
  );
}

interface HooksTableProps {
  data: HookMeta[];
}

export function HooksTable({ data }: HooksTableProps) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] =
    React.useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = React.useState({});

  const columns: ColumnDef<HookMeta>[] = React.useMemo(
    () => [
      {
        accessorKey: "displayName",
        header: ({ column }) => (
          <Button
            variant="ghost"
            onClick={() =>
              column.toggleSorting(column.getIsSorted() === "asc")
            }
            className="-ml-3"
          >
            Hook
            <ArrowUpDownIcon />
          </Button>
        ),
        cell: ({ row }) => (
          <div>
            <div className="font-medium">{row.original.displayName}</div>
            <div className="text-xs text-muted-foreground">
              {row.original.name}
              <span className="ml-1.5 opacity-60">
                v{row.original.version}
              </span>
            </div>
          </div>
        ),
      },
      {
        accessorKey: "category",
        header: ({ column }) => (
          <Button
            variant="ghost"
            onClick={() =>
              column.toggleSorting(column.getIsSorted() === "asc")
            }
            className="-ml-3"
          >
            Category
            <ArrowUpDownIcon />
          </Button>
        ),
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.getValue("category")}
          </span>
        ),
      },
      {
        accessorKey: "event",
        header: ({ column }) => (
          <Button
            variant="ghost"
            onClick={() =>
              column.toggleSorting(column.getIsSorted() === "asc")
            }
            className="-ml-3"
          >
            Event
            <ArrowUpDownIcon />
          </Button>
        ),
        cell: ({ row }) => <EventBadge event={row.original.event} />,
      },
      {
        accessorKey: "matcher",
        header: "Matcher",
        cell: ({ row }) => {
          const matcher = row.original.matcher;
          return matcher ? (
            <code className="rounded border bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
              {matcher}
            </code>
          ) : (
            <span className="text-muted-foreground">&mdash;</span>
          );
        },
      },
      {
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground max-w-[300px] truncate block">
            {row.original.description}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <CopyCommand command={`npx @anthropic/hooks install ${row.original.name}`} />
          </div>
        ),
      },
    ],
    []
  );

  const table = useReactTable({
    data,
    columns,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    initialState: {
      pagination: { pageSize: 15 },
    },
    state: {
      sorting,
      columnFilters,
      columnVisibility,
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Filter hooks..."
          value={
            (table.getColumn("displayName")?.getFilterValue() as string) ?? ""
          }
          onChange={(e) =>
            table.getColumn("displayName")?.setFilterValue(e.target.value)
          }
          className="max-w-sm"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="ml-auto">
              Columns <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {table
              .getAllColumns()
              .filter((column) => column.getCanHide())
              .map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  className="capitalize"
                  checked={column.getIsVisible()}
                  onCheckedChange={(value) =>
                    column.toggleVisibility(!!value)
                  }
                >
                  {column.id}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  No hooks found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between">
        <div className="text-muted-foreground text-sm">
          Page {table.getState().pagination.pageIndex + 1} of{" "}
          {table.getPageCount()} ({table.getFilteredRowModel().rows.length}{" "}
          hook{table.getFilteredRowModel().rows.length !== 1 ? "s" : ""})
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
