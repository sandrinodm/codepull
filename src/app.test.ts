import { mkdir, readFile, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { CommanderError } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram, run } from './app.js';
import type { RepositorySource } from './core/git.js';
import { LOCKFILE_FILENAME } from './core/lockfile.js';
import { MANIFEST_FILENAME } from './core/manifest.js';
import { BufferOutput, FakeSession, removeTemporaryDirectory, temporaryDirectory } from './testing/helpers.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryDirectory));
});

function cliSession(): FakeSession {
  const session = new FakeSession();
  session.files.set(
    MANIFEST_FILENAME,
    Buffer.from(`{
      "name":"system",
      "packages":{
        "env":{"description":"Environment","files":[{"src":"env.ts","dest":"env.ts"}]},
        "logger":{"path":"logger","dependencies":["env"]}
      }
    }`)
  );
  session.files.set('env.ts', Buffer.from('env'));
  session.directories.set('logger', new Map([['index.ts', Buffer.from('logger')]]));
  return session;
}

async function execute(
  arguments_: string[],
  session = cliSession()
): Promise<{ output: string; errorOutput: string; source?: RepositorySource; root: string }> {
  const root = await temporaryDirectory();
  roots.push(root);
  const output = new BufferOutput();
  const errorOutput = new BufferOutput();
  let source: RepositorySource | undefined;
  const program = createProgram({
    projectRoot: root,
    output,
    errorOutput,
    version: '9.8.7',
    openRepository: async (value) => {
      source = value;
      return session;
    },
  });
  program.exitOverride();
  try {
    await program.parseAsync(['node', 'codepull', ...arguments_]);
  } catch (error) {
    if (!(error instanceof CommanderError) || error.code !== 'commander.version') {
      throw error;
    }
  }
  return {
    output: output.text(),
    errorOutput: errorOutput.text(),
    ...(source === undefined ? {} : { source }),
    root,
  };
}

