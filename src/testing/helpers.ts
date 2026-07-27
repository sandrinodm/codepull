import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import type { RepositorySession } from '../core/git.js';

/**
 * Promise-based adapter for Node's callback-style process execution helper.
 */
const executeFile = promisify(execFile);

/**
 * Writable stream that retains output for assertions.
 */
export class BufferOutput extends Writable {
  /**
   * Encoded output chunks in write order.
   */
  private readonly chunks: Buffer[] = [];

  /**
   * Captures one writable-stream chunk.
   */
  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }

  /**
   * Returns every captured write as UTF-8 text.
   */
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * In-memory repository adapter used by application and tracking tests.
 */
export class FakeSession implements RepositorySession {
  /**
   * Repository files available through direct file reads.
   */
  readonly files = new Map<string, Buffer>();

  /**
   * Repository directory trees available through archive-style extraction.
   */
  readonly directories = new Map<string, Map<string, Buffer>>();

  /**
   * Whether the session has been closed.
   */
  closed = false;

  /**
   * Full commit identifier returned by revision reads.
   */
  revisionValue = 'a'.repeat(40);

  /**
   * Reads one configured in-memory source file.
   */
  async getFile(remotePath: string): Promise<Buffer> {
    const value = this.files.get(remotePath);
    if (!value) {
      throw new Error(`missing ${remotePath}`);
    }
    return value;
  }

  /**
   * Writes one configured source file to a destination.
   */
  async getFileTo(remotePath: string, destination: string): Promise<void> {
    const content = await this.getFile(remotePath);
    await mkdir(nodePath.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }

  /**
   * Writes a configured directory tree to a destination.
   */
  async getDirectory(remotePath: string, destination: string): Promise<void> {
    const files = this.directories.get(remotePath);
    if (!files) {
      throw new Error(`missing ${remotePath}`);
    }
    await mkdir(destination, { recursive: true });
    for (const [relative, content] of files) {
      const path = nodePath.join(destination, ...relative.split('/'));
      await mkdir(nodePath.dirname(path), { recursive: true });
      await writeFile(path, content);
    }
  }

  /**
   * Returns the configured source revision.
   */
  async revision(): Promise<string> {
    return this.revisionValue;
  }

  /**
   * Marks the in-memory repository session as closed.
   */
  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * Creates a disposable filesystem directory for one test.
 */
export async function temporaryDirectory(): Promise<string> {
  return mkdtemp(nodePath.join(tmpdir(), 'codepull-test-'));
}

/**
 * Removes a disposable test directory.
 */
export async function removeTemporaryDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Creates a local Git repository with one committed source tree.
 */
export async function createGitRepository(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await temporaryDirectory();
  await executeFile('git', ['init', '--quiet', '--initial-branch=main', directory]);
  await executeFile('git', ['-C', directory, 'config', 'user.email', 'test@example.com']);
  await executeFile('git', ['-C', directory, 'config', 'user.name', 'Codepull Tests']);
  for (const [relative, content] of Object.entries(files)) {
    const path = nodePath.join(directory, ...relative.split('/'));
    await mkdir(nodePath.dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await executeFile('git', ['-C', directory, 'add', '.']);
  await executeFile('git', ['-C', directory, 'commit', '--quiet', '-m', 'fixture']);
  return directory;
}
