import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { extract, type Headers } from 'tar-stream';
import { validateRelativePath } from './paths.js';

/**
 * Canonical repository identity used to open a GitHub source.
 */
export interface RepositorySource {
  /**
   * Repository in canonical owner/name form.
   */
  repository: string;

  /**
   * Branch, tag, commit, or other safe Git fetch ref.
   */
  ref: string;

  /**
   * Network transport used to contact GitHub.
   */
  transport: 'ssh' | 'https';
}

/**
 * Read-only access to one fetched repository revision.
 */
export interface RepositorySession {
  /**
   * Reads one file from the fetched revision.
   */
  getFile(remotePath: string, signal?: AbortSignal): Promise<Buffer>;

  /**
   * Writes one file from the fetched revision to a local destination.
   */
  getFileTo(remotePath: string, destination: string, signal?: AbortSignal): Promise<void>;

  /**
   * Extracts one directory from the fetched revision.
   */
  getDirectory(remotePath: string, destination: string, signal?: AbortSignal): Promise<void>;

  /**
   * Returns the fetched revision's full commit SHA.
   */
  revision(signal?: AbortSignal): Promise<string>;

  /**
   * Removes temporary repository state.
   */
  close(): Promise<void>;
}

/**
 * Parses an owner/repository pair or supported GitHub URL and returns its
 * canonical components.
 */
export function parseRepository(input: string): { owner: string; name: string } {
  let repositoryPath = input
    .trim()
    .replace(/\/$/, '')
    .replace(/\.git$/, '');
  for (const prefix of ['https://github.com/', 'http://github.com/', 'git@github.com:', 'ssh://git@github.com/']) {
    if (repositoryPath.startsWith(prefix)) {
      repositoryPath = repositoryPath.slice(prefix.length);
      break;
    }
  }
  const parts = repositoryPath.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`invalid repository ${JSON.stringify(repositoryPath)} (expected owner/repo)`);
  }
  return { owner: parts[0].toLowerCase(), name: parts[1].toLowerCase() };
}

/**
 * Validates one branch, tag, or commit-ish without allowing fetch refspec
 * syntax or ambiguous revision expressions.
 */
export function validateGitRef(ref: string): string | undefined {
  if (ref === '') {
    return 'must not be empty';
  }
  if (ref.trim() !== ref) {
    return 'must not contain surrounding whitespace';
  }
  if (ref.startsWith('-')) {
    return "must not start with '-'";
  }
  if (ref.startsWith('+')) {
    return "must not start with '+'";
  }
  if (ref === '@' || ref.includes('..') || ref.includes('@{')) {
    return 'contains unsafe Git revision syntax';
  }
  for (const character of ref) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || ['~', '^', ':', '?', '*', '[', '\\'].includes(character)) {
      return `contains unsafe Git character ${JSON.stringify(character)}`;
    }
  }
  if (ref.startsWith('/') || ref.endsWith('/') || ref.includes('//') || ref.endsWith('.')) {
    return 'must use normalized Git ref path syntax';
  }
  for (const component of ref.split('/')) {
    if (component.startsWith('.') || component.endsWith('.lock')) {
      return `contains unsafe Git ref component ${JSON.stringify(component)}`;
    }
  }
  return undefined;
}

/**
 * Returns the GitHub remote URL for a canonical repository identity.
 */
export function githubRemote(owner: string, name: string, useSsh: boolean): string {
  return useSsh ? `git@github.com:${owner}/${name}.git` : `https://github.com/${owner}/${name}.git`;
}

/**
 * Opens a partial, shallow Git repository session for a GitHub source.
 */
export async function openGitHubRepository(source: RepositorySource, signal?: AbortSignal): Promise<GitRepository> {
  const { owner, name } = parseRepository(source.repository);
  return GitRepository.open(githubRemote(owner, name, source.transport === 'ssh'), source.ref, signal);
}

