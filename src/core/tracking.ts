import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import nodePath from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { digestPath } from './digest.js';
import type { RepositorySession } from './git.js';
import { type Conflict, installPackages } from './installer.js';
import {
  cloneLockfile,
  findSource,
  LOCKFILE_FILENAME,
  LOCKFILE_VERSION,
  type LockedPackage,
  type Lockfile,
  type Mapping,
  OPERATION_LOCK_FILENAME,
  readLockfile,
  type Source,
  validateMappingIdentity,
  validateOwnedMappings,
  validateSourceIdentity,
  writeLockfile,
} from './lockfile.js';
import { MANIFEST_FILENAME, type Manifest, type ManifestPackage, parseManifest } from './manifest.js';
import { isMissing, resolveDestination, resolvedTargetRoot } from './paths.js';
import { resolvePackages } from './resolver.js';

/**
 * Installation, conflict, output, and cancellation policies for tracked work.
 */
export interface TrackingOptions {
  /**
   * Installation directory relative to the lockfile root.
   */
  targetDirectory?: string;

  /**
   * Whether local changes and unmanaged destinations may be replaced.
   */
  force?: boolean;

  /**
   * Whether to report planned work without changing files.
   */
  dryRun?: boolean;

  /**
   * Whether to emit detailed source-to-destination progress.
   */
  verbose?: boolean;

  /**
   * Stream used for installation progress and completion messages.
   */
  output?: NodeJS.WritableStream;

  /**
   * Optional conflict authorization adapter.
   */
  confirm?: (conflict: Conflict) => Promise<boolean>;

  /**
   * Whether conflicts must fail instead of prompting.
   */
  noPrompt?: boolean;

  /**
   * Signal used to cancel source and installation work.
   */
  signal?: AbortSignal;
}

/**
 * Repository identity fields that are independent of installed packages.
 */
export type SourceIdentity = Omit<Source, 'packages' | 'directory'>;

/**
 * Adapter that opens a repository session for a tracked source.
 */
export type OpenSource = (source: Source, signal?: AbortSignal) => Promise<RepositorySession>;

/**
 * Installs requested packages and commits their content with the root
 * lockfile as one transaction.
 */
export async function addTrackedPackages(
  projectRoot: string,
  sourceIdentity: SourceIdentity,
  session: RepositorySession,
  manifest: Manifest,
  requested: readonly string[],
  options: TrackingOptions
): Promise<Lockfile> {
  return withProjectOperationLock(projectRoot, options.signal, () =>
    addTrackedPackagesUnlocked(projectRoot, sourceIdentity, session, manifest, requested, options)
  );
}

/**
 * Implements a tracked add while the project operation lock is held.
 */
async function addTrackedPackagesUnlocked(
  projectRoot: string,
  sourceIdentity: SourceIdentity,
  session: RepositorySession,
  manifest: Manifest,
  requested: readonly string[],
  options: TrackingOptions
): Promise<Lockfile> {
  const location = await resolveInstallLocation(projectRoot, options.targetDirectory);
  const source: Source = {
    ...sourceIdentity,
    ...(location.directory === '' ? {} : { directory: location.directory }),
    packages: [],
  };
  validateSourceIdentity(source);
  const lockfile = await readOrCreateLockfile(projectRoot);
  const sourceIndex = findSource(lockfile, source.repository);

  if (sourceIndex >= 0) {
    const existing = lockfile.sources[sourceIndex];
    if (
      existing &&
      (existing.ref !== source.ref ||
        existing.transport !== source.transport ||
        (existing.directory ?? '') !== (source.directory ?? ''))
    ) {
      throw new Error(
        `repository ${JSON.stringify(source.repository)} is already tracked at ref ${JSON.stringify(existing.ref)} over ${existing.transport} in directory ${JSON.stringify(existing.directory ?? '')}`
      );
    }
  }

  const resolved = resolvePackages(manifest, requested);
  checkPlannedOwnership(lockfile, source, mappingsForPackages(manifest, resolved));
  let managed: ReadonlySet<string> | undefined;
  if (sourceIndex >= 0) {
    const existing = lockfile.sources[sourceIndex];
    if (existing) {
      await verifyCompatibility(location.target, existing, manifest, resolved, options.force ?? false);
      managed = await managedDestinations(location.target, existing, resolved);
    }
  }

  if (options.dryRun) {
    await runInstaller(location.target, session, manifest, resolved, managed, options);
    return lockfile;
  }

  const revision = await session.revision(options.signal);
  validateRevision(revision);
  const candidate = cloneLockfile(lockfile);
  const existingSource = sourceIndex >= 0 ? lockfile.sources[sourceIndex] : undefined;
  await runInstaller(
    location.target,
    session,
    manifest,
    resolved,
    managed,
    options,
    async () => {
      const packages = await snapshotPackages(location.target, manifest, resolved, requested, revision);
      if (sourceIndex < 0) {
        candidate.sources.push({ ...source, packages });
      } else {
        const existing = candidate.sources[sourceIndex];
        if (!existing) {
          throw new Error('tracked source disappeared while committing');
        }
        existing.packages = mergePackages(existing.packages, packages);
      }
      candidate.sources.sort((left, right) => left.repository.localeCompare(right.repository));
      await writeLockfile(projectRoot, candidate);
    },
    existingSource
      ? () => verifyCompatibility(location.target, existingSource, manifest, resolved, options.force ?? false)
      : undefined
  );
  return candidate;
}

