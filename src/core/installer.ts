import { lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import nodePath from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { RepositorySession } from './git.js';
import type { Manifest } from './manifest.js';
import { isMissing, resolveDestination, resolvedTargetRoot } from './paths.js';

/**
 * Existing destination that requires explicit replacement authorization.
 */
export interface Conflict {
  /**
   * Absolute path of the conflicting destination.
   */
  path: string;

  /**
   * Whether replacement removes a complete directory tree.
   */
  isDirectory: boolean;
}

/**
 * Dependencies and policies used by one transactional installation.
 */
export interface InstallerOptions {
  /**
   * Repository session that supplies staged package content.
   */
  fetcher: RepositorySession;

  /**
   * Root beneath which package destinations are resolved.
   */
  targetDirectory: string;

  /**
   * Whether every existing destination may be replaced.
   */
  force?: boolean;

  /**
   * Whether to validate and report the plan without writing files.
   */
  dryRun?: boolean;

  /**
   * Whether to emit every source-to-destination mapping.
   */
  verbose?: boolean;

  /**
   * Whether destination conflicts must fail instead of prompting.
   */
  noPrompt?: boolean;

  /**
   * Normalized destinations already owned by the active lockfile source.
   */
  managed?: ReadonlySet<string>;

  /**
   * Stream used for progress and completion messages.
   */
  output?: NodeJS.WritableStream;

  /**
   * Optional conflict authorization adapter.
   */
  confirm?: (conflict: Conflict) => Promise<boolean>;

  /**
   * Commits provenance while destination backups remain available.
   */
  commit?: () => Promise<void>;

  /**
   * Revalidates caller-owned state after staging and before activation.
   */
  preActivate?: () => Promise<void>;

  /**
   * Verb used in the completion message.
   */
  successVerb?: string;

  /**
   * Signal used to cancel repository reads and staged activation.
   */
  signal?: AbortSignal;
}

/**
 * Mutable state for one source-to-destination operation in a transaction.
 */
interface InstallOperation {
  /**
   * Manifest package that owns the mapping.
   */
  packageName: string;

  /**
   * Repository-relative source path.
   */
  source: string;

  /**
   * Portable destination relative to the configured target root.
   */
  relativeDestination: string;

  /**
   * Absolute installation destination.
   */
  destination: string;

  /**
   * Whether the mapping replaces a complete directory.
   */
  isDirectory: boolean;

  /**
   * Path containing fetched content before activation.
   */
  staged: string;

  /**
   * Path retaining prior content during activation.
   */
  backup: string;

  /**
   * Whether activation moved existing content into the backup.
   */
  hadExisting: boolean;

  /**
   * Whether staged content has replaced the destination.
   */
  activated: boolean;

  /**
   * Whether the destination existed when replacement was authorized.
   */
  expectedExisting: boolean;

  /**
   * Whether activation reserved a previously absent destination.
   */
  reserved: boolean;
}

/**
 * Identifies an existing destination that lacks overwrite authorization.
 */
export class ConflictError extends Error {
  /**
   * Creates an error for the supplied destination conflict.
   */
  constructor(readonly conflict: Conflict) {
    super(`${conflict.isDirectory ? 'directory' : 'file'} ${JSON.stringify(conflict.path)} already exists`);
    this.name = 'ConflictError';
  }
}

/**
 * Installs resolved packages as one filesystem transaction.
 */
export async function installPackages(
  manifest: Manifest,
  packages: readonly string[],
  options: InstallerOptions
): Promise<void> {
  if (packages.length === 0) {
    throw new Error('no packages to install');
  }
  const operations = await planInstallation(manifest, packages, options);
  if (options.dryRun) {
    return;
  }
  const stageRoot = await stageOperations(operations, options);
  try {
    options.signal?.throwIfAborted();
    await options.preActivate?.();
    await revalidateOperations(operations, options);
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
  await activateOperations(operations, stageRoot, options.targetDirectory, options.commit);
  writeOutput(options.output, `✓ ${options.successVerb ?? 'Installed'} ${packages.length} package(s)\n`);
}

/**
 * Resolves mappings, rejects overlaps, reports the plan, and pre-authorizes all
 * existing destinations before any download begins.
 */
async function planInstallation(
  manifest: Manifest,
  packages: readonly string[],
  options: InstallerOptions
): Promise<InstallOperation[]> {
  const operations: InstallOperation[] = [];
  for (const name of packages) {
    const pkg = manifest.packages[name];
    if (!pkg) {
      throw new Error(`package ${JSON.stringify(name)} not found in manifest`);
    }
    if (pkg.files) {
      for (const file of pkg.files) {
        operations.push(
          operation(name, file.src, file.dest, await resolveDestination(options.targetDirectory, file.dest), false)
        );
      }
    } else if (pkg.path) {
      operations.push(
        operation(
          name,
          pkg.path,
          pkg.target ?? pkg.path,
          await resolveDestination(options.targetDirectory, pkg.target ?? pkg.path),
          true
        )
      );
    } else {
      throw new Error(`package ${JSON.stringify(name)} has empty path`);
    }
  }

  for (const [index, current] of operations.entries()) {
    if (options.verbose || options.dryRun) {
      writeOutput(options.output, `→ ${current.packageName}  ${current.source} → ${current.destination}\n`);
    }
    for (const previous of operations.slice(0, index)) {
      if (absolutePathsOverlap(current.destination, previous.destination)) {
        throw new Error(
          `packages ${JSON.stringify(previous.packageName)} and ${JSON.stringify(current.packageName)} have overlapping destinations ${JSON.stringify(previous.destination)} and ${JSON.stringify(current.destination)}`
        );
      }
    }
    current.expectedExisting = await ensureWritable(
      current.destination,
      current.isDirectory,
      options,
      options.dryRun ?? false
    );
  }
  return operations;
}

/**
 * Builds an unactivated operation record.
 */
function operation(
  packageName: string,
  source: string,
  relativeDestination: string,
  destination: string,
  isDirectory: boolean
): InstallOperation {
  return {
    packageName,
    source,
    relativeDestination,
    destination,
    isDirectory,
    staged: '',
    backup: '',
    hadExisting: false,
    activated: false,
    expectedExisting: false,
    reserved: false,
  };
}

/**
 * Re-resolves destination parents after staging and rejects new, unauthorized
 * conflicts before activation starts.
 */
async function revalidateOperations(operations: readonly InstallOperation[], options: InstallerOptions): Promise<void> {
  for (const current of operations) {
    const destination = await resolveDestination(options.targetDirectory, current.relativeDestination);
    if (destination !== current.destination) {
      throw new Error(
        `destination ${JSON.stringify(current.relativeDestination)} resolved to a different path during staging`
      );
    }
    if (current.expectedExisting || options.force || options.managed?.has(nodePath.normalize(destination))) {
      continue;
    }
    try {
      const information = await lstat(destination);
      throw new ConflictError({
        path: destination,
        isDirectory: current.isDirectory || information.isDirectory(),
      });
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }
}

/**
 * Downloads all planned content beneath the target filesystem.
 */
async function stageOperations(operations: InstallOperation[], options: InstallerOptions): Promise<string> {
  const targetRoot = await resolvedTargetRoot(options.targetDirectory);
  await mkdir(targetRoot, { recursive: true });
  const stageRoot = await mkdtemp(nodePath.join(targetRoot, '.codepull-stage-'));
  try {
    for (const [index, current] of operations.entries()) {
      current.staged = nodePath.join(stageRoot, 'content', String(index));
      current.backup = nodePath.join(stageRoot, 'backup', String(index));
      await mkdir(nodePath.dirname(current.staged), { recursive: true });
      try {
        if (current.isDirectory) {
          await options.fetcher.getDirectory(current.source, current.staged, options.signal);
        } else {
          await options.fetcher.getFileTo(current.source, current.staged, options.signal);
        }
      } catch (error) {
        throw new Error(
          `failed to stage ${JSON.stringify(current.source)} from package ${JSON.stringify(current.packageName)}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
    return stageRoot;
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Replaces every destination and invokes the lockfile commit while backups
 * remain available.
 */
async function activateOperations(
  operations: InstallOperation[],
  stageRoot: string,
  targetDirectory: string,
  commit?: () => Promise<void>
): Promise<void> {
  let preserveStage = false;
  try {
    for (const [index, current] of operations.entries()) {
      const destination = await resolveDestination(targetDirectory, current.relativeDestination);
      if (destination !== current.destination) {
        await rollbackOrThrow(
          operations.slice(0, index),
          stageRoot,
          new Error(`destination ${JSON.stringify(current.relativeDestination)} changed before activation`)
        );
      }
      await mkdir(nodePath.dirname(current.destination), { recursive: true });
      try {
        await lstat(current.destination);
        await mkdir(nodePath.dirname(current.backup), { recursive: true });
        await rename(current.destination, current.backup);
        current.hadExisting = true;
      } catch (error) {
        if (!isMissing(error)) {
          await rollbackOrThrow(operations.slice(0, index), stageRoot, error);
        }
        try {
          if (current.isDirectory) {
            await mkdir(current.destination);
          } else {
            const reservation = await open(current.destination, 'wx', 0o600);
            await reservation.close();
          }
          current.reserved = true;
        } catch (reservationError) {
          await rollbackOrThrow(operations.slice(0, index), stageRoot, reservationError);
        }
      }

      try {
        await rename(current.staged, current.destination);
      } catch (error) {
        if (current.hadExisting) {
          try {
            await rename(current.backup, current.destination);
          } catch (restoreError) {
            preserveStage = true;
            const rollbackError = await rollback(operations.slice(0, index));
            throw new Error(
              `activate replacement: ${message(error)} (restore current destination: ${message(restoreError)}; rollback previous destinations: ${rollbackError ? message(rollbackError) : 'succeeded'}; backups preserved at ${JSON.stringify(stageRoot)})`,
              { cause: error }
            );
          }
        } else if (current.reserved) {
          await rm(current.destination, { recursive: true, force: true });
        }
        await rollbackOrThrow(operations.slice(0, index), stageRoot, error);
      }
      current.activated = true;
    }

    if (commit) {
      try {
        await commit();
      } catch (error) {
        await rollbackOrThrow(
          operations,
          stageRoot,
          new Error(`commit installation: ${message(error)}`, { cause: error })
        );
      }
    }
  } catch (error) {
    if (String(error).includes('backups preserved at')) {
      preserveStage = true;
    }
    throw error;
  } finally {
    if (!preserveStage) {
      await rm(stageRoot, { recursive: true, force: true });
    }
  }
}

/**
 * Rolls back activated paths and reports a combined restoration failure.
 */
async function rollbackOrThrow(operations: InstallOperation[], stageRoot: string, cause: unknown): Promise<never> {
  const rollbackError = await rollback(operations);
  if (rollbackError) {
    throw new Error(
      `${message(cause)} (rollback failed: ${message(rollbackError)}; backups preserved at ${JSON.stringify(stageRoot)})`,
      { cause }
    );
  }
  throw cause;
}

/**
 * Restores activated destinations in reverse activation order.
 */
async function rollback(operations: readonly InstallOperation[]): Promise<Error | undefined> {
  const errors: Error[] = [];
  for (const current of [...operations].reverse()) {
    if (!current.activated) {
      continue;
    }
    try {
      await rm(current.destination, { recursive: true, force: true });
      if (current.hadExisting) {
        await rename(current.backup, current.destination);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return errors.length > 0 ? new AggregateError(errors, 'restore destinations') : undefined;
}

/**
 * Verifies that one existing destination is authorized for replacement.
 */
async function ensureWritable(
  destination: string,
  isDirectory: boolean,
  options: InstallerOptions,
  preview: boolean
): Promise<boolean> {
  let information: Awaited<ReturnType<typeof lstat>>;
  try {
    information = await lstat(destination);
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }

  const conflict: Conflict = {
    path: destination,
    isDirectory: isDirectory || information.isDirectory(),
  };
  if (preview) {
    const authorized = options.force || options.managed?.has(nodePath.normalize(destination));
    writeOutput(
      options.output,
      `! ${conflict.isDirectory ? 'directory' : 'file'} ${JSON.stringify(destination)} ${
        authorized ? 'would be replaced' : 'requires replacement authorization'
      }\n`
    );
    return true;
  }
  if (
    options.force ||
    options.managed?.has(nodePath.normalize(destination)) ||
    (options.confirm && (await options.confirm(conflict)))
  ) {
    return true;
  }
  if (options.confirm || options.noPrompt) {
    throw new ConflictError(conflict);
  }
  if (!process.stdin.isTTY) {
    throw new Error('destination exists and stdin is not a terminal; re-run with --force to overwrite');
  }

  const kind = information.isDirectory() ? 'directory' : 'file';
  const question =
    isDirectory || information.isDirectory()
      ? `directory ${JSON.stringify(destination)} already exists. Replace it entirely (not merge)? [y/N] `
      : `${kind} ${JSON.stringify(destination)} already exists. Overwrite? [y/N] `;
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await prompt.question(question)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new Error(`skipped ${JSON.stringify(destination)} (already exists)`);
    }
  } finally {
    prompt.close();
  }
  return true;
}

/**
 * Reports whether either absolute path contains the other.
 */
function absolutePathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

/**
 * Reports whether a child path is equal to or beneath its parent.
 */
function containsPath(parent: string, child: string): boolean {
  const relative = nodePath.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${nodePath.sep}`));
}

/**
 * Writes progress output to the configured stream or standard output.
 */
function writeOutput(output: NodeJS.WritableStream | undefined, value: string): void {
  (output ?? process.stdout).write(value);
}

/**
 * Formats an unknown error-like value.
 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
