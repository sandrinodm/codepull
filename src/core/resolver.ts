import type { Manifest } from './manifest.js';

/**
 * Resolves requested packages in deterministic dependency-first order.
 * Independent packages are ordered alphabetically.
 */
export function resolvePackages(manifest: Manifest, requested: readonly string[]): string[] {
  if (requested.length === 0) {
    throw new Error('at least one package name is required');
  }
  for (const name of requested) {
    if (!(name in manifest.packages)) {
      throw new Error(`package ${JSON.stringify(name)} does not exist in the manifest`);
    }
  }

  const needed = new Set<string>();
  const visiting = new Set<string>();

  /**
   * Recursively collects one package and its transitive dependencies.
   */
  const collect = (name: string): void => {
    if (needed.has(name)) {
      return;
    }
    if (visiting.has(name)) {
      throw new Error(`circular dependency detected involving ${JSON.stringify(name)}`);
    }
    const pkg = manifest.packages[name];
    if (!pkg) {
      throw new Error(`dependency ${JSON.stringify(name)} not found in the manifest`);
    }
    visiting.add(name);
    for (const dependency of pkg.dependencies ?? []) {
      collect(dependency);
    }
    visiting.delete(name);
    needed.add(name);
  };
  for (const name of requested) {
    collect(name);
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const name of needed) {
    inDegree.set(name, 0);
  }
  for (const name of needed) {
    const pkg = manifest.packages[name];
    if (!pkg) {
      continue;
    }
    for (const dependency of pkg.dependencies ?? []) {
      if (!needed.has(dependency)) {
        continue;
      }
      inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), name]);
    }
  }

  const queue = [...inDegree]
    .filter(([, degree]) => degree === 0)
    .map(([name]) => name)
    .sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift();
    if (!name) {
      break;
    }
    order.push(name);
    const next: string[] = [];
    for (const dependent of dependents.get(name) ?? []) {
      const degree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, degree);
      if (degree === 0) {
        next.push(dependent);
      }
    }
    queue.push(...next.sort());
  }

  if (order.length !== needed.size) {
    throw new Error('circular dependency detected (could not order all packages)');
  }
  return order;
}
