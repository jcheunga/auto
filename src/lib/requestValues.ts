export function parseLimit(input: unknown, defaultLimit = 100, maxLimit = 500): number {
  const raw = Array.isArray(input) ? input[0] : input;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultLimit;
  }
  return Math.min(maxLimit, Math.floor(parsed));
}

export function parseStatusValue(value: unknown): string | null {
  const normalized = parseNullableString(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }

  const allowed = new Set([
    "new",
    "processing",
    "pr_open",
    "ready_to_merge",
    "awaiting_changes",
    "error"
  ]);

  return allowed.has(normalized) ? normalized : null;
}

export function parseNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const text = Array.isArray(value) ? String(value[0] ?? "") : String(value);
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseNullableInteger(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return undefined;
  }

  return parsed;
}

export function parseBoolean(value: unknown): boolean | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return Boolean(raw);
}
