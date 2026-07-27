import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import nodePath from 'node:path';
import { z } from 'zod';
import { parseRepository, validateGitRef } from './git.js';
import { destinationsOverlap, isMissing, validateRelativePath } from './paths.js';

/**
 * Name of the root-owned Codepull provenance file.
 */
export const LOCKFILE_FILENAME = 'codepull.lock';

/**
 * Temporary project-level operation lock used to serialize Codepull changes.
 */
export const OPERATION_LOCK_FILENAME = '.codepull-operation.lock';

/**
 * Current lockfile schema version.
 */
export const LOCKFILE_VERSION = 1;

/**
 * Schema for a full lowercase Git commit identifier.
 */
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * Schema for a canonical SHA-256 content digest.
 */
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/**
 * Schema for one tracked source-to-destination mapping.
 */
const mappingSchema = z
  .object({
    kind: z.enum(['file', 'directory']),
    source: z.string(),
    destination: z.string(),
    digest: digestSchema,
  })
  .strict();

/**
 * Schema for one resolved package snapshot.
 */
const packageSchema = z
  .object({
    name: z.string(),
    requested: z.boolean(),
    revision: revisionSchema,
    mappings: z.array(mappingSchema).min(1),
  })
  .strict();

/**
 * Schema for one tracked repository source.
 */
const sourceSchema = z
  .object({
    repository: z.string(),
    ref: z.string(),
    transport: z.enum(['ssh', 'https']),
    directory: z.string().optional(),
    packages: z.array(packageSchema).min(1),
  })
  .strict();

/**
 * Schema for the complete root lockfile.
 */
const lockfileSchema = z
  .object({
    version: z.literal(LOCKFILE_VERSION),
    sources: z.array(sourceSchema).min(1),
  })
  .strict();

/**
 * Tracked file or directory mapping with its installed content digest.
 */
export type Mapping = z.infer<typeof mappingSchema>;

/**
 * Package snapshot recorded at one exact repository revision.
 */
export type LockedPackage = z.infer<typeof packageSchema>;

/**
 * Repository source and all packages installed from it.
 */
export type Source = z.infer<typeof sourceSchema>;

/**
 * Validated root lockfile document.
 */
export type Lockfile = z.infer<typeof lockfileSchema>;

/**
 * Mapping paired with the source and package that own its destination.
 */
interface OwnedMapping {
  /**
   * Canonical repository that owns the mapping.
   */
  repository: string;

  /**
   * Package name that owns the mapping.
   */
  packageName: string;

  /**
   * Source installation directory relative to the lockfile.
   */
  directory: string;

  /**
   * Recorded mapping whose effective destination is checked.
   */
  mapping: Mapping;
}

/**
 * Returns the consumer lockfile path beneath a project root.
 */
export function lockfilePath(projectRoot: string): string {
  return nodePath.join(projectRoot, LOCKFILE_FILENAME);
}

/**
 * Reads and strictly validates a consumer lockfile.
 */
export async function readLockfile(projectRoot: string): Promise<Lockfile> {
  const data = await readFile(lockfilePath(projectRoot), 'utf8');
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch (error) {
    throw new Error(`invalid ${LOCKFILE_FILENAME}: ${String(error)}`, { cause: error });
  }
  return validateLockfile(decoded);
}

/**
 * Validates a lockfile's schema, source identities, snapshots, and global
 * destination ownership.
 */
export function validateLockfile(value: unknown): Lockfile {
  const result = lockfileSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const location = issue?.path.length ? ` ${issue.path.join('.')}` : '';
    throw new Error(`invalid ${LOCKFILE_FILENAME}${location}: ${issue?.message ?? 'validation failed'}`);
  }
  const repositories = new Set<string>();
  const owners: OwnedMapping[] = [];

  for (const [sourceIndex, source] of result.data.sources.entries()) {
    source.repository = canonicalRepository(source.repository);
    validateSourceIdentity(source);
    if (repositories.has(source.repository)) {
      throw new Error(`${LOCKFILE_FILENAME} contains duplicate source ${JSON.stringify(source.repository)}`);
    }
    repositories.add(source.repository);
    const packages = new Set<string>();
    for (const pkg of source.packages) {
      if (pkg.name.trim() === '') {
        throw new Error(`${LOCKFILE_FILENAME} sources[${sourceIndex}]: package name must not be empty`);
      }
      if (packages.has(pkg.name)) {
        throw new Error(
          `${LOCKFILE_FILENAME} source ${JSON.stringify(source.repository)} contains duplicate package ${JSON.stringify(pkg.name)}`
        );
      }
      packages.add(pkg.name);
      const destinations = new Set<string>();
      for (const mapping of pkg.mappings) {
        validateMappingIdentity(mapping);
        if (destinations.has(mapping.destination)) {
          throw new Error(
            `package ${JSON.stringify(pkg.name)} contains duplicate destination ${JSON.stringify(mapping.destination)}`
          );
        }
        destinations.add(mapping.destination);
        owners.push({
          repository: source.repository,
          packageName: pkg.name,
          directory: source.directory ?? '',
          mapping,
        });
      }
    }
  }
  validateOwnedMappings(owners);
  return result.data;
}

/**
 * Validates the fields that identify an upstream source.
 */
