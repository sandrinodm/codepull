import { mkdir, readFile, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTemporaryDirectory, temporaryDirectory } from '../testing/helpers.js';
import { initializeManifest } from './initializer.js';
import { MANIFEST_FILENAME, parseManifest } from './manifest.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryDirectory));
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await temporaryDirectory();
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const filename = nodePath.join(root, ...relative.split('/'));
    await mkdir(nodePath.dirname(filename), { recursive: true });
    await writeFile(filename, contents);
  }
  return root;
}

describe('manifest initialization', () => {
  it('discovers npm metadata and keeps only local dependencies', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'acme-system', description: 'Shared source packages' }),
      'packages/logger/package.json': JSON.stringify({
        name: '@acme/logger',
        description: 'Structured logging',
        dependencies: {
          '@acme/env': 'workspace:*',
          chalk: '^5.0.0',
        },
      }),
      'packages/env/package.json': JSON.stringify({ name: '@acme/env' }),
      'packages/not-a-package/README.md': 'ignored',
      'packages/README.md': 'ignored',
    });

    const result = await initializeManifest(root, { force: false, dryRun: false });

    expect(result.destination).toBe(nodePath.join(root, MANIFEST_FILENAME));
    expect(result.manifest).toEqual({
      name: 'acme-system',
      description: 'Shared source packages',
      packages: {
        '@acme/env': {
          path: 'packages/env',
          target: 'packages/@acme/env',
        },
        '@acme/logger': {
          description: 'Structured logging',
          path: 'packages/logger',
          target: 'packages/@acme/logger',
          dependencies: ['@acme/env'],
        },
      },
    });
    expect(parseManifest(await readFile(nodePath.join(root, MANIFEST_FILENAME), 'utf8'))).toEqual(result.manifest);
    expect(result.content.endsWith('\n')).toBe(true);
  });

  it('supports dry runs and forcefully replacing an existing manifest', async () => {
    const root = await fixture({
      'packages/env/package.json': JSON.stringify({ name: 'env' }),
      [MANIFEST_FILENAME]: '{"old":true}\n',
    });

    await expect(initializeManifest(root, { force: false, dryRun: false })).rejects.toThrow(
      'already exists; pass --force'
    );

    const preview = await initializeManifest(root, { force: true, dryRun: true });
    expect(preview.manifest.packages.env?.target).toBe('packages/env');
    expect(await readFile(nodePath.join(root, MANIFEST_FILENAME), 'utf8')).toBe('{"old":true}\n');

    await initializeManifest(root, { force: true, dryRun: false });
    expect(parseManifest(await readFile(nodePath.join(root, MANIFEST_FILENAME), 'utf8')).packages.env).toBeDefined();
  });

  it('reports missing and empty package catalogues', async () => {
    const missing = await fixture({});
    await expect(initializeManifest(missing, { force: false, dryRun: false })).rejects.toThrow(
      'packages directory does not exist'
    );

    const empty = await fixture({ 'packages/README.md': 'nothing here' });
    await expect(initializeManifest(empty, { force: false, dryRun: false })).rejects.toThrow(
      'no package.json files found'
    );
  });

  it('rejects duplicate, malformed, and incomplete package metadata', async () => {
    const duplicate = await fixture({
      'packages/one/package.json': '{"name":"same"}',
      'packages/two/package.json': '{"name":"same"}',
    });
    await expect(initializeManifest(duplicate, { force: false, dryRun: false })).rejects.toThrow(
      'duplicate npm package name "same"'
    );

    const malformed = await fixture({ 'packages/one/package.json': '{' });
    await expect(initializeManifest(malformed, { force: false, dryRun: false })).rejects.toThrow('could not parse');

    const missingName = await fixture({ 'packages/one/package.json': '{}' });
    await expect(initializeManifest(missingName, { force: false, dryRun: false })).rejects.toThrow('needs a name');

    const badDescription = await fixture({
      'packages/one/package.json': '{"name":"one","description":false}',
    });
    await expect(initializeManifest(badDescription, { force: false, dryRun: false })).rejects.toThrow(
      'invalid description'
    );

    const badDependencies = await fixture({
      'packages/one/package.json': '{"name":"one","dependencies":[]}',
    });
    await expect(initializeManifest(badDependencies, { force: false, dryRun: false })).rejects.toThrow(
      'invalid dependencies'
    );
  });
});
