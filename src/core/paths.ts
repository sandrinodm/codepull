import { lstat, realpath, stat } from 'node:fs/promises';
import nodePath from 'node:path';

/**
 * Validates a portable, normalized path that must remain inside a project or
 * repository root.
 */
export function validateRelativePath(value: string, location = 'project'): string | undefined {
  if (value.length === 0) {
    return 'must not be empty';
  }
  if (value.includes('\\')) {
    return 'must use forward slashes';
  }
  if (/^[A-Za-z]:/.test(value)) {
    return 'must not contain a Windows volume prefix';
  }
  if ([...value].some((character) => character.charCodeAt(0) < 0x20)) {
    return 'must not contain control characters';
  }

  const clean = nodePath.posix.normalize(value);
  if (nodePath.posix.isAbsolute(value) || clean === '.' || clean === '..' || clean.startsWith('../')) {
    return `must be a relative path inside the ${location}, got ${JSON.stringify(value)}`;
  }
  if (clean !== value) {
    return `must be normalized, got ${JSON.stringify(value)} (use ${JSON.stringify(clean)})`;
  }
  return undefined;
}

/**
 * Reports whether two normalized consumer-relative destinations are equal or
 * one contains the other. Comparison is case-insensitive on every platform.
 */
export function destinationsOverlap(left: string, right: string): boolean {
  const normalizedLeft = left.toLowerCase().replace(/^\/+|\/+$/g, '');
  const normalizedRight = right.toLowerCase().replace(/^\/+|\/+$/g, '');
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

/**
 * Resolves the real target root by resolving its nearest existing ancestor and
 * appending any path components that do not yet exist.
 */
export async function resolvedTargetRoot(targetDirectory: string): Promise<string> {
  let current = nodePath.resolve(targetDirectory);
  const missing: string[] = [];

  for (;;) {
    try {
      const information = await stat(current);
      if (!information.isDirectory()) {
        throw new Error(`target path ${JSON.stringify(current)} is not a directory`);
      }
      let resolved = await realpath(current);
      for (const part of missing.reverse()) {
        resolved = nodePath.join(resolved, part);
      }
      return resolved;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      const parent = nodePath.dirname(current);
      if (parent === current) {
        throw new Error(`could not resolve target directory ${JSON.stringify(targetDirectory)}`);
      }
      missing.push(nodePath.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves a relative installation destination beneath a real target root and
 * rejects symbolic-link or non-directory parent components.
 */
export async function resolveDestination(targetDirectory: string, relative: string): Promise<string> {
  const validationError = validateRelativePath(relative, 'target directory');
  if (validationError) {
    throw new Error(`destination ${validationError}`);
  }

  const root = await resolvedTargetRoot(targetDirectory);
  const parentParts = nodePath.dirname(nodePath.normalize(relative)).split(nodePath.sep);
  let current = root;

  for (const part of parentParts) {
    if (part === '.' || part === '') {
      continue;
    }
    current = nodePath.join(current, part);
    try {
      const information = await lstat(current);
      if (information.isSymbolicLink()) {
        throw new Error(`destination parent ${JSON.stringify(current)} is a symbolic link`);
      }
      if (!information.isDirectory()) {
        throw new Error(`destination parent ${JSON.stringify(current)} is not a directory`);
      }
    } catch (error) {
      if (isMissing(error)) {
        break;
      }
      throw error;
    }
  }

  return nodePath.join(root, nodePath.normalize(relative));
}

/**
 * Reports whether a Node.js filesystem error means that a path does not exist.
 */
export function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
