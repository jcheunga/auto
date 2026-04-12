export interface ColumnRoutingRule {
  column: string;
  match?: string;
  repoHint?: string;
  baseBranchHint?: string;
  branchHint?: string;
}

export interface RoutingDirectives {
  repoHint?: string;
  baseBranchHint?: string;
  branchHint?: string;
  columnRoutes?: ColumnRoutingRule[];
}

export function parseRoutingDirectives(source: string | null | undefined): RoutingDirectives {
  const result: RoutingDirectives = {};
  if (!source) {
    return result;
  }

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const columnRouteMatch = line.match(/^@?(?:column-route|column-route:)\s+(.+?)\s*=>\s*(.+)$/i);
    if (columnRouteMatch?.[1] && columnRouteMatch[2]) {
      const rule = parseColumnRoute(columnRouteMatch[1], columnRouteMatch[2]);
      if (rule) {
        result.columnRoutes = [...(result.columnRoutes ?? []), rule];
      }
      continue;
    }

    const repoMatch = line.match(/^(?:@repo|repo:)\s+(.+)$/i);
    if (repoMatch?.[1]) {
      result.repoHint = repoMatch[1].trim();
      continue;
    }

    const baseMatch = line.match(/^(?:@base|base:)\s+(.+)$/i);
    if (baseMatch?.[1]) {
      result.baseBranchHint = baseMatch[1].trim();
      continue;
    }

    const branchMatch = line.match(/^(?:@branch|branch:)\s+(.+)$/i);
    if (branchMatch?.[1]) {
      result.branchHint = branchMatch[1].trim();
    }
  }

  return result;
}

export function mergeRoutingDirectives(...sources: Array<RoutingDirectives | undefined>): RoutingDirectives {
  const merged: RoutingDirectives = {};
  for (const source of sources) {
    if (!source) {
      continue;
    }
    if (source.repoHint) {
      merged.repoHint = source.repoHint;
    }
    if (source.baseBranchHint) {
      merged.baseBranchHint = source.baseBranchHint;
    }
    if (source.branchHint) {
      merged.branchHint = source.branchHint;
    }
    if (source.columnRoutes?.length) {
      merged.columnRoutes = [...(merged.columnRoutes ?? []), ...source.columnRoutes];
    }
  }
  return merged;
}

export function resolveColumnRouting(
  routing: RoutingDirectives | undefined,
  columns: Array<{ id: string; title: string | null; text: string | null }>,
  context?: { statusLabel?: string | null }
): RoutingDirectives {
  const resolved: RoutingDirectives = {};
  const rules = routing?.columnRoutes ?? [];
  const statusLabel = normalizeValue(context?.statusLabel);

  for (const rule of rules) {
    const selectedColumn = columns.find((column) => columnMatchesSelector(column, rule.column));
    const selectedValue = normalizeValue(selectedColumn?.text);
    const isStatusSelector = normalizeValue(rule.column) === "status";
    const valueToCompare = selectedValue || (isStatusSelector ? statusLabel : "");

    if (rule.match) {
      const expected = normalizeValue(rule.match);
      if (!valueToCompare || valueToCompare !== expected) {
        continue;
      }
    } else if (!selectedColumn && !isStatusSelector) {
      continue;
    }

    if (rule.repoHint) {
      resolved.repoHint = rule.repoHint;
    }
    if (rule.baseBranchHint) {
      resolved.baseBranchHint = rule.baseBranchHint;
    }
    if (rule.branchHint) {
      resolved.branchHint = rule.branchHint;
    }
  }

  return resolved;
}

export function stripRoutingDirectives(source: string): string {
  const stripped = source
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*(?:@repo|repo:|@base|base:|@branch|branch:|@column-route|column-route:)\s+/i.test(line)
    )
    .join("\n")
    .trim();

  return stripped || source.trim();
}

export function parseRepoHint(repoHint: string | undefined): { owner: string; repo: string } | null {
  if (!repoHint) {
    return null;
  }

  const match = repoHint.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2]
  };
}

export function deriveSuggestedBranch(input: {
  title: string;
  itemId: string;
  boardName?: string | null;
  repoHint?: string | null;
}): string {
  const boardSegment = slugifySegment(input.boardName || "task");
  const titleSegment = slugifySegment(input.title);
  const repoSegment = slugifySegment(input.repoHint?.split("/").at(-1) || "item");
  const itemSegment = input.itemId.replace(/[^A-Za-z0-9]+/g, "").slice(-6).toLowerCase() || "task";

  const candidate = ["monday", boardSegment, repoSegment, titleSegment, itemSegment]
    .filter(Boolean)
    .join("-");

  return candidate.slice(0, 72).replace(/-+$/g, "").replace(/^-+/, "") || `monday-${itemSegment}`;
}

function parseColumnRoute(selector: string, target: string): ColumnRoutingRule | null {
  const selectorParts = selector.split(/\s*[:=]\s*/).filter(Boolean);
  if (selectorParts.length === 0) {
    return null;
  }

  const column = selectorParts[0]?.trim();
  const match = selectorParts[1]?.trim();
  if (!column) {
    return null;
  }

  const targetDirectives = parseRoutingTarget(target);
  return {
    column,
    match,
    ...targetDirectives
  };
}

function parseRoutingTarget(target: string): Pick<RoutingDirectives, "repoHint" | "baseBranchHint" | "branchHint"> {
  const normalized = target
    .replace(/;/g, "\n")
    .replace(/\s+@/g, "\n@")
    .replace(/\s+repo:/gi, "\nrepo:")
    .replace(/\s+base:/gi, "\nbase:")
    .replace(/\s+branch:/gi, "\nbranch:");

  return parseRoutingDirectives(normalized);
}

function columnMatchesSelector(
  column: { id: string; title: string | null; text: string | null },
  selector: string
): boolean {
  const normalizedSelector = normalizeValue(selector);
  return (
    normalizeValue(column.id) === normalizedSelector ||
    normalizeValue(column.title ?? "") === normalizedSelector
  );
}

function normalizeValue(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function slugifySegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 24);
}
