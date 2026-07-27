import { z } from 'zod';
import { validateRelativePath } from './paths.js';

/**
 * Name of the manifest expected at every source repository root.
 */
export const MANIFEST_FILENAME = 'codepull.json';

/**
 * Builds a schema for a normalized path confined to a named root.
 */
const portablePath = (location: string) =>
  z.string().superRefine((value, context) => {
    const validationError = validateRelativePath(value, location);
    if (validationError) {
      context.addIssue({ code: 'custom', message: validationError });
    }
  });

/**
 * Schema for one individual file mapping.
 */
const fileSchema = z
  .object({
    src: portablePath('repository'),
    dest: portablePath('target'),
  })
  .strict();

/**
 * Schema for a directory package or a collection of file mappings.
 */
const packageSchema = z
  .object({
    description: z.string().optional(),
    path: portablePath('repository').optional(),
    target: portablePath('target').optional(),
    files: z.array(fileSchema).min(1).optional(),
    dependencies: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasPath = value.path !== undefined;
    const hasFiles = value.files !== undefined;
    if (!hasPath && !hasFiles) {
      context.addIssue({
        code: 'custom',
        message: 'must have either "path" or "files"',
      });
    }
    if (hasPath && hasFiles) {
      context.addIssue({
        code: 'custom',
        message: 'cannot have both "path" and "files"',
      });
    }
    if (hasFiles && value.target !== undefined) {
      context.addIssue({
        code: 'custom',
        message: '"target" is only valid with "path"',
      });
    }
  });

/**
 * Schema for the complete repository package catalogue.
 */
const manifestSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    packages: z.record(z.string(), packageSchema),
  })
  .strict();

/**
 * Individual source-to-destination file mapping from a manifest.
 */
export type ManifestFile = z.infer<typeof fileSchema>;

/**
 * Package definition using either directory or file-mapping mode.
 */
export type ManifestPackage = z.infer<typeof packageSchema>;

/**
 * Validated package catalogue loaded from a source repository.
 */
export type Manifest = z.infer<typeof manifestSchema>;

/**
 * Parses and strictly validates a Codepull source manifest.
 */
export function parseManifest(data: Uint8Array | string): Manifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
  } catch (error) {
    throw new Error(`invalid ${MANIFEST_FILENAME}: ${String(error)}`, { cause: error });
  }

  const result = manifestSchema.safeParse(decoded);
  if (!result.success) {
    const issue = result.error.issues[0];
    const location = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
    throw new Error(`invalid ${MANIFEST_FILENAME}${location}: ${issue?.message ?? 'validation failed'}`);
  }
  if (Object.keys(result.data.packages).length === 0) {
    throw new Error(`${MANIFEST_FILENAME} contains no packages`);
  }

  for (const [name, pkg] of Object.entries(result.data.packages)) {
    const seen = new Set<string>();
    for (const dependency of pkg.dependencies ?? []) {
      if (!(dependency in result.data.packages)) {
        throw new Error(`package ${JSON.stringify(name)} depends on unknown package ${JSON.stringify(dependency)}`);
      }
      if (seen.has(dependency)) {
        throw new Error(
          `package ${JSON.stringify(name)} lists dependency ${JSON.stringify(dependency)} more than once`
        );
      }
      seen.add(dependency);
    }
  }
  return result.data;
}