/**
 * Updates every tracked package or the selected package names.
 * Each source is committed atomically with its lockfile snapshot.
 */
export async function updateTrackedPackages(
  projectRoot: string,
  repository: string,
  names: readonly string[],
  openSource: OpenSource,
  options: TrackingOptions
): Promise<Lockfile> {
  return withProjectOperationLock(projectRoot, options.signal, () =>
    updateTrackedPackagesUnlocked(projectRoot, repository, names, openSource, options)
  );
}

/**
 * Implements tracked updates while the project operation lock is held.
 */
async function updateTrackedPackagesUnlocked(
  projectRoot: string,
  repository: string,
  names: readonly string[],
  openSource: OpenSource,
  options: TrackingOptions
): Promise<Lockfile> {
  let lockfile: Lockfile;
  try {
    lockfile = await readLockfile(projectRoot);
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(`${LOCKFILE_FILENAME} not found in ${projectRoot}; run codepull add first`);
    }
    throw error;
  }
  const selections = selectPackages(lockfile, repository, names);
  for (const selection of selections) {
    lockfile = await updateSource(
      projectRoot,
      lockfile,
      selection.sourceIndex,
      selection.packageNames,
      openSource,
      options
    );
  }
  return lockfile;
}

/**
 * Package names selected for one tracked source.
 */
interface SourceSelection {
  /**
   * Index of the source in the validated lockfile.
   */
  sourceIndex: number;

  /**
   * Package names selected from that source.
   */
  packageNames: string[];
}

/**
 * Groups selected names by source and rejects missing, duplicate, or ambiguous
 * selections.
 */
export function selectPackages(lockfile: Lockfile, repository: string, names: readonly string[]): SourceSelection[] {
  if (repository !== '' && findSource(lockfile, repository) < 0) {
    throw new Error(`repository ${JSON.stringify(repository)} is not tracked in ${LOCKFILE_FILENAME}`);
  }
  const wanted = new Set<string>();
  for (const name of names) {
    if (wanted.has(name)) {
      throw new Error(`package ${JSON.stringify(name)} was requested more than once`);
    }
    wanted.add(name);
  }

  const matches = new Map<string, number>();
  const selections: SourceSelection[] = [];
  for (const [sourceIndex, source] of lockfile.sources.entries()) {
    if (repository !== '' && source.repository !== repository) {
      continue;
    }
    const selected = source.packages
      .filter((pkg) => wanted.size === 0 || wanted.has(pkg.name))
      .map((pkg) => pkg.name)
      .sort();
    for (const name of selected) {
      matches.set(name, (matches.get(name) ?? 0) + 1);
    }
    if (selected.length > 0) {
      selections.push({ sourceIndex, packageNames: selected });
    }
  }

  for (const name of names) {
    const count = matches.get(name) ?? 0;
    if (count === 0) {
      throw new Error(`package ${JSON.stringify(name)} is not tracked in ${LOCKFILE_FILENAME}`);
    }
    if (count > 1) {
      throw new Error(`package ${JSON.stringify(name)} is tracked by multiple repositories; pass --repo`);
    }
  }
  return selections;
}

/**
 * Refreshes selected packages from one source and commits its new snapshot.
 */