/**
 * A reusable read-only session at one fetched Git revision.
 */
export class GitRepository implements RepositorySession {
  /**
   * Creates a session around an already-prepared temporary repository.
   */
  private constructor(
    private repositoryDirectory: string,
    private workspaceDirectory: string
  ) {}

  /**
   * Creates a shallow partial clone session for the supplied remote and ref.
   */
  static async open(remote: string, ref: string, signal?: AbortSignal): Promise<GitRepository> {
    if (remote.trim() === '') {
      throw new Error('repository remote must not be empty');
    }
    const refError = validateGitRef(ref);
    if (refError) {
      throw new Error(`repository ref ${refError}: ${JSON.stringify(ref)}`);
    }

    const workspace = await mkdtemp(nodePath.join(tmpdir(), 'codepull-repository-'));
    const repositoryDirectory = nodePath.join(workspace, 'repository.git');
    try {
      await runGit(['init', '--bare', '--quiet', repositoryDirectory], undefined, signal);
      await runGit(['remote', 'add', 'origin', remote], repositoryDirectory, signal);
      await runGit(['config', 'remote.origin.promisor', 'true'], repositoryDirectory, signal);
      await runGit(['config', 'remote.origin.partialclonefilter', 'blob:none'], repositoryDirectory, signal);
      await runGit(
        ['fetch', '--quiet', '--depth=1', '--filter=blob:none', '--no-tags', 'origin', ref],
        repositoryDirectory,
        signal
      );
      return new GitRepository(repositoryDirectory, workspace);
    } catch (error) {
      await rm(workspace, { recursive: true, force: true });
      throw new Error(`fetch repository ref ${JSON.stringify(ref)}: ${message(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Reads a single file from the fetched revision.
   */
  async getFile(remotePath: string, signal?: AbortSignal): Promise<Buffer> {
    const pathError = validateRelativePath(remotePath, 'repository');
    if (pathError) {
      throw new Error(`path ${pathError}`);
    }
    return runGit(['show', `FETCH_HEAD:${remotePath}`], this.repositoryDirectory, signal, true);
  }

  /**
   * Writes a single file from the fetched revision to a local destination.
   */
  async getFileTo(remotePath: string, destination: string, signal?: AbortSignal): Promise<void> {
    const content = await this.getFile(remotePath, signal);
    await mkdir(nodePath.dirname(destination), { recursive: true });
    await writeFile(destination, content, { mode: 0o644 });
  }

  /**
   * Extracts a repository directory while stripping its source prefix and
   * ignoring links and special filesystem entries.
   */
  async getDirectory(remotePath: string, destination: string, signal?: AbortSignal): Promise<void> {
    const pathError = validateRelativePath(remotePath, 'repository');
    if (pathError) {
      throw new Error(`remote path ${pathError}`);
    }
    await mkdir(destination, { recursive: true });
    const child = spawn(
      'git',
      ['-C', this.repositoryDirectory, 'archive', '--format=tar', 'FETCH_HEAD', '--', remotePath],
      { signal, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const standardError: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => standardError.push(chunk));
    const extraction = extract();
    const prefix = remotePath.replace(/^\/+|\/+$/g, '');
    let extractedEntries = 0;

    extraction.on('entry', (header, stream, next) => {
      void this.extractEntry(destination, prefix, header, stream)
        .then((extracted) => {
          if (extracted) {
            extractedEntries += 1;
          }
          next();
        })
        .catch((error: unknown) => extraction.destroy(error as Error));
    });
    child.stdout.pipe(extraction);
    const [status] = await Promise.all([processStatus(child, standardError), finished(extraction)]);
    if (status !== 0) {
      throw gitFailure(standardError);
    }
    if (extractedEntries === 0) {
      throw new Error(`repository directory ${JSON.stringify(remotePath)} contains no extractable entries`);
    }
  }

  /**
   * Returns the full commit SHA fetched for this repository session.
   */
  async revision(signal?: AbortSignal): Promise<string> {
    const output = await runGit(['rev-parse', 'FETCH_HEAD^{commit}'], this.repositoryDirectory, signal, true);
    return output.toString('utf8').trim();
  }

  /**
   * Removes all temporary Git data held by this session.
   */
  async close(): Promise<void> {
    if (this.workspaceDirectory === '') {
      return;
    }
    const workspace = this.workspaceDirectory;
    this.workspaceDirectory = '';
    this.repositoryDirectory = '';
    await rm(workspace, { recursive: true, force: true });
  }

  /**
   * Extracts one safe regular-file or directory entry from a Git archive.
   */
  private async extractEntry(destination: string, prefix: string, header: Headers, stream: Readable): Promise<boolean> {
    let name = header.name.replace(/^\.\//, '').replace(/\/$/, '');
    if (name === prefix) {
      stream.resume();
      await finished(stream);
      return false;
    }
    if (header.type === 'directory' && prefix.startsWith(`${name}/`)) {
      stream.resume();
      await finished(stream);
      return false;
    }
    if (!name.startsWith(`${prefix}/`)) {
      throw new Error(
        `archive entry ${JSON.stringify(header.name)} is outside requested directory ${JSON.stringify(prefix)}`
      );
    }
    name = name.slice(prefix.length + 1);
    if (name === '' || nodePath.posix.isAbsolute(name) || name.split('/').some((part) => part === '..')) {
      throw new Error(`refusing unsafe path in archive: ${JSON.stringify(header.name)}`);
    }

    const target = nodePath.join(destination, ...name.split('/'));
    const relative = nodePath.relative(nodePath.resolve(destination), nodePath.resolve(target));
    if (relative === '..' || relative.startsWith(`..${nodePath.sep}`)) {
      throw new Error(`path escapes destination directory: ${JSON.stringify(header.name)}`);
    }

    if (header.type === 'directory') {
      await mkdir(target, { recursive: true });
      stream.resume();
      await finished(stream);
      return true;
    }
    if (header.type !== 'file') {
      stream.resume();
      await finished(stream);
      return false;
    }

    await mkdir(nodePath.dirname(target), { recursive: true });
    const output = createWriteStream(target, {
      mode: header.mode ? header.mode & 0o777 : 0o644,
    });
    stream.pipe(output);
    await finished(output);
    await chmod(target, header.mode ? header.mode & 0o777 : 0o644);
    return true;
  }
}

/**
 * Runs a Git command and returns its standard output when requested.
 */
async function runGit(
  arguments_: readonly string[],
  directory?: string,
  signal?: AbortSignal,
  captureOutput = false
): Promise<Buffer> {
  const commandArguments = directory ? ['-C', directory, ...arguments_] : [...arguments_];
  const child = spawn('git', commandArguments, {
    signal,
    stdio: ['ignore', captureOutput ? 'pipe' : 'ignore', 'pipe'],
  });
  const standardOutput: Buffer[] = [];
  const standardError: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => standardOutput.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => standardError.push(chunk));
  const status = await processStatus(child, standardError);
  if (status !== 0) {
    throw gitFailure(standardError);
  }
  return Buffer.concat(standardOutput);
}

/**
 * Waits for a child process and returns its exit status.
 */
async function processStatus(child: ReturnType<typeof spawn>, standardError: Buffer[]): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new Error(`git command failed: ${message(error)}`, { cause: error })));
    child.once('close', (code) => resolve(code ?? 1));
    child.stderr?.once('error', (error) => {
      standardError.push(Buffer.from(error.message));
    });
  });
}

/**
 * Formats captured Git diagnostics as a stable command failure.
 */
function gitFailure(standardError: Buffer[]): Error {
  const message = Buffer.concat(standardError).toString('utf8').trim() || 'unknown error';
  return new Error(`git command failed: ${message}`);
}

/**
 * Formats an unknown error-like value.
 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