export function validateSourceIdentity(source: Pick<Source, 'repository' | 'ref' | 'transport' | 'directory'>): void {
  canonicalRepository(source.repository);
  const refError = validateGitRef(source.ref);
  if (refError) {
    throw new Error(`ref ${refError}`);
  }
  if (source.directory !== undefined) {
    const validationError = validateRelativePath(source.directory);
    if (validationError) {
      throw new Error(`directory: ${validationError}`);
    }
    if (isReservedPath(source.directory)) {
      throw new Error(`directory path ${JSON.stringify(source.directory)} is reserved for Codepull`);
    }
  }
}

/**
 * Validates a mapping's kind and normalized repository/consumer paths.
 */
export function validateMappingIdentity(mapping: Pick<Mapping, 'kind' | 'source' | 'destination'>): void {
  const sourceError = validateRelativePath(mapping.source);
  if (sourceError) {
    throw new Error(`source: ${sourceError}`);
  }
  const destinationError = validateRelativePath(mapping.destination);
  if (destinationError) {
    throw new Error(`destination: ${destinationError}`);
  }
  if (isReservedPath(mapping.destination)) {
    throw new Error(`destination path ${JSON.stringify(mapping.destination)} is reserved for Codepull`);
  }
}

/**
 * Filesystem operations injected by lockfile failure-path tests.
 */
export interface LockfileFileOperations {
  /**
   * Renames one filesystem entry.
   */
  rename?: typeof rename;

  /**
   * Removes one filesystem entry.
   */
  rm?: typeof rm;
}

/**
 * Writes a validated lockfile through a synced temporary file and atomically
 * replaces the previous document.
 */
export async function writeLockfile(
  projectRoot: string,
  lockfile: Lockfile,
  operations: LockfileFileOperations = {}
): Promise<void> {
  const renamePath = operations.rename ?? rename;
  const removePath = operations.rm ?? rm;
  const validated = validateLockfile(lockfile);
  const data = `${JSON.stringify(validated, null, 2)}\n`;
  await mkdir(projectRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(nodePath.join(projectRoot, '.codepull-lock-'));
  const temporaryPath = nodePath.join(temporaryDirectory, LOCKFILE_FILENAME);
  const handle = await open(temporaryPath, 'w', 0o644);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporaryPath, 0o644);

  const destination = lockfilePath(projectRoot);
  const backup = nodePath.join(temporaryDirectory, `${LOCKFILE_FILENAME}.backup`);
  let hadExisting = false;
  try {
    await access(destination, constants.F_OK);
    await renamePath(destination, backup);
    hadExisting = true;
  } catch (error) {
    if (!isMissing(error)) {
      await removePath(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  let preserveTemporaryDirectory = false;
  try {
    await renamePath(temporaryPath, destination);
  } catch (error) {
    if (hadExisting) {
      try {
        await renamePath(backup, destination);
      } catch (restoreError) {
        preserveTemporaryDirectory = true;
        throw new Error(
          `replace ${LOCKFILE_FILENAME}: ${message(error)} (restore backup: ${message(restoreError)}; backup preserved at ${JSON.stringify(temporaryDirectory)})`,
          { cause: error }
        );
      }
    }
    throw error;
  } finally {
    if (!preserveTemporaryDirectory) {
      await removePath(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

/**
 * Creates an independent deep copy suitable for transactional mutation.
 */
export function cloneLockfile(lockfile: Lockfile): Lockfile {
  return structuredClone(lockfile);
}

/**
 * Finds the source index for a canonical repository, or -1 when absent.
 */
export function findSource(lockfile: Lockfile, repository: string): number {
  return lockfile.sources.findIndex((source) => source.repository === repository);
}

/**
 * Rejects any pair of globally-owned destinations that overlap.
 */
export function validateOwnedMappings(owners: readonly OwnedMapping[]): void {
  const sorted = [...owners].sort((left, right) => ownedDestination(left).localeCompare(ownedDestination(right)));
  for (const [index, owner] of sorted.entries()) {
    for (const other of sorted.slice(0, index)) {
      const left = ownedDestination(other);
      const right = ownedDestination(owner);
      if (destinationsOverlap(left, right)) {
        throw new Error(
          `${LOCKFILE_FILENAME} destinations ${JSON.stringify(left)} (${other.repository}:${other.packageName}) and ${JSON.stringify(right)} (${owner.repository}:${owner.packageName}) overlap`
        );
      }
    }
  }
}

/**
 * Returns a mapping destination relative to the lockfile directory.
 */
function ownedDestination(owner: OwnedMapping): string {
  return owner.directory === ''
    ? owner.mapping.destination
    : nodePath.posix.join(owner.directory, owner.mapping.destination);
}

/**
 * Returns a normalized lowercase repository identity while rejecting URL forms
 * that are only accepted at the CLI boundary.
 */
function canonicalRepository(repository: string): string {
  const { owner, name } = parseRepository(repository);
  const canonical = `${owner}/${name}`;
  if (repository.toLowerCase() !== canonical) {
    throw new Error(`repository must use canonical owner/repo form ${JSON.stringify(canonical)}`);
  }
  return canonical;
}

/**
 * Reports whether a consumer-relative path targets Codepull metadata.
 */
function isReservedPath(path: string): boolean {
  return [LOCKFILE_FILENAME, OPERATION_LOCK_FILENAME].some(
    (reserved) => path === reserved || path.startsWith(`${reserved}/`)
  );
}

/**
 * Formats an unknown error-like value.
 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