async function updateSource(
  projectRoot: string,
  lockfile: Lockfile,
  sourceIndex: number,
  selected: readonly string[],
  openSource: OpenSource,
  options: TrackingOptions
): Promise<Lockfile> {
  const source = lockfile.sources[sourceIndex];
  if (!source) {
    throw new Error('selected source does not exist');
  }
  const installTarget = (await resolveInstallLocation(projectRoot, source.directory)).target;
  const session = await openSource(source, options.signal).catch((error: unknown) => {
    throw new Error(`open source ${source.repository}@${source.ref}: ${message(error)}`, {
      cause: error,
    });
  });

  try {
    const data = await session.getFile(MANIFEST_FILENAME, options.signal).catch((error: unknown) => {
      throw new Error(`read ${MANIFEST_FILENAME} from ${source.repository}: ${message(error)}`, {
        cause: error,
      });
    });
    let manifest: Manifest;
    try {
      manifest = parseManifest(data);
    } catch (error) {
      throw new Error(`parse ${MANIFEST_FILENAME} from ${source.repository}: ${message(error)}`, {
        cause: error,
      });
    }

    let resolved: string[];
    try {
      resolved = resolvePackages(manifest, selected);
    } catch (error) {
      throw new Error(`source ${source.repository} is incompatible with ${LOCKFILE_FILENAME}: ${message(error)}`, {
        cause: error,
      });
    }
    await verifyCompatibility(installTarget, source, manifest, resolved, options.force ?? false);
    checkPlannedOwnership(lockfile, source, mappingsForPackages(manifest, resolved));
    const managed = await managedDestinations(installTarget, source, resolved);

    if (options.dryRun) {
      await runInstaller(installTarget, session, manifest, resolved, managed, {
        ...options,
        updating: true,
      });
      return lockfile;
    }

    const revision = await session.revision(options.signal);
    validateRevision(revision);
    const candidate = cloneLockfile(lockfile);
    await runInstaller(
      installTarget,
      session,
      manifest,
      resolved,
      managed,
      { ...options, updating: true },
      async () => {
        const packages = await snapshotPackages(
          installTarget,
          manifest,
          resolved,
          directlyRequestedPackages(source.packages),
          revision
        );
        const candidateSource = candidate.sources[sourceIndex];
        if (!candidateSource) {
          throw new Error('tracked source disappeared while committing');
        }
        candidateSource.packages = mergePackages(candidateSource.packages, packages);
        await writeLockfile(projectRoot, candidate);
      },
      () => verifyCompatibility(installTarget, source, manifest, resolved, options.force ?? false)
    );
    return candidate;
  } finally {
    await session.close();
  }
}

/**
 * Tracking policies with update-specific presentation state.
 */
type InternalTrackingOptions = TrackingOptions & { updating?: boolean };

/**
 * Adapts tracking options to the transactional installer.
 */
async function runInstaller(
  target: string,
  session: RepositorySession,
  manifest: Manifest,
  packages: readonly string[],
  managed: ReadonlySet<string> | undefined,
  options: InternalTrackingOptions,
  commit?: () => Promise<void>,
  preActivate?: () => Promise<void>
): Promise<void> {
  await installPackages(manifest, packages, {
    fetcher: session,
    targetDirectory: target,
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
    ...(options.noPrompt === undefined ? {} : { noPrompt: options.noPrompt }),
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(managed === undefined ? {} : { managed }),
    ...(commit === undefined ? {} : { commit }),
    ...(preActivate === undefined ? {} : { preActivate }),
    ...(options.updating ? { successVerb: 'Updated' } : {}),
  });
}

/**
 * Resolves an installation directory beneath the command execution root and
 * returns its filesystem and portable lockfile forms.
 */
