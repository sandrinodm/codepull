import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { Command, InvalidArgumentError, Option } from 'commander';
import { openGitHubRepository, parseRepository, type RepositorySession, type RepositorySource } from './core/git.js';
import { initializeManifest } from './core/initializer.js';
import { MANIFEST_FILENAME, type Manifest, parseManifest } from './core/manifest.js';
import { resolvePackages } from './core/resolver.js';
import { addTrackedPackages, type OpenSource, type SourceIdentity, updateTrackedPackages } from './core/tracking.js';

/**
 * Global command options shared by every Codepull subcommand.
 */
interface GlobalOptions {
  /**
   * GitHub repository selector supplied by the user.
   */
  repo: string;

  /**
   * Branch, tag, or commit to fetch.
   */
  ref: string;

  /**
   * Installation directory relative to the command root.
   */
  dir: string;

  /**
   * Whether to report planned work without changing files.
   */
  dryRun: boolean;

  /**
   * Whether existing destinations may be replaced without prompting.
   */
  force: boolean;

  /**
   * Whether to emit detailed progress output.
   */
  verbose: boolean;

  /**
   * Whether repository access uses SSH instead of HTTPS.
   */
  ssh: boolean;
}

/**
 * Process-facing dependencies used to create an isolated command tree.
 */
interface ApplicationDependencies {
  /**
   * Directory that owns the root lockfile and installation targets.
   */
  projectRoot: string;

  /**
   * Stream used for command results and progress.
   */
  output: NodeJS.WritableStream;

  /**
   * Stream used for Commander diagnostics.
   */
  errorOutput: NodeJS.WritableStream;

  /**
   * Opens a repository session for a canonical source.
   */
  openRepository: (source: RepositorySource, signal?: AbortSignal) => Promise<RepositorySession>;

  /**
   * Package version reported by the version command.
   */
  version: string;

  /**
   * Cancellation signal shared by repository and installation work.
   */
  signal: AbortSignal;
}

/**
 * Creates a fresh Codepull command tree with injectable process boundaries.
 */
