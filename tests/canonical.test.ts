import { describe, expect, it } from 'vitest';
import { canonical } from '../src/shared/canonical.js';

describe('canonical JSON', () => {
  it('omits undefined object keys recursively while preserving null and sorted keys', () => {
    const value = {
      z: undefined,
      context: { seed: undefined, question: 'murder', optional: null },
      a: 1,
    };
    expect(canonical(value)).toBe(
      '{"a":1,"context":{"optional":null,"question":"murder"}}',
    );
    expect(canonical(value)).toBe(canonical(JSON.parse(JSON.stringify(value))));
    expect(canonical({ seed: undefined })).toBe(canonical({}));
    expect(canonical({ seed: null })).not.toBe(canonical({}));
  });

  it('represents undefined and missing array entries as null, preserving positions', () => {
    const value = [undefined, , { seed: undefined }, null];
    expect(canonical(value)).toBe('[null,null,{},null]');
    expect(canonical(value)).toBe(canonical(JSON.parse(JSON.stringify(value))));
  });
});