describe('Codepull CLI', () => {
  it('adds packages over HTTPS and writes the root lockfile', async () => {
    const result = await execute([
      'add',
      'logger',
      '--repo',
      'https://github.com/acme/system.git',
      '--ssh=false',
      '--dir',
      'apps/consumer',
      '--verbose',
    ]);
    expect(result.source).toEqual({
      repository: 'acme/system',
      ref: 'main',
      transport: 'https',
    });
    expect(result.output).toContain('Packages that will be installed');
    expect(await readFile(nodePath.join(result.root, 'apps/consumer/env.ts'), 'utf8')).toBe('env');
    expect(await readFile(nodePath.join(result.root, LOCKFILE_FILENAME), 'utf8')).toContain(
      '"directory": "apps/consumer"'
    );
  });

  it('lists and describes packages', async () => {
    const listed = await execute(['list', '--repo', 'acme/system']);
    expect(listed.output).toContain('PACKAGE');
    expect(listed.output).toContain('env');
    expect(listed.output).toContain('Environment');
    const fileInfo = await execute(['info', 'env', '--repo', 'acme/system']);
    expect(fileInfo.output).toContain('individual files');
    expect(fileInfo.output).toContain('env.ts → env.ts');
    const directoryInfo = await execute(['info', 'logger', '--repo', 'acme/system']);
    expect(directoryInfo.output).toContain('Path in repo:   logger');
    expect(directoryInfo.output).toContain('Dependencies:   env');
  });

  it('prints its version', async () => {
    const result = await execute(['version']);
    expect(result.output).toMatch(/^codepull 9\.8\.7 \(.+\)\n$/);
  });

  it('supports the conventional version flag', async () => {
    const result = await execute(['--version']);
    expect(result.output).toBe('9.8.7\n');
  });

  it('initializes a manifest from npm workspace packages', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await mkdir(nodePath.join(root, 'packages/logger'), { recursive: true });
    await writeFile(
      nodePath.join(root, 'packages/logger/package.json'),
      JSON.stringify({ name: 'logger', description: 'Structured logging' })
    );
    const output = new BufferOutput();
    const program = createProgram({
      projectRoot: root,
      output,
      errorOutput: new BufferOutput(),
    });
    program.exitOverride();

    await program.parseAsync(['node', 'codepull', 'init']);

    expect(output.text()).toBe(`Created ${MANIFEST_FILENAME} with 1 package(s).\n`);
    expect(await readFile(nodePath.join(root, MANIFEST_FILENAME), 'utf8')).toContain('"target": "packages/logger"');
  });

  it('runs the real version entrypoint with the package version', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await run(['node', 'codepull', 'version']);
      expect(write).toHaveBeenCalledWith(expect.stringContaining('codepull 0.1.0'));
    } finally {
      write.mockRestore();
    }
  });

  it('updates from the root lockfile and supports dry-run plans', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const output = new BufferOutput();
    const first = cliSession();
    const second = cliSession();
    second.files.set('env.ts', Buffer.from('env v2'));
    second.revisionValue = 'b'.repeat(40);
    const sessions = [first, second];
    const program = createProgram({
      projectRoot: root,
      output,
      errorOutput: new BufferOutput(),
      openRepository: async () => {
        const session = sessions.shift();
        if (!session) {
          throw new Error('unexpected open');
        }
        return session;
      },
    });
    program.exitOverride();
    await program.parseAsync(['node', 'codepull', 'add', 'env', '--repo', 'acme/system']);

    const updateProgram = createProgram({
      projectRoot: root,
      output,
      errorOutput: new BufferOutput(),
      openRepository: async () => {
        const session = sessions.shift();
        if (!session) {
          throw new Error('unexpected open');
        }
        return session;
      },
    });
    updateProgram.exitOverride();
    await updateProgram.parseAsync(['node', 'codepull', 'update', 'env']);
    expect(await readFile(nodePath.join(root, 'env.ts'), 'utf8')).toBe('env v2');
    expect(output.text()).toContain('Updated 1 package(s)');

    const dryRun = await execute(['add', 'env', '--repo', 'acme/system', '--dry-run']);
    expect(dryRun.output).toContain('(dry-run mode — no files written)');
  });

  it('requires repositories and validates package names', async () => {
    await expect(execute(['add', 'env'])).rejects.toThrow('--repo is required');
    await expect(execute(['list'])).rejects.toThrow('--repo is required');
    await expect(execute(['info', 'missing', '--repo', 'acme/system'])).rejects.toThrow('not found');
    await expect(execute(['add', 'missing', '--repo', 'acme/system'])).rejects.toThrow('does not exist');
  });

  it('prevents update-only source overrides', async () => {
    await expect(execute(['update', '--ref', 'next'])).rejects.toThrow('recorded in codepull.lock');
    await expect(execute(['update', '--dir', 'nested'])).rejects.toThrow('recorded in codepull.lock');
    await expect(execute(['update', '--ssh=false'])).rejects.toThrow('recorded in codepull.lock');
  });

  it('rejects invalid repository and boolean options', async () => {
    await expect(execute(['list', '--repo', 'invalid'])).rejects.toThrow('expected owner/repo');
    await expect(execute(['list', '--repo', 'acme/system', '--ssh=maybe'])).rejects.toThrow('expected true or false');
  });

  it('reports missing manifests with actionable context', async () => {
    const session = new FakeSession();
    await expect(execute(['list', '--repo', 'acme/system'], session)).rejects.toThrow(
      `Make sure the repository is accessible and ${MANIFEST_FILENAME} exists`
    );
    expect(session.closed).toBe(true);
  });

  it('wraps repository-open failures with source context', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const program = createProgram({
      projectRoot: root,
      output: new BufferOutput(),
      errorOutput: new BufferOutput(),
      openRepository: async () => {
        throw new Error('authentication failed');
      },
    });
    program.exitOverride();
    await expect(program.parseAsync(['node', 'codepull', 'list', '--repo', 'acme/system'])).rejects.toThrow(
      'could not prepare acme/system@main: authentication failed'
    );
  });
});
