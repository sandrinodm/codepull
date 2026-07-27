import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTemporaryDirectory, temporaryDirectory } from '../testing/helpers.js';
import {
  destinationsOverlap,
  isMissing,
  resolveDestination,
  resolvedTargetRoot,
  validateRelativePath,
} from './paths.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryDirectory));
});

describe('portable relative paths', () => {
  it('accepts normalized project-relative paths', () => {
    expect(validateRelativePath('apps/consumer/src')).toBeUndefined();
  });

  it.each([
    ['', 'empty'],
    ['apps\\consumer', 'forward slashes'],
    ['C:/consumer', 'Windows volume'],
    ['../consumer', 'relative path inside'],
    ['/consumer', 'relative path inside'],
    ['apps/../consumer', 'normalized'],
    ['apps/\u0001consumer', 'control characters'],
  ])('rejects %j', (value, message) => {
    expect(validateRelativePath(value)).toContain(message);
  });
});

describe('destination ownership', () => {
  it('detects equal, nested, and case-insensitive overlap', () => {
    expect(destinationsOverlap('src', 'src')).toBe(true);
    expect(destinationsOverlap('SRC', 'src/nested')).toBe(true);
    expect(destinationsOverlap('/src/nested/', 'src')).toBe(true);
    expect(destinationsOverlap('src/a', 'src/b')).toBe(false);
  });
});

describe('filesystem destination resolution', () => {
  it('resolves missing target components from the nearest real ancestor', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const target = nodePath.join(root, 'missing', 'consumer');
    const realRoot = await realpath(root);
    const resolvedTarget = nodePath.join(realRoot, 'missing', 'consumer');
    expect(await resolvedTargetRoot(target)).toBe(resolvedTarget);
    expect(await resolveDestination(target, 'src/index.ts')).toBe(nodePath.join(resolvedTarget, 'src', 'index.ts'));
  });

  it('rejects non-directory targets and unsafe parent components', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const fileTarget = nodePath.join(root, 'file');
    await writeFile(fileTarget, 'content');
    await expect(resolvedTargetRoot(fileTarget)).rejects.toThrow('is not a directory');

    await writeFile(nodePath.join(root, 'parent'), 'content');
    await expect(resolveDestination(root, 'parent/file.ts')).rejects.toThrow('is not a directory');

    await mkdir(nodePath.join(root, 'real'));
    await symlink(nodePath.join(root, 'real'), nodePath.join(root, 'linked'));
    await expect(resolveDestination(root, 'linked/file.ts')).rejects.toThrow('is a symbolic link');
  });

  it('rejects invalid relative destinations before filesystem access', async () => {
    await expect(resolveDestination('.', '../outside')).rejects.toThrow('destination must be a relative path');
  });
});

describe('missing-path errors', () => {
  it('recognizes only ENOENT-shaped errors', () => {
    expect(isMissing(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe(true);
    expect(isMissing(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(false);
    expect(isMissing(null)).toBe(false);
  });
});