export function createProgram(dependencies: Partial<ApplicationDependencies> = {}): Command {
  const resolved: ApplicationDependencies = {
    projectRoot: dependencies.projectRoot ?? process.cwd(),
    output: dependencies.output ?? process.stdout,
    errorOutput: dependencies.errorOutput ?? process.stderr,
    openRepository: dependencies.openRepository ?? openGitHubRepository,
    version: dependencies.version ?? '0.1.0',
    signal: dependencies.signal ?? new AbortController().signal,
  };
  const program = new Command();
  program
    .name('codepull')
    .description('Copy packages from a GitHub monorepo into your project')
    .version(resolved.version)
    .configureOutput({
      /**
       * Writes Commander command output to the injected output stream.
       */
      writeOut: (value) => resolved.output.write(value),
      /**
       * Writes Commander diagnostics to the injected error stream.
       */
      writeErr: (value) => resolved.errorOutput.write(value),
    })
    .showHelpAfterError()
    .option('-r, --repo <repository>', 'GitHub repository (owner/repo)', '')
    .option('--ref <ref>', 'Git ref (branch, tag, or commit)', 'main')
    .option('-d, --dir <directory>', 'Directory to install packages into', '.')
    .option('--dry-run', 'Show what would be done without writing files', false)
    .option('-f, --force', 'Overwrite existing files', false)
    .option('-v, --verbose', 'Verbose output', false)
    .addOption(new Option('--ssh [boolean]', 'Use SSH instead of HTTPS').default(true).argParser(parseBoolean));

  program
    .command('init')
    .description('Create codepull.json from packages/*/package.json')
    .action(async () => {
      const options = program.opts<GlobalOptions>();
      const result = await initializeManifest(resolved.projectRoot, {
        force: options.force,
        dryRun: options.dryRun,
      });
      const packageCount = Object.keys(result.manifest.packages).length;
      if (options.dryRun) {
        resolved.output.write(`Would create ${MANIFEST_FILENAME} with ${packageCount} package(s):\n${result.content}`);
      } else {
        resolved.output.write(`Created ${MANIFEST_FILENAME} with ${packageCount} package(s).\n`);
      }
    });

  program
    .command('add')
    .description('Add packages and their dependencies')
    .argument('<package...>', 'package names')
    .action(async (packages: string[]) => {
      const options = program.opts<GlobalOptions>();
      requireRepository(options.repo, true);
      const sourceIdentity = sourceFromOptions(options);
      if (options.verbose) {
        resolved.output.write(`→ Loading manifest from ${options.repo}@${options.ref}\n`);
      }
      const { session, manifest } = await loadManifest(sourceIdentity, resolved.openRepository, resolved.signal);
      try {
        const packagesToInstall = resolvePackages(manifest, packages);
        reportPlan(packagesToInstall, options, resolved.output);
        await addTrackedPackages(
          resolved.projectRoot,
          sourceIdentity,
          session,
          manifest,
          packages,
          trackingOptions(options, resolved.output, resolved.signal)
        );
      } finally {
        await session.close();
      }
    });

  program
    .command('update')
    .description('Update packages recorded in codepull.lock')
    .argument('[package...]', 'package names')
    .action(async (packages: string[]) => {
      const options = program.opts<GlobalOptions>();
      if (
        program.getOptionValueSource('ref') === 'cli' ||
        program.getOptionValueSource('ssh') === 'cli' ||
        program.getOptionValueSource('dir') === 'cli'
      ) {
        throw new Error('update uses the ref, transport, and installation directory recorded in codepull.lock');
      }
      const repository = normalizeRepository(options.repo);
      /**
       * Opens an update source through the injected repository adapter.
       */
      const openSource: OpenSource = (source, signal) => resolved.openRepository(source, signal);
      await updateTrackedPackages(
        resolved.projectRoot,
        repository,
        packages,
        openSource,
        trackingOptions(options, resolved.output, resolved.signal)
      );
    });

  program
    .command('list')
    .description('List available packages in the monorepo')
    .action(async () => {
      const options = program.opts<GlobalOptions>();
      requireRepository(options.repo);
      const sourceIdentity = sourceFromOptions(options);
      const { session, manifest } = await loadManifest(sourceIdentity, resolved.openRepository, resolved.signal);
      try {
        resolved.output.write(formatPackageTable(manifest));
      } finally {
        await session.close();
      }
    });

  program
    .command('info')
    .description('Show details about a package')
    .argument('<package>', 'package name')
    .action(async (packageName: string) => {
      const options = program.opts<GlobalOptions>();
      requireRepository(options.repo);
      const sourceIdentity = sourceFromOptions(options);
      const { session, manifest } = await loadManifest(sourceIdentity, resolved.openRepository, resolved.signal);
      try {
        const pkg = manifest.packages[packageName];
        if (!pkg) {
          throw new Error(`package ${JSON.stringify(packageName)} not found`);
        }
        resolved.output.write(formatPackageInfo(packageName, pkg));
      } finally {
        await session.close();
      }
    });

  program
    .command('version')
    .description('Print the version of Codepull')
    .action(() => {
      resolved.output.write(`codepull ${resolved.version} (${process.platform}/${process.arch})\n`);
    });

  return program;
}

/**
 * Executes the process arguments and assigns a non-zero status on failure.
 */
