/**
 * Central time helpers: everything is normalized to ISO 8601 UTC strings
 * (`YYYY-MM-DDTHH:mm:ss.sssZ`) at the API boundary, while all internal
 * comparisons happen on epoch milliseconds.
 */

export interface HistoryRange {
  fromMs: number;
  toMs: number;
}

const MAX_TZ_OFFSET_MINUTES = 14 * 60; // UTC+14 is the maximum real-world offset

export function nowIso(): string {
  return new Date().toISOString();
}

export function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function isoToMs(iso: string): number {
  return Date.parse(iso);
}

function normalizeEpochMs(value: number): number {
  // Epoch seconds (|v| < 1e11 -> years up to ~5138) are converted to milliseconds
  return Math.abs(value) < 1e11 ? value * 1000 : value;
}

/**
 * Accepts epoch seconds, epoch milliseconds or an ISO 8601 string
 * (numeric strings are treated as epoch timestamps) and returns epoch
 * milliseconds. Returns NaN for values that cannot be interpreted.
 */
export function parseFlexibleTimestamp(value: number | string): number {
  if (typeof value === 'number') {
    return normalizeEpochMs(value);
  }
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return normalizeEpochMs(Number(trimmed));
  }
  return Date.parse(trimmed);
}

/** Coerces unknown stored values (ISO string | epoch | undefined) to ISO 8601. */
export function toIsoString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const ms = Number(value ?? 0);
  return Number.isFinite(ms) ? msToIso(ms) : msToIso(0);
}

/**
 * Parses a client timezone offset into minutes east of UTC.
 * Supported: `+07:00`, `-0530`, `+07`, `Z`/`UTC`, or plain minutes (`420`).
 * Returns null for anything invalid or out of the UTC-12..UTC+14 range.
 */
export function parseTzOffsetMinutes(tz: string): number | null {
  const trimmed = tz.trim();
  let offset: number | null = null;

  if (/^[+-]\d{2}:\d{2}$/.test(trimmed) || /^[+-]\d{4}$/.test(trimmed)) {
    const sign = trimmed[0] === '-' ? -1 : 1;
    const digits = trimmed.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2, 4));
    if (minutes > 59) return null;
    offset = sign * (hours * 60 + minutes);
  } else if (/^[+-]\d{1,2}$/.test(trimmed)) {
    const sign = trimmed[0] === '-' ? -1 : 1;
    offset = sign * Number(trimmed.slice(1)) * 60;
  } else if (/^-?\d+$/.test(trimmed)) {
    offset = Number(trimmed);
  } else if (trimmed === 'Z' || trimmed.toUpperCase() === 'UTC') {
    offset = 0;
  }

  if (offset === null || Math.abs(offset) > MAX_TZ_OFFSET_MINUTES) {
    return null;
  }
  return offset;
}

/** [start, end] (inclusive, ms) of the YYYY-MM-DD day shifted by offsetMinutes. */
export function dayRange(dateStr: string, offsetMinutes = 0): HistoryRange | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null;
  }
  const [year, month, day] = dateStr.split('-').map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(utcMidnight) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const fromMs = utcMidnight - offsetMinutes * 60_000;
  return { fromMs, toMs: fromMs + 24 * 3600_000 - 1 };
}