export async function resolveInstallLocation(
  projectRoot: string,
  requested = ''
): Promise<{ target: string; directory: string }> {
  const root = await resolvedTargetRoot(nodePath.resolve(projectRoot));
  const target =
    requested !== '' && requested !== '.'
      ? nodePath.isAbsolute(requested)
        ? nodePath.normalize(requested)
        : nodePath.join(root, requested)
      : root;
  const relative = nodePath.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${nodePath.sep}`)) {
    throw new Error(
      `installation directory ${JSON.stringify(requested)} must be inside lockfile directory ${JSON.stringify(projectRoot)}`
    );
  }
  if (relative === '') {
    return { target: root, directory: '' };
  }
  const directory = relative.split(nodePath.sep).join('/');
  const resolved = await resolvedTargetRoot(await resolveDestination(root, directory));
  const resolvedRelative = nodePath.relative(root, resolved);
  if (resolvedRelative === '..' || resolvedRelative.startsWith(`..${nodePath.sep}`)) {
    throw new Error(
      `installation directory ${JSON.stringify(requested)} resolves outside lockfile directory ${JSON.stringify(projectRoot)}`
    );
  }
  return { target: resolved, directory };
}

/**
 * Converts a manifest package into deterministic lockfile mappings without
 * content digests.
 */
export function mappingsForPackage(pkg: ManifestPackage): Array<Omit<Mapping, 'digest'>> {
  if (pkg.files) {
    return pkg.files
      .map((file) => ({
        kind: 'file' as const,
        source: file.src,
        destination: file.dest,
      }))
      .sort((left, right) => left.destination.localeCompare(right.destination));
  }
  if (!pkg.path) {
    throw new Error('manifest package has neither path nor files');
  }
  return [
    {
      kind: 'directory',
      source: pkg.path,
      destination: pkg.target ?? pkg.path,
    },
  ];
}

/**
 * Builds mapping plans for each named package.
 */
function mappingsForPackages(
  manifest: Manifest,
  names: readonly string[]
): Map<string, Array<Omit<Mapping, 'digest'>>> {
  const result = new Map<string, Array<Omit<Mapping, 'digest'>>>();
  for (const name of names) {
    const pkg = manifest.packages[name];
    if (!pkg) {
      throw new Error(`package ${JSON.stringify(name)} not found in manifest`);
    }
    result.set(name, mappingsForPackage(pkg));
  }
  return result;
}

/**
 * Records resolved packages at one revision and hashes installed destinations.
 */
async function snapshotPackages(
  target: string,
  manifest: Manifest,
  names: readonly string[],
  requested: readonly string[],
  revision: string
): Promise<LockedPackage[]> {
  const requestedSet = new Set(requested);
  const packages: LockedPackage[] = [];
  for (const name of names) {
    const pkg = manifest.packages[name];
    if (!pkg) {
      throw new Error(`package ${JSON.stringify(name)} not found in manifest`);
    }
    const mappings: Mapping[] = [];
    for (const mapping of mappingsForPackage(pkg)) {
      const destination = await resolveDestination(target, mapping.destination);
      const digest = await digestPath(destination, mapping.kind);
      mappings.push({ ...mapping, digest });
    }
    packages.push({
      name,
      requested: requestedSet.has(name),
      revision,
      mappings,
    });
  }
  return packages;
}

/**
 * Replaces snapshots by name while preserving direct-request markers and
 * deterministic ordering.
 */
function mergePackages(existing: readonly LockedPackage[], fresh: readonly LockedPackage[]): LockedPackage[] {
  const byName = new Map(existing.map((pkg) => [pkg.name, pkg]));
  for (const pkg of fresh) {
    byName.set(pkg.name, {
      ...pkg,
      requested: pkg.requested || (byName.get(pkg.name)?.requested ?? false),
    });
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Returns package names explicitly selected by the consumer.
 */
function directlyRequestedPackages(packages: readonly LockedPackage[]): string[] {
  return packages.filter((pkg) => pkg.requested).map((pkg) => pkg.name);
}

/**
 * Ensures tracked mappings still match the manifest and that local content has
 * not changed unless forced replacement was requested.
 */
async function verifyCompatibility(
  target: string,
  source: Source,
  manifest: Manifest,
  names: readonly string[],
  force: boolean
): Promise<void> {
  const tracked = new Map(source.packages.map((pkg) => [pkg.name, pkg]));
  for (const name of names) {
    const recorded = tracked.get(name);
    if (!recorded) {
      continue;
    }
    const manifestPackage = manifest.packages[name];
    if (!manifestPackage) {
      throw new Error(`package ${JSON.stringify(name)} does not exist in the manifest`);
    }
    if (!sameMappings(recorded.mappings, mappingsForPackage(manifestPackage))) {
      throw new Error(
        `package ${JSON.stringify(name)} from ${source.repository} changed its source or destination mapping`
      );
    }
    if (force) {
      continue;
    }
    for (const mapping of recorded.mappings) {
      const destination = await resolveDestination(target, mapping.destination);
      let digest: string;
      try {
        digest = await digestPath(destination, mapping.kind);
      } catch (error) {
        throw new Error(`cannot update ${JSON.stringify(name)}: ${message(error)}`, {
          cause: error,
        });
      }
      if (digest !== mapping.digest) {
        throw new Error(
          `cannot update ${JSON.stringify(name)}: local changes detected at ${JSON.stringify(mapping.destination)} (use --force to replace)`
        );
      }
    }
  }
}

/**
 * Reports whether ordered mappings share the same kind, source, and
 * destination, intentionally ignoring digests.
 */
function sameMappings(recorded: readonly Mapping[], current: readonly Omit<Mapping, 'digest'>[]): boolean {
  const orderedRecorded = [...recorded].sort(compareMappings);
  const orderedCurrent = [...current].sort(compareMappings);
  return (
    orderedRecorded.length === orderedCurrent.length &&
    orderedRecorded.every((mapping, index) => {
      const candidate = orderedCurrent[index];
      return (
        candidate !== undefined &&
        mapping.kind === candidate.kind &&
        mapping.source === candidate.source &&
        mapping.destination === candidate.destination
      );
    })
  );
}

/**
 * Orders mappings by every identity field while ignoring their digest.
 */
function compareMappings(
  left: Pick<Mapping, 'kind' | 'source' | 'destination'>,
  right: Pick<Mapping, 'kind' | 'source' | 'destination'>
): number {
  return (
    left.destination.localeCompare(right.destination) ||
    left.source.localeCompare(right.source) ||
    left.kind.localeCompare(right.kind)
  );
}

/**
 * Resolves already-owned destinations for prompt-free replacement.
 */
async function managedDestinations(
  target: string,
  source: Source,
  packageNames: readonly string[]
): Promise<ReadonlySet<string>> {
  const packages = new Map(source.packages.map((pkg) => [pkg.name, pkg]));
  const managed = new Set<string>();
  for (const name of packageNames) {
    for (const mapping of packages.get(name)?.mappings ?? []) {
      managed.add(nodePath.normalize(await resolveDestination(target, mapping.destination)));
    }
  }
  return managed;
}

/**
 * Validates planned mappings together with unaffected lockfile entries before
 * filesystem changes begin.
 */
function checkPlannedOwnership(
  lockfile: Lockfile,
  plannedSource: Source,
  planned: ReadonlyMap<string, readonly Omit<Mapping, 'digest'>[]>
): void {
  const owners: Array<{
    repository: string;
    packageName: string;
    directory: string;
    mapping: Mapping;
  }> = [];
  for (const [packageName, mappings] of planned) {
    for (const mapping of mappings) {
      validateMappingIdentity(mapping);
      owners.push({
        repository: plannedSource.repository,
        packageName,
        directory: plannedSource.directory ?? '',
        mapping: { ...mapping, digest: `sha256:${'0'.repeat(64)}` },
      });
    }
  }
  for (const source of lockfile.sources) {
    for (const pkg of source.packages) {
      if (source.repository === plannedSource.repository && planned.has(pkg.name)) {
        continue;
      }
      for (const mapping of pkg.mappings) {
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
}

/**
 * Reads an existing lockfile or creates an empty in-memory document.
 */
async function readOrCreateLockfile(projectRoot: string): Promise<Lockfile> {
  try {
    return await readLockfile(projectRoot);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    return { version: LOCKFILE_VERSION, sources: [] };
  }
}

/**
 * Serializes all tracked mutations for one project, including the network and
 * staging window, so concurrent Codepull processes cannot commit stale state.
 */
async function withProjectOperationLock<T>(
  projectRoot: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  const release = await acquireProjectOperationLock(projectRoot, signal);
  try {
    return await operation();
  } finally {
    await release();
  }
}

/**
 * Acquires an exclusive project lock, recovering locks whose owning process no
 * longer exists.
 */
async function acquireProjectOperationLock(projectRoot: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  await mkdir(projectRoot, { recursive: true });
  const path = nodePath.join(projectRoot, OPERATION_LOCK_FILENAME);
  const token = randomUUID();

  for (;;) {
    signal?.throwIfAborted();
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }), 'utf8');
        await handle.sync();
      } catch (error) {
        await handle.close();
        await rm(path, { force: true });
        throw error;
      }
      await handle.close();
      return async () => {
        try {
          const owner = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown };
          if (owner.token === token) {
            await rm(path, { force: true });
          }
        } catch (error) {
          if (!isMissing(error)) {
            throw error;
          }
        }
      };
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      if (await removeStaleOperationLock(path)) {
        continue;
      }
      await delay(25, undefined, signal ? { signal } : undefined);
    }
  }
}

/**
 * Removes a lock owned by a process that no longer exists. Invalid lock files
 * receive a short grace period in case their owner is still writing metadata.
 */
async function removeStaleOperationLock(path: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown };
    if (typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        if (!isNoSuchProcess(error)) {
          return false;
        }
        await rm(path, { force: true });
        return true;
      }
    }
  } catch (error) {
    if (isMissing(error)) {
      return true;
    }
  }

  try {
    const information = await stat(path);
    if (Date.now() - information.mtimeMs < 5_000) {
      return false;
    }
    await rm(path, { force: true });
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return true;
    }
    throw error;
  }
}

/**
 * Reports whether exclusive lock creation found an existing lock.
 */
function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

/**
 * Reports whether a process probe found no running owner.
 */
function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
}

/**
 * Requires a full lowercase commit SHA.
 */
function validateRevision(revision: string): void {
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error('source revision must be a full 40-character commit SHA');
  }
}

/**
 * Formats an unknown error-like value.
 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
