import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BufferOutput, FakeSession, removeTemporaryDirectory, temporaryDirectory } from '../testing/helpers.js';
import { LOCKFILE_FILENAME, readLockfile } from './lockfile.js';
import { MANIFEST_FILENAME, parseManifest } from './manifest.js';
import { addTrackedPackages, resolveInstallLocation, selectPackages, updateTrackedPackages } from './tracking.js';

const roots: string[] = [];
beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryDirectory));
});

const source = {
  repository: 'acme/system',
  ref: 'main',
  transport: 'ssh' as const,
};

function sourceManifest() {
  return parseManifest(`{
    "packages": {
      "env": {"files":[{"src":"env.ts","dest":"env.ts"}]},
      "logger": {"path":"logger","target":"lib/logger","dependencies":["env"]}
    }
  }`);
}

function sourceSession(env = 'env v1', logger = 'logger v1'): FakeSession {
  const session = new FakeSession();
  session.files.set('env.ts', Buffer.from(env));
  session.directories.set('logger', new Map([['index.ts', Buffer.from(logger)]]));
  session.files.set(MANIFEST_FILENAME, Buffer.from(JSON.stringify(sourceManifest())));
  return session;
}

describe('tracked add and update', () => {
  it('stores one root lockfile with nested installation ownership', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const session = sourceSession();
    const output = new BufferOutput();
    await addTrackedPackages(root, source, session, sourceManifest(), ['logger'], {
      targetDirectory: 'apps/consumer',
      output,
    });
    const lockfile = await readLockfile(root);
    expect(lockfile.sources[0]?.directory).toBe('apps/consumer');
    expect(lockfile.sources[0]?.packages.map((pkg) => [pkg.name, pkg.requested])).toEqual([
      ['env', false],
      ['logger', true],
    ]);
    expect(await readFile(nodePath.join(root, 'apps/consumer/env.ts'), 'utf8')).toBe('env v1');
    expect(output.text()).toContain('Installed 2');
    await expect(readFile(nodePath.join(root, 'apps/consumer', LOCKFILE_FILENAME))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('updates every recorded package using its source settings', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await addTrackedPackages(root, source, sourceSession(), sourceManifest(), ['logger'], {
      targetDirectory: 'apps/consumer',
    });
    const next = sourceSession('env v2', 'logger v2');
    next.revisionValue = 'b'.repeat(40);
    const output = new BufferOutput();
    const updated = await updateTrackedPackages(
      root,
      '',
      [],
      async (recorded) => {
        expect(recorded).toMatchObject({
          repository: 'acme/system',
          ref: 'main',
          transport: 'ssh',
          directory: 'apps/consumer',
        });
        return next;
      },
      { output }
    );
    expect(await readFile(nodePath.join(root, 'apps/consumer/env.ts'), 'utf8')).toBe('env v2');
    expect(updated.sources[0]?.packages[0]?.revision).toBe('b'.repeat(40));
    expect(output.text()).toContain('Updated 2');
    expect(next.closed).toBe(true);
  });

  it('protects local edits unless force is supplied', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await addTrackedPackages(root, source, sourceSession(), sourceManifest(), ['env'], {});
    await writeFile(nodePath.join(root, 'env.ts'), 'consumer edit');
    await expect(updateTrackedPackages(root, '', [], async () => sourceSession('env v2'), {})).rejects.toThrow(
      'local changes detected'
    );
    expect(await readFile(nodePath.join(root, 'env.ts'), 'utf8')).toBe('consumer edit');
    await updateTrackedPackages(root, '', [], async () => sourceSession('env v2'), {
      force: true,
    });
    expect(await readFile(nodePath.join(root, 'env.ts'), 'utf8')).toBe('env v2');
  });

  it('rechecks local edits after staging and before activation', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await addTrackedPackages(root, source, sourceSession(), sourceManifest(), ['env'], {});
    const next = sourceSession('env v2');
    next.getFileTo = async (remotePath, staged) => {
      await writeFile(nodePath.join(root, 'env.ts'), 'edit during fetch');
      await FakeSession.prototype.getFileTo.call(next, remotePath, staged);
    };

    await expect(updateTrackedPackages(root, '', [], async () => next, {})).rejects.toThrow('local changes detected');
    expect(await readFile(nodePath.join(root, 'env.ts'), 'utf8')).toBe('edit during fetch');
  });

  it('keeps no-longer-needed dependencies tracked', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await addTrackedPackages(root, source, sourceSession(), sourceManifest(), ['logger'], {});
    const changed = parseManifest(
      '{"packages":{"env":{"files":[{"src":"env.ts","dest":"env.ts"}]},"logger":{"path":"logger","target":"lib/logger"}}}'
    );
    const next = sourceSession();
    next.files.set(MANIFEST_FILENAME, Buffer.from(JSON.stringify(changed)));
    const lockfile = await updateTrackedPackages(root, '', ['logger'], async () => next, {});
    expect(lockfile.sources[0]?.packages.map((pkg) => pkg.name)).toEqual(['env', 'logger']);
  });

  it('rejects source and mapping incompatibilities', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await addTrackedPackages(root, source, sourceSession(), sourceManifest(), ['env'], {});
    await expect(
      addTrackedPackages(root, { ...source, ref: 'next' }, sourceSession(), sourceManifest(), ['env'], {})
    ).rejects.toThrow('already tracked');

    const moved = parseManifest('{"packages":{"env":{"files":[{"src":"env.ts","dest":"moved.ts"}]}}}');
    const next = sourceSession();
    next.files.set(MANIFEST_FILENAME, Buffer.from(JSON.stringify(moved)));
    await expect(updateTrackedPackages(root, '', [], async () => next, {})).rejects.toThrow(
      'changed its source or destination mapping'
    );
  });

  it('rejects cross-source destination ownership', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await addTrackedPackages(root, source, sourceSession(), sourceManifest(), ['env'], {});
    await expect(
      addTrackedPackages(
        root,
        { ...source, repository: 'other/system' },
        sourceSession(),
        sourceManifest(),
        ['env'],
        {}
      )
    ).rejects.toThrow('overlap');
  });

  it('supports dry runs without creating a lockfile', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const output = new BufferOutput();
    await addTrackedPackages(root, source, sourceSession(), sourceManifest(), ['env'], {
      dryRun: true,
      output,
    });
    expect(output.text()).toContain('env.ts');
    await expect(readLockfile(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('merges later adds and preserves direct request markers', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await addTrackedPackages(root, source, sourceSession(), sourceManifest(), ['logger'], {});
    await addTrackedPackages(root, source, sourceSession(), sourceManifest(), ['env'], {});
    const lockfile = await readLockfile(root);
    expect(lockfile.sources[0]?.packages.map((pkg) => [pkg.name, pkg.requested])).toEqual([
      ['env', true],
      ['logger', true],
    ]);
  });

  it('validates update selection and missing lockfiles', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await expect(updateTrackedPackages(root, '', [], async () => sourceSession(), {})).rejects.toThrow(
      'run codepull add first'
    );
    await addTrackedPackages(root, source, sourceSession(), sourceManifest(), ['env'], {});
    const lockfile = await readLockfile(root);
    expect(() => selectPackages(lockfile, 'missing/repo', [])).toThrow('not tracked');
    expect(() => selectPackages(lockfile, '', ['env', 'env'])).toThrow('more than once');
    expect(() => selectPackages(lockfile, '', ['missing'])).toThrow('not tracked');
    const ambiguous = structuredClone(lockfile);
    ambiguous.sources.push({
      repository: 'other/system',
      ref: 'main',
      transport: 'https',
      packages: [
        {
          ...ambiguous.sources[0]!.packages[0]!,
          mappings: [
            {
              ...ambiguous.sources[0]!.packages[0]!.mappings[0]!,
              destination: 'other/env.ts',
            },
          ],
        },
      ],
    });
    expect(() => selectPackages(ambiguous, '', ['env'])).toThrow('tracked by multiple repositories');
  });

  it('rejects invalid source revisions before installation', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const session = sourceSession();
    session.revisionValue = 'short';
    await expect(addTrackedPackages(root, source, session, sourceManifest(), ['env'], {})).rejects.toThrow(
      'full 40-character'
    );
  });

  it('accepts semantically identical mappings in a different lockfile order', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const manifest = parseManifest(
      '{"packages":{"pair":{"files":[{"src":"b.ts","dest":"b.ts"},{"src":"a.ts","dest":"a.ts"}]}}}'
    );
    const initial = new FakeSession();
    initial.files.set('a.ts', Buffer.from('a1'));
    initial.files.set('b.ts', Buffer.from('b1'));
    initial.files.set(MANIFEST_FILENAME, Buffer.from(JSON.stringify(manifest)));
    await addTrackedPackages(root, source, initial, manifest, ['pair'], {});
    const reordered = await readLockfile(root);
    reordered.sources[0]!.packages[0]!.mappings.reverse();
    await writeFile(nodePath.join(root, LOCKFILE_FILENAME), `${JSON.stringify(reordered, null, 2)}\n`);

    const next = new FakeSession();
    next.files.set('a.ts', Buffer.from('a2'));
    next.files.set('b.ts', Buffer.from('b2'));
    next.files.set(MANIFEST_FILENAME, Buffer.from(JSON.stringify(manifest)));
    await updateTrackedPackages(root, '', [], async () => next, {});

    expect(await readFile(nodePath.join(root, 'a.ts'), 'utf8')).toBe('a2');
    expect(await readFile(nodePath.join(root, 'b.ts'), 'utf8')).toBe('b2');
  });

  it('serializes concurrent operations so lockfile sources are not lost', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const leftManifest = parseManifest('{"packages":{"left":{"files":[{"src":"left.ts","dest":"left.ts"}]}}}');
    const rightManifest = parseManifest('{"packages":{"right":{"files":[{"src":"right.ts","dest":"right.ts"}]}}}');
    const left = new FakeSession();
    left.files.set('left.ts', Buffer.from('left'));
    const originalGetFileTo = left.getFileTo.bind(left);
    let started!: () => void;
    const stagingStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    left.getFileTo = async (remotePath, destination) => {
      started();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await originalGetFileTo(remotePath, destination);
    };
    const right = new FakeSession();
    right.files.set('right.ts', Buffer.from('right'));

    const first = addTrackedPackages(root, { ...source, repository: 'acme/left' }, left, leftManifest, ['left'], {});
    await stagingStarted;
    const second = addTrackedPackages(
      root,
      { ...source, repository: 'acme/right' },
      right,
      rightManifest,
      ['right'],
      {}
    );
    await Promise.all([first, second]);

    expect((await readLockfile(root)).sources.map((entry) => entry.repository)).toEqual(['acme/left', 'acme/right']);
  });
});

describe('install location', () => {
  it('normalizes root and nested targets and rejects escapes', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    expect(await resolveInstallLocation(root, '.')).toEqual({
      target: await realpath(root),
      directory: '',
    });
    await mkdir(nodePath.join(root, 'apps'), { recursive: true });
    expect(await resolveInstallLocation(root, 'apps/consumer')).toMatchObject({
      directory: 'apps/consumer',
    });
    await expect(resolveInstallLocation(root, '../outside')).rejects.toThrow('must be inside lockfile directory');
  });

  it('rejects a symlinked installation directory outside the project root', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const outside = await temporaryDirectory();
    roots.push(outside);
    await symlink(outside, nodePath.join(root, 'vendor'));

    await expect(resolveInstallLocation(root, 'vendor')).rejects.toThrow('resolves outside');
  });
});
