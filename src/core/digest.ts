import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import nodePath from 'node:path';

/**
 * Filesystem entry kinds supported by tracked package mappings.
 */
export type MappingKind = 'file' | 'directory';

/**
 * Computes the canonical Codepull digest for one managed file or directory.
 */
export async function digestPath(path: string, kind: MappingKind): Promise<string> {
  const hash = createHash('sha256');
  if (kind === 'file') {
    await hashFile(hash, path);
  } else {
    await hashDirectory(hash, path);
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Adds a length-prefixed regular file to a hash.
 */
async function hashFile(hash: Hash, path: string): Promise<void> {
  const information = await lstat(path);
  if (information.isSymbolicLink() || !information.isFile()) {
    throw new Error(`expected a regular file at ${JSON.stringify(path)}`);
  }
  hash.update(uint64(information.size));
  const input = createReadStream(path);
  for await (const chunk of input) {
    hash.update(chunk as Buffer);
  }
}

/**
 * Adds every directory entry to a hash in lexical, portable-path order.
 */
async function hashDirectory(hash: Hash, root: string): Promise<void> {
  const information = await lstat(root);
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new Error(`expected a directory at ${JSON.stringify(root)}`);
  }

  const entries: Array<{ relative: string; kind: MappingKind }> = [];
  await collectEntries(root, '', entries);
  entries.sort((left, right) => left.relative.localeCompare(right.relative));

  for (const entry of entries) {
    hash.update(entry.kind === 'directory' ? 'd' : 'f');
    const encodedPath = Buffer.from(entry.relative, 'utf8');
    hash.update(uint64(encodedPath.length));
    hash.update(encodedPath);
    if (entry.kind === 'file') {
      await hashFile(hash, nodePath.join(root, ...entry.relative.split('/')));
    }
  }
}

/**
 * Recursively gathers regular files and directories while rejecting links and
 * special entries.
 */
async function collectEntries(
  root: string,
  relativeRoot: string,
  entries: Array<{ relative: string; kind: MappingKind }>
): Promise<void> {
  const directory = await opendir(relativeRoot === '' ? root : nodePath.join(root, ...relativeRoot.split('/')));
  for await (const entry of directory) {
    const relative = relativeRoot === '' ? entry.name : `${relativeRoot}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(`symbolic link at ${JSON.stringify(nodePath.join(root, ...relative.split('/')))}`);
    }
    if (entry.isDirectory()) {
      entries.push({ relative, kind: 'directory' });
      await collectEntries(root, relative, entries);
    } else if (entry.isFile()) {
      entries.push({ relative, kind: 'file' });
    } else {
      throw new Error(`unsupported filesystem entry at ${JSON.stringify(nodePath.join(root, ...relative.split('/')))}`);
    }
  }
}

/**
 * Encodes a non-negative integer as an unsigned, big-endian 64-bit value.
 */
function uint64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}
