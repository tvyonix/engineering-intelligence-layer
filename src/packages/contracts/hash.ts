import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization: object keys sorted recursively, no
 * whitespace. Used for stable contract hashing — the same logical contract
 * must produce the same hash regardless of YAML key order.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) {
      throw new Error(`canonicalJson: non-finite or negative-zero number: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => serialize(item));
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Stable contract hash: `sha256:<hex of canonical JSON>`. */
export function hashTaskContract(contract: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(contract))}`;
}
