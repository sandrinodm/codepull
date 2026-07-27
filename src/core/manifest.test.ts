import { describe, expect, it } from 'vitest';
import { parseManifest } from './manifest.js';

describe('manifest parsing', () => {
  it('accepts directory and file packages', () => {
    const manifest = parseManifest(`{
      "name": "shared",
      "packages": {
        "app": {"path": "packages/app", "target": "src/app", "dependencies": ["env"]},
        "env": {"files": [{"src": "config/env.ts", "dest": "src/env.ts"}]}
      }
    }`);
    expect(manifest.packages.app?.path).toBe('packages/app');
    expect(manifest.packages.env?.files?.[0]?.dest).toBe('src/env.ts');
  });

  it.each([
    ['invalid JSON', '{'],
    ['empty catalogue', '{"packages":{}}'],
    ['unknown field', '{"packages":{"a":{"path":"a","extra":true}}}'],
    ['missing mode', '{"packages":{"a":{}}}'],
    ['both modes', '{"packages":{"a":{"path":"a","files":[{"src":"a","dest":"a"}]}}}'],
    ['target with files', '{"packages":{"a":{"target":"x","files":[{"src":"a","dest":"a"}]}}}'],
    ['unknown dependency', '{"packages":{"a":{"path":"a","dependencies":["b"]}}}'],
    ['duplicate dependency', '{"packages":{"a":{"path":"a","dependencies":["a","a"]}}}'],
    ['backslash', '{"packages":{"a":{"path":"a\\\\b"}}}'],
    ['traversal', '{"packages":{"a":{"path":"../a"}}}'],
    ['absolute', '{"packages":{"a":{"path":"/a"}}}'],
    ['volume', '{"packages":{"a":{"path":"C:/a"}}}'],
    ['unnormalized', '{"packages":{"a":{"path":"a/../b"}}}'],
    ['control', '{"packages":{"a":{"path":"a\\u0001b"}}}'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseManifest(input)).toThrow();
  });
});
