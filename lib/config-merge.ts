/** Pure recursive config merge/diff utilities for SherpaConfig handling. */

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeConfig<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (!isPlainObject(over)) return structuredClone(base);
  const baseRecord = isPlainObject(base) ? base : {};
  const out: Record<string, unknown> = Array.isArray(base) ? [...base] : { ...baseRecord };
  for (const [key, value] of Object.entries(over)) {
    const baseValue = baseRecord[key];
    out[key] = isPlainObject(value) ? mergeConfig(baseValue ?? {}, value) : value;
  }
  return out as T;
}

export function configDiff(base: unknown, value: unknown): unknown | undefined {
  if (isPlainObject(base) && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, childValue] of Object.entries(value)) {
      const diff = configDiff(base[key], childValue);
      if (diff !== undefined) out[key] = diff;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return JSON.stringify(base) === JSON.stringify(value) ? undefined : value;
}

export function todayIsoDate() { return new Date().toISOString().slice(0, 10); }
