import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

export function multiUserMode(): boolean {
  return process.env.ASSISTANT_MULTI_USER === "1";
}

function inside(base: string, target: string): boolean {
  return target === base || target.startsWith(`${base}${sep}`);
}

export function personalRoot(): string {
  const configured = process.env.ASSISTANT_PERSONAL_ROOT;
  if (!configured || !isAbsolute(configured)) {
    throw new Error(
      "multi-user personal root is not an absolute configured path",
    );
  }
  const root = realpathSync(configured);
  if (!lstatSync(root).isDirectory()) {
    throw new Error("multi-user personal root is not a directory");
  }
  return root;
}

function boundedBase(base: string): { root: string; base: string } {
  const root = personalRoot();
  const actual = realpathSync(base);
  if (!inside(root, actual)) throw new Error("tool base escaped personal root");
  return { root, base: actual };
}

function relativeCandidate(path: string, base: string): string {
  if (isAbsolute(path)) {
    throw new Error("multi-user tools require a relative path");
  }
  return resolve(base, path);
}

export function resolvePersonalReadPath(path: string, base?: string): string {
  if (!multiUserMode())
    return isAbsolute(path) ? path : resolve(base ?? process.cwd(), path);
  const bounded = boundedBase(base ?? personalRoot());
  const candidate = relativeCandidate(path, bounded.base);
  if (!inside(bounded.root, candidate))
    throw new Error("path escaped personal root");
  const actual = realpathSync(candidate);
  if (!inside(bounded.root, actual)) {
    throw new Error("path symlink escaped personal root");
  }
  return actual;
}

export function resolvePersonalWritePath(path: string, base?: string): string {
  if (!multiUserMode())
    return isAbsolute(path) ? path : resolve(base ?? process.cwd(), path);
  const bounded = boundedBase(base ?? personalRoot());
  const candidate = relativeCandidate(path, bounded.base);
  if (!inside(bounded.root, candidate))
    throw new Error("path escaped personal root");
  let ancestor = candidate;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor)
      throw new Error("path has no existing personal parent");
    ancestor = parent;
  }
  const actualAncestor = realpathSync(ancestor);
  if (!inside(bounded.root, actualAncestor)) {
    throw new Error("path symlink escaped personal root");
  }
  return candidate;
}