export async function run(argv = process.argv): Promise<void> {
  const version = await packageVersion();
  const abortController = new AbortController();
  /**
   * Cancels the active operation in response to process termination.
   */
  const cancel = () => abortController.abort(new Error('operation cancelled'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const program = createProgram({ version, signal: abortController.signal });
    await program.parseAsync(argv);
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

/**
 * Reads the package version colocated with source or compiled output.
 */
async function packageVersion(): Promise<string> {
  const data = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const value: unknown = JSON.parse(data);
  if (typeof value !== 'object' || value === null || !('version' in value) || typeof value.version !== 'string') {
    throw new Error('package.json does not contain a version');
  }
  return value.version;
}

/**
 * Parses the optional boolean accepted by `--ssh` and `--ssh=false`.
 */
function parseBoolean(value: string | undefined): boolean {
  if (value === undefined || value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new InvalidArgumentError('expected true or false');
}

/**
 * Requires a repository option with the command-specific diagnostic.
 */
function requireRepository(repository: string, includeExample = false): void {
  if (repository !== '') {
    return;
  }
  throw new Error(includeExample ? '--repo is required (for example, --repo myorg/system)' : '--repo is required');
}

/**
 * Converts global CLI options to a canonical tracked source identity.
 */
function sourceFromOptions(options: GlobalOptions): SourceIdentity {
  const { owner, name } = parseRepository(options.repo);
  return {
    repository: `${owner}/${name}`,
    ref: options.ref,
    transport: options.ssh ? 'ssh' : 'https',
  };
}

/**
 * Canonicalizes the optional repository selector used by update.
 */
function normalizeRepository(repository: string): string {
  if (repository === '') {
    return '';
  }
  const { owner, name } = parseRepository(repository);
  return `${owner}/${name}`;
}

/**
 * Opens a source and parses its root manifest, closing the session when either
 * step fails.
 */
async function loadManifest(
  source: SourceIdentity,
  openRepository: ApplicationDependencies['openRepository'],
  signal: AbortSignal
): Promise<{ session: RepositorySession; manifest: Manifest }> {
  let session: RepositorySession;
  try {
    session = await openRepository(source, signal);
  } catch (error) {
    throw new Error(`could not prepare ${source.repository}@${source.ref}: ${message(error)}`, {
      cause: error,
    });
  }
  try {
    let data: Buffer;
    try {
      data = await session.getFile(MANIFEST_FILENAME, signal);
    } catch (error) {
      throw new Error(
        `could not read ${MANIFEST_FILENAME}: ${message(error)}\n\nMake sure the repository is accessible and ${MANIFEST_FILENAME} exists at its root`,
        { cause: error }
      );
    }
    return { session, manifest: parseManifest(data) };
  } catch (error) {
    await session.close();
    throw error;
  }
}

/**
 * Converts CLI flags to tracking-layer options without undefined fields.
 */
function trackingOptions(options: GlobalOptions, output: NodeJS.WritableStream, signal: AbortSignal) {
  return {
    targetDirectory: options.dir,
    force: options.force,
    dryRun: options.dryRun,
    verbose: options.verbose,
    output,
    signal,
  };
}

/**
 * Writes the deterministic package resolution plan for verbose and dry runs.
 */
function reportPlan(packages: readonly string[], options: GlobalOptions, output: NodeJS.WritableStream): void {
  if (!options.verbose && !options.dryRun) {
    return;
  }
  output.write('Packages that will be installed:\n');
  for (const packageName of packages) {
    output.write(`  • ${packageName}\n`);
  }
  if (options.dryRun) {
    output.write('\n(dry-run mode — no files written)\n');
  }
}

/**
 * Formats the package catalogue as an aligned text table.
 */
function formatPackageTable(manifest: Manifest): string {
  const rows = Object.entries(manifest.packages)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, pkg]) => [
      name,
      pkg.files ? 'files' : 'dir',
      pkg.description ?? '-',
      pkg.dependencies?.join(', ') || '-',
    ]);
  const headers = ['PACKAGE', 'TYPE', 'DESCRIPTION', 'DEPS'];
  const separators = ['-------', '----', '-----------', '----'];
  const widths = headers.map((header, index) =>
    Math.max(header.length, separators[index]?.length ?? 0, ...rows.map((row) => row[index]?.length ?? 0))
  );
  return [...[headers, separators], ...rows]
    .map((row) =>
      row
        .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? cell.length)))
        .join('  ')
        .trimEnd()
    )
    .join('\n')
    .concat('\n');
}

/**
 * Formats detailed information for one manifest package.
 */
function formatPackageInfo(packageName: string, pkg: Manifest['packages'][string]): string {
  const lines = [`Name:           ${packageName}`, `Description:    ${pkg.description ?? '-'}`];
  if (pkg.files) {
    lines.push('Type:           individual files', 'Files:');
    for (const file of pkg.files) {
      lines.push(`  ${file.src} → ${file.dest}`);
    }
  } else {
    lines.push('Type:           directory', `Path in repo:   ${pkg.path}`, `Default target: ${pkg.target ?? pkg.path}`);
  }
  lines.push(`Dependencies:   ${pkg.dependencies?.join(', ') || 'none'}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Formats an unknown error-like value.
 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
