import type { Dirent } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { MANIFEST_FILENAME, type Manifest, type ManifestPackage, parseManifest } from './manifest.js';
import { isMissing } from './paths.js';

/**
 * Options controlling creation of a source manifest.
 */
export interface InitializeManifestOptions {
  /**
   * Whether an existing manifest may be replaced.
   */
  force: boolean;

  /**
   * Whether to inspect and render the manifest without writing it.
   */
  dryRun: boolean;
}

/**
 * Result of discovering workspace packages and rendering their manifest.
 */
export interface InitializeManifestResult {
  /**
   * Validated manifest assembled from npm package metadata.
   */
  manifest: Manifest;

  /**
   * Pretty-printed JSON that was, or would be, written.
   */
  content: string;

  /**
   * Absolute destination of the generated manifest.
   */
  destination: string;
}

/**
 * Minimal npm package metadata used while discovering a monorepo.
 */
interface NpmPackage {
  /**
   * Canonical package name declared in npm metadata.
   */
  name: string;

  /**
   * Optional human-readable npm package description.
   */
  description?: string;

  /**
   * Names declared in the npm dependencies field.
   */
  dependencies: readonly string[];
}

/**
 * Discovers npm packages below `packages/` and creates `codepull.json`.
 */
export async function initializeManifest(
  projectRoot: string,
  options: InitializeManifestOptions
): Promise<InitializeManifestResult> {
  const destination = nodePath.join(projectRoot, MANIFEST_FILENAME);
  if (!options.force && (await fileExists(destination))) {
    throw new Error(`${MANIFEST_FILENAME} already exists; pass --force to replace it`);
  }

  const packagesRoot = nodePath.join(projectRoot, 'packages');
  let entries: Dirent[];
  try {
    entries = await readdir(packagesRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      throw new Error('could not initialize codepull.json: packages directory does not exist', { cause: error });
    }
    throw error;
  }

  const discovered: Array<{ sourcePath: string; metadata: NpmPackage }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDirectory = nodePath.join(packagesRoot, entry.name);
    const metadata = await readNpmPackage(packageDirectory);
    if (metadata) {
      discovered.push({ sourcePath: `packages/${entry.name}`, metadata });
    }
  }

  if (discovered.length === 0) {
    throw new Error('could not initialize codepull.json: no package.json files found in packages/*');
  }

  const localPackageNames = new Set(discovered.map(({ metadata }) => metadata.name));
  if (localPackageNames.size !== discovered.length) {
    const duplicate = discovered
      .map(({ metadata }) => metadata.name)
      .find((name, index, names) => names.indexOf(name) !== index);
    throw new Error(`cannot initialize codepull.json: duplicate npm package name ${JSON.stringify(duplicate)}`);
  }

  const packages: Record<string, ManifestPackage> = {};
  for (const { sourcePath, metadata } of discovered.sort((left, right) =>
    left.metadata.name.localeCompare(right.metadata.name)
  )) {
    const dependencies = metadata.dependencies.filter((dependency) => localPackageNames.has(dependency)).sort();
    packages[metadata.name] = {
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
      path: sourcePath,
      target: `packages/${metadata.name}`,
      ...(dependencies.length === 0 ? {} : { dependencies }),
    };
  }

  const rootMetadata = await readRootMetadata(projectRoot);
  const candidate = {
    ...(rootMetadata.name === undefined ? {} : { name: rootMetadata.name }),
    ...(rootMetadata.description === undefined ? {} : { description: rootMetadata.description }),
    packages,
  };
  const manifest = parseManifest(JSON.stringify(candidate));
  const content = `${JSON.stringify(manifest, null, 2)}\n`;

  if (!options.dryRun) {
    await writeFile(destination, content, options.force ? undefined : { flag: 'wx' });
  }
  return { manifest, content, destination };
}

/**
 * Reads a package directory when it contains npm metadata.
 */
async function readNpmPackage(packageDirectory: string): Promise<NpmPackage | undefined> {
  const filename = nodePath.join(packageDirectory, 'package.json');
  const value = await readJsonObjectIfPresent(filename);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value.name !== 'string' || value.name.length === 0) {
    throw new Error(
      `${nodePath.relative(nodePath.dirname(nodePath.dirname(packageDirectory)), filename)} needs a name`
    );
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    throw new Error(
      `${nodePath.relative(nodePath.dirname(nodePath.dirname(packageDirectory)), filename)} has an invalid description`
    );
  }
  const dependencyNames = readDependencyNames(value.dependencies, filename);
  return {
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    dependencies: dependencyNames,
  };
}

/**
 * Reads optional repository-level npm name and description fields.
 */
async function readRootMetadata(projectRoot: string): Promise<{ name?: string; description?: string }> {
  const value = await readJsonObjectIfPresent(nodePath.join(projectRoot, 'package.json'));
  if (value === undefined) {
    return {};
  }
  return {
    ...(typeof value.name === 'string' && value.name.length > 0 ? { name: value.name } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
  };
}

/**
 * Validates and returns names from an npm dependencies object.
 */
function readDependencyNames(value: unknown, filename: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${filename} has an invalid dependencies field`);
  }
  return Object.keys(value);
}

/**
 * Reads one JSON object, returning undefined only when the file is absent.
 */
async function readJsonObjectIfPresent(filename: string): Promise<Record<string, unknown> | undefined> {
  let contents: string;
  try {
    contents = await readFile(filename, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`could not parse ${filename}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${filename} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Reports whether a filesystem path currently exists.
 */
async function fileExists(filename: string): Promise<boolean> {
  try {
    await readFile(filename);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}
