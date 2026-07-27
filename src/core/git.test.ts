import { readFile, symlink } from 'node:fs/promises';
import nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitRepository, removeTemporaryDirectory, temporaryDirectory } from '../testing/helpers.js';
import { GitRepository, githubRemote, parseRepository, validateGitRef } from './git.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryDirectory));
});

describe('repository identity', () => {
  it.each([
    ['owner/repo', 'owner', 'repo'],
    ['https://github.com/owner/repo.git', 'owner', 'repo'],
    ['git@github.com:owner/repo.git', 'owner', 'repo'],
    ['ssh://git@github.com/owner/repo/', 'owner', 'repo'],
  ])('parses %s', (input, owner, name) => {
    expect(parseRepository(input)).toEqual({ owner, name });
  });

  it('rejects invalid identities and formats remotes', () => {
    expect(() => parseRepository('repo')).toThrow('expected owner/repo');
    expect(parseRepository('Acme/System')).toEqual({ owner: 'acme', name: 'system' });
    expect(githubRemote('owner', 'repo', true)).toBe('git@github.com:owner/repo.git');
    expect(githubRemote('owner', 'repo', false)).toBe('https://github.com/owner/repo.git');
  });
});

describe('Git references', () => {
  it.each(['main', 'feature/nested', 'v1.2.3', 'refs/tags/v1', 'a'.repeat(40)])('accepts %s', (ref) => {
    expect(validateGitRef(ref)).toBeUndefined();
  });

  it.each([
    '',
    '-main',
    ' main',
    'main ',
    'main:refs/heads/injected',
    '+refs/heads/*:refs/heads/*',
    'main..next',
    'main~1',
    'main@{1}',
    'question?',
    'open[',
  ])('rejects unsafe ref %j', (ref) => {
    expect(validateGitRef(ref)).toBeDefined();
  });
});

describe('GitRepository', () => {
  it('reads files, extracts directories, resolves revisions, and closes', async () => {
    const source = await createGitRepository({
      'codepull.json': '{"packages":{"a":{"path":"packages/a"}}}',
      'packages/a/index.ts': 'export const value = 1;',
      'packages/a/nested/value.ts': 'nested',
    });
    roots.push(source);
    const destination = await temporaryDirectory();
    roots.push(destination);
    const repository = await GitRepository.open(source, 'main');
    expect((await repository.getFile('codepull.json')).toString()).toContain('packages');
    await repository.getFileTo('codepull.json', nodePath.join(destination, 'manifest.json'));
    expect(await readFile(nodePath.join(destination, 'manifest.json'), 'utf8')).toContain('packages');
    await repository.getDirectory('packages/a', nodePath.join(destination, 'a'));
    expect(await readFile(nodePath.join(destination, 'a/nested/value.ts'), 'utf8')).toBe('nested');
    expect(await repository.revision()).toMatch(/^[0-9a-f]{40}$/);
    await repository.close();
    await repository.close();
  });

  it('validates inputs and reports missing repository content', async () => {
    await expect(GitRepository.open('', 'main')).rejects.toThrow('remote must not be empty');
    await expect(GitRepository.open('remote', '')).rejects.toThrow('ref must not be empty');
    await expect(GitRepository.open('remote', '-bad')).rejects.toThrow('must not start');
    await expect(GitRepository.open('remote', 'main:refs/heads/injected')).rejects.toThrow('unsafe');
    const source = await createGitRepository({ 'file.txt': 'value' });
    roots.push(source);
    const repository = await GitRepository.open(source, 'main');
    await expect(repository.getFile('')).rejects.toThrow('path must not be empty');
    await expect(repository.getFile('../file.txt')).rejects.toThrow('relative path');
    await expect(repository.getDirectory('../directory', 'destination')).rejects.toThrow('relative path');
    await expect(repository.getFile('missing')).rejects.toThrow('git command failed');
    await repository.close();
  });

  it('skips archive symbolic links', async () => {
    const source = await createGitRepository({ 'packages/a/file.txt': 'value' });
    roots.push(source);
    await symlink('file.txt', nodePath.join(source, 'packages/a/link.txt'));
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['-C', source, 'add', '.'], (error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['-C', source, 'commit', '--quiet', '-m', 'link'], (error) =>
        error ? reject(error) : resolve()
      );
    });
    const destination = await temporaryDirectory();
    roots.push(destination);
    const repository = await GitRepository.open(source, 'main');
    await repository.getDirectory('packages/a', destination);
    expect(await readFile(nodePath.join(destination, 'file.txt'), 'utf8')).toBe('value');
    await expect(readFile(nodePath.join(destination, 'link.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await repository.close();
  });

  it('rejects directories with no extractable archive entries', async () => {
    const source = await createGitRepository({ 'target.txt': 'value' });
    roots.push(source);
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(nodePath.join(source, 'packages/a'), { recursive: true })
    );
    await symlink('../../target.txt', nodePath.join(source, 'packages/a/link.txt'));
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['-C', source, 'add', '.'], (error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['-C', source, 'commit', '--quiet', '-m', 'link-only'], (error) =>
        error ? reject(error) : resolve()
      );
    });
    const destination = await temporaryDirectory();
    roots.push(destination);
    const repository = await GitRepository.open(source, 'main');
    await expect(repository.getDirectory('packages/a', destination)).rejects.toThrow('no extractable entries');
    await repository.close();
  });
});
