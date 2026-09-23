/**
 * Canonical JSON (JCS-style, RFC 8785 subset): keys sorted by UTF-16 code units,
 * no whitespace, numbers must be finite; we only use integers, strings, booleans, null.
 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function canonicalize(v: Json): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean": return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new Error("non-finite number in bundle");
      return JSON.stringify(v);
    case "string": return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k]!)}`).join(",")}}`;
}
