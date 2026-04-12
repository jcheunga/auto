export interface RoutingDirectives {
  repoHint?: string;
  baseBranchHint?: string;
  branchHint?: string;
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
  }
  return merged;
}

export function stripRoutingDirectives(source: string): string {
  const stripped = source
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:@repo|repo:|@base|base:|@branch|branch:)\s+/i.test(line))
    .join('\n')
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
  const boardSegment = slugifySegment(input.boardName || 'task');
  const titleSegment = slugifySegment(input.title);
  const repoSegment = slugifySegment(input.repoHint?.split('/').at(-1) || 'item');
  const itemSegment = input.itemId.replace(/[^A-Za-z0-9]+/g, '').slice(-6).toLowerCase() || 'task';

  const candidate = ['monday', boardSegment, repoSegment, titleSegment, itemSegment]
    .filter(Boolean)
    .join('-');

  return candidate.slice(0, 72).replace(/-+$/g, '').replace(/^-+/, '') || `monday-${itemSegment}`;
}

function slugifySegment(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 24);
}
