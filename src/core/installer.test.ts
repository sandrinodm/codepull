import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BufferOutput, FakeSession, removeTemporaryDirectory, temporaryDirectory } from '../testing/helpers.js';
import { ConflictError, installPackages } from './installer.js';
import { parseManifest } from './manifest.js';
import { resolveDestination } from './paths.js';

const roots: string[] = [];
beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryDirectory));
});

const manifest = parseManifest(`{
  "packages": {
    "config": {"files":[{"src":"config/a.txt","dest":"a.txt"}]},
    "library": {"path":"packages/library","target":"lib"}
  }
}`);

function session(): FakeSession {
  const result = new FakeSession();
  result.files.set('config/a.txt', Buffer.from('new file'));
  result.directories.set(
    'packages/library',
    new Map([
      ['index.ts', Buffer.from('export {}')],
      ['nested/value.ts', Buffer.from('value')],
    ])
  );
  return result;
}

describe('transactional installer', () => {
  it('installs files and directories and reports completion', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const output = new BufferOutput();
    await installPackages(manifest, ['config', 'library'], {
      fetcher: session(),
      targetDirectory: root,
      output,
    });
    expect(await readFile(nodePath.join(root, 'a.txt'), 'utf8')).toBe('new file');
    expect(await readFile(nodePath.join(root, 'lib/nested/value.ts'), 'utf8')).toBe('value');
    expect(output.text()).toContain('✓ Installed 2 package(s)');
  });

  it('reports dry runs without writing content', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const output = new BufferOutput();
    await installPackages(manifest, ['config'], {
      fetcher: session(),
      targetDirectory: root,
      dryRun: true,
      output,
    });
    expect(output.text()).toContain('config/a.txt');
    await expect(readFile(nodePath.join(root, 'a.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports existing destinations during dry runs without prompting', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const output = new BufferOutput();
    const confirm = vi.fn(async () => true);
    await writeFile(nodePath.join(root, 'a.txt'), 'existing');

    await installPackages(manifest, ['config'], {
      confirm,
      dryRun: true,
      fetcher: session(),
      output,
      targetDirectory: root,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(output.text()).toContain('requires replacement authorization');
    expect(await readFile(nodePath.join(root, 'a.txt'), 'utf8')).toBe('existing');
  });

  it('requires overwrite authorization and supports managed and forced paths', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const destination = nodePath.join(root, 'a.txt');
    await writeFile(destination, 'old');
    await expect(
      installPackages(manifest, ['config'], {
        fetcher: session(),
        targetDirectory: root,
        noPrompt: true,
      })
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await readFile(destination, 'utf8')).toBe('old');

    await installPackages(manifest, ['config'], {
      fetcher: session(),
      targetDirectory: root,
      managed: new Set([await resolveDestination(root, 'a.txt')]),
    });
    expect(await readFile(destination, 'utf8')).toBe('new file');
    await writeFile(destination, 'old again');
    await installPackages(manifest, ['config'], {
      fetcher: session(),
      targetDirectory: root,
      force: true,
    });
    expect(await readFile(destination, 'utf8')).toBe('new file');
  });

  it('rejects non-interactive conflicts without implicit authorization', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await writeFile(nodePath.join(root, 'a.txt'), 'old');
    await expect(
      installPackages(manifest, ['config'], {
        fetcher: session(),
        targetDirectory: root,
      })
    ).rejects.toThrow('stdin is not a terminal');
  });

  it('uses an injected confirmation callback', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await writeFile(nodePath.join(root, 'a.txt'), 'old');
    await expect(
      installPackages(manifest, ['config'], {
        fetcher: session(),
        targetDirectory: root,
        confirm: async () => false,
      })
    ).rejects.toBeInstanceOf(ConflictError);
    await installPackages(manifest, ['config'], {
      fetcher: session(),
      targetDirectory: root,
      confirm: async (conflict) => conflict.path.endsWith('a.txt'),
    });
    expect(await readFile(nodePath.join(root, 'a.txt'), 'utf8')).toBe('new file');
  });

  it('rolls destinations back when commit fails', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await writeFile(nodePath.join(root, 'a.txt'), 'old');
    await expect(
      installPackages(manifest, ['config'], {
        fetcher: session(),
        targetDirectory: root,
        force: true,
        commit: async () => {
          throw new Error('lock failed');
        },
      })
    ).rejects.toThrow('commit installation: lock failed');
    expect(await readFile(nodePath.join(root, 'a.txt'), 'utf8')).toBe('old');
  });

  it('leaves destinations intact when staging fails', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await writeFile(nodePath.join(root, 'a.txt'), 'old');
    const broken = session();
    broken.directories.clear();
    await expect(
      installPackages(manifest, ['config', 'library'], {
        fetcher: broken,
        targetDirectory: root,
        force: true,
      })
    ).rejects.toThrow('failed to stage');
    expect(await readFile(nodePath.join(root, 'a.txt'), 'utf8')).toBe('old');
  });

  it('rejects a destination created while content is staged', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const destination = nodePath.join(root, 'a.txt');
    const racing = session();
    racing.getFileTo = async (remotePath, staged) => {
      await writeFile(destination, 'created concurrently');
      await FakeSession.prototype.getFileTo.call(racing, remotePath, staged);
    };

    await expect(
      installPackages(manifest, ['config'], {
        fetcher: racing,
        noPrompt: true,
        targetDirectory: root,
      })
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await readFile(destination, 'utf8')).toBe('created concurrently');
  });

  it('rejects a destination parent changed into a symlink during staging', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const outside = await temporaryDirectory();
    roots.push(outside);
    const unsafe = parseManifest('{"packages":{"config":{"files":[{"src":"config/a.txt","dest":"parent/a.txt"}]}}}');
    const racing = session();
    racing.getFileTo = async (remotePath, staged) => {
      await symlink(outside, nodePath.join(root, 'parent'));
      await FakeSession.prototype.getFileTo.call(racing, remotePath, staged);
    };

    await expect(
      installPackages(unsafe, ['config'], {
        fetcher: racing,
        targetDirectory: root,
      })
    ).rejects.toThrow('symbolic link');
    await expect(readFile(nodePath.join(outside, 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects overlapping mappings and unsafe parents', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const overlapping = parseManifest('{"packages":{"a":{"path":"a","target":"x"},"b":{"path":"b","target":"x/y"}}}');
    await expect(
      installPackages(overlapping, ['a', 'b'], {
        fetcher: session(),
        targetDirectory: root,
        dryRun: true,
      })
    ).rejects.toThrow('overlapping destinations');

    await writeFile(nodePath.join(root, 'parent'), 'not a directory');
    const unsafe = parseManifest('{"packages":{"a":{"files":[{"src":"config/a.txt","dest":"parent/file"}]}}}');
    await expect(
      installPackages(unsafe, ['a'], {
        fetcher: session(),
        targetDirectory: root,
      })
    ).rejects.toThrow('is not a directory');
  });

  it('replaces directories completely instead of merging', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await mkdir(nodePath.join(root, 'lib'), { recursive: true });
    await writeFile(nodePath.join(root, 'lib/obsolete'), 'old');
    await installPackages(manifest, ['library'], {
      fetcher: session(),
      targetDirectory: root,
      force: true,
    });
    await expect(readFile(nodePath.join(root, 'lib/obsolete'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
