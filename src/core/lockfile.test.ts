import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTemporaryDirectory, temporaryDirectory } from '../testing/helpers.js';
import { LOCKFILE_FILENAME, type Lockfile, readLockfile, validateLockfile, writeLockfile } from './lockfile.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryDirectory));
});

function validLockfile(): Lockfile {
  return {
    version: 1,
    sources: [
      {
        repository: 'acme/system',
        ref: 'main',
        transport: 'ssh',
        packages: [
          {
            name: 'env',
            requested: true,
            revision: 'a'.repeat(40),
            mappings: [
              {
                kind: 'file',
                source: 'env.ts',
                destination: 'src/env.ts',
                digest: `sha256:${'b'.repeat(64)}`,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('lockfiles', () => {
  it('round-trips atomically with stable formatting', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const lockfile = validLockfile();
    await writeLockfile(root, lockfile);
    expect(await readLockfile(root)).toEqual(lockfile);
    const text = await import('node:fs/promises').then(({ readFile }) =>
      readFile(nodePath.join(root, LOCKFILE_FILENAME), 'utf8')
    );
    expect(text).toBe(`${JSON.stringify(lockfile, null, 2)}\n`);
    lockfile.sources[0]!.ref = 'next';
    await writeLockfile(root, lockfile);
    expect((await readLockfile(root)).sources[0]?.ref).toBe('next');
  });

  it.each([
    ['wrong version', { ...validLockfile(), version: 2 }],
    ['unknown property', { ...validLockfile(), extra: true }],
    ['duplicate source', { ...validLockfile(), sources: [validLockfile().sources[0]!, validLockfile().sources[0]!] }],
    [
      'bad revision',
      {
        ...validLockfile(),
        sources: [
          {
            ...validLockfile().sources[0]!,
            packages: [{ ...validLockfile().sources[0]!.packages[0]!, revision: 'ABC' }],
          },
        ],
      },
    ],
    [
      'bad digest',
      {
        ...validLockfile(),
        sources: [
          {
            ...validLockfile().sources[0]!,
            packages: [
              {
                ...validLockfile().sources[0]!.packages[0]!,
                mappings: [{ ...validLockfile().sources[0]!.packages[0]!.mappings[0]!, digest: 'no' }],
              },
            ],
          },
        ],
      },
    ],
  ])('rejects %s', (_label, lockfile) => {
    expect(() => validateLockfile(lockfile)).toThrow();
  });

  it('rejects reserved, duplicate, and globally overlapping destinations', () => {
    const reserved = validLockfile();
    reserved.sources[0]!.packages[0]!.mappings[0]!.destination = LOCKFILE_FILENAME;
    expect(() => validateLockfile(reserved)).toThrow('reserved');

    const duplicate = validLockfile();
    duplicate.sources[0]!.packages[0]!.mappings.push({
      ...duplicate.sources[0]!.packages[0]!.mappings[0]!,
    });
    expect(() => validateLockfile(duplicate)).toThrow('duplicate destination');

    const overlap = validLockfile();
    overlap.sources[0]!.packages.push({
      name: 'nested',
      requested: true,
      revision: 'a'.repeat(40),
      mappings: [
        {
          kind: 'directory',
          source: 'nested',
          destination: 'SRC',
          digest: `sha256:${'c'.repeat(64)}`,
        },
      ],
    });
    expect(() => validateLockfile(overlap)).toThrow('overlap');
  });

  it.each([
    [
      'empty package names',
      (lockfile: Lockfile) => {
        lockfile.sources[0]!.packages[0]!.name = ' ';
      },
    ],
    [
      'duplicate package names',
      (lockfile: Lockfile) => {
        lockfile.sources[0]!.packages.push({
          ...lockfile.sources[0]!.packages[0]!,
          mappings: [
            {
              ...lockfile.sources[0]!.packages[0]!.mappings[0]!,
              destination: 'other.ts',
            },
          ],
        });
      },
    ],
    [
      'noncanonical repositories',
      (lockfile: Lockfile) => {
        lockfile.sources[0]!.repository = 'https://github.com/acme/system';
      },
    ],
    [
      'blank refs',
      (lockfile: Lockfile) => {
        lockfile.sources[0]!.ref = ' ';
      },
    ],
    [
      'padded refs',
      (lockfile: Lockfile) => {
        lockfile.sources[0]!.ref = ' main';
      },
    ],
    [
      'option-like refs',
      (lockfile: Lockfile) => {
        lockfile.sources[0]!.ref = '-main';
      },
    ],
    [
      'reserved source directories',
      (lockfile: Lockfile) => {
        lockfile.sources[0]!.directory = `${LOCKFILE_FILENAME}/nested`;
      },
    ],
    [
      'traversing source directories',
      (lockfile: Lockfile) => {
        lockfile.sources[0]!.directory = '../nested';
      },
    ],
    [
      'invalid mapping sources',
      (lockfile: Lockfile) => {
        lockfile.sources[0]!.packages[0]!.mappings[0]!.source = '../source';
      },
    ],
    [
      'invalid mapping destinations',
      (lockfile: Lockfile) => {
        lockfile.sources[0]!.packages[0]!.mappings[0]!.destination = '../destination';
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const lockfile = validLockfile();
    mutate(lockfile);
    expect(() => validateLockfile(lockfile)).toThrow();
  });

  it('reports malformed lockfile JSON', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    await writeFile(nodePath.join(root, LOCKFILE_FILENAME), '{');
    await expect(readLockfile(root)).rejects.toThrow(`invalid ${LOCKFILE_FILENAME}`);
  });

  it('normalizes repository identity casing and rejects case-only duplicates', () => {
    const mixedCase = validLockfile();
    mixedCase.sources[0]!.repository = 'Acme/System';
    expect(validateLockfile(mixedCase).sources[0]?.repository).toBe('acme/system');

    const duplicate = validLockfile();
    duplicate.sources.push({
      ...structuredClone(duplicate.sources[0]!),
      repository: 'Acme/System',
      packages: [
        {
          ...structuredClone(duplicate.sources[0]!.packages[0]!),
          name: 'other',
          mappings: [
            {
              ...structuredClone(duplicate.sources[0]!.packages[0]!.mappings[0]!),
              destination: 'other.ts',
            },
          ],
        },
      ],
    });
    expect(() => validateLockfile(duplicate)).toThrow('duplicate source');
  });

  it('preserves the lockfile backup when replacement and restoration both fail', async () => {
    const root = await temporaryDirectory();
    roots.push(root);
    const lockfile = validLockfile();
    await writeLockfile(root, lockfile);
    lockfile.sources[0]!.ref = 'next';
    let renameCall = 0;

    await expect(
      writeLockfile(root, lockfile, {
        rename: async (source, destination) => {
          renameCall += 1;
          if (renameCall >= 2) {
            throw new Error(`rename ${source} to ${destination} failed`);
          }
          await rename(source, destination);
        },
        rm,
      })
    ).rejects.toThrow('backup preserved at');

    const temporary = (await readdir(root)).find((entry) => entry.startsWith('.codepull-lock-'));
    expect(temporary).toBeDefined();
    expect(await readFile(nodePath.join(root, temporary!, `${LOCKFILE_FILENAME}.backup`), 'utf8')).toContain(
      '"ref": "main"'
    );
  });
});
