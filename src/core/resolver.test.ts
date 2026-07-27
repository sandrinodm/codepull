import { describe, expect, it } from 'vitest';
import { parseManifest } from './manifest.js';
import { resolvePackages } from './resolver.js';

describe('dependency resolution', () => {
  const manifest = parseManifest(`{
    "packages": {
      "web": {"path":"web","dependencies":["logger","env"]},
      "logger": {"path":"logger","dependencies":["env"]},
      "env": {"path":"env"},
      "alpha": {"path":"alpha"}
    }
  }`);

  it('orders dependencies first with alphabetical tie-breaking', () => {
    expect(resolvePackages(manifest, ['web', 'alpha'])).toEqual(['alpha', 'env', 'logger', 'web']);
  });

  it('rejects empty and missing requests', () => {
    expect(() => resolvePackages(manifest, [])).toThrow('at least one');
    expect(() => resolvePackages(manifest, ['missing'])).toThrow('does not exist');
  });

  it('detects dependency cycles', () => {
    const cyclic = parseManifest(
      '{"packages":{"a":{"path":"a","dependencies":["b"]},"b":{"path":"b","dependencies":["a"]}}}'
    );
    expect(() => resolvePackages(cyclic, ['a'])).toThrow('circular dependency');
  });
});
