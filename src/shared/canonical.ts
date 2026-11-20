/** Serialize JSON values with stable object-key ordering. */
export function canonical(value: unknown): string {
  if (Array.isArray(value))
    return (
      '[' +
      Array.from(value, (entry) => canonical(entry) ?? 'null').join(',') +
      ']'
    );
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => JSON.stringify(key) + ':' + canonical(entry))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}
