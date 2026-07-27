import { mkdir, symlink, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTemporaryDirectory, temporaryDirectory } from '../testing/helpers.js';
import { digestPath } from './digest.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryDirectory));
});

describe('canonical digests', () => {
  it('hashes files and directory structure deterministically', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await mkdir(nodePath.join(root, 'tree', 'empty'), { recursive: true });
    await writeFile(nodePath.join(root, 'tree', 'a.txt'), 'hello');
    const fileDigest = await digestPath(nodePath.join(root, 'tree', 'a.txt'), 'file');
    const directoryDigest = await digestPath(nodePath.join(root, 'tree'), 'directory');
    expect(fileDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(directoryDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(directoryDigest).not.toBe(fileDigest);
    expect(await digestPath(nodePath.join(root, 'tree'), 'directory')).toBe(directoryDigest);
  });

  it('rejects the wrong entry kind and symbolic links', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await writeFile(nodePath.join(root, 'file'), 'x');
    await mkdir(nodePath.join(root, 'directory'));
    expect(digestPath(nodePath.join(root, 'file'), 'directory')).rejects.toThrow('expected a directory');
    expect(digestPath(nodePath.join(root, 'directory'), 'file')).rejects.toThrow('expected a regular file');
    await symlink(nodePath.join(root, 'file'), nodePath.join(root, 'directory', 'link'));
    expect(digestPath(nodePath.join(root, 'directory'), 'directory')).rejects.toThrow('symbolic link');
  });
});
