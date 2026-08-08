import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { TelegramUserId } from "./user-registry.ts";

export type UserLayout = {
  root: string;
  vault: string;
  runtime: string;
  data: string;
  sessions: string;
  integrations: string;
  usage: string;
};

const RUNTIME_LINKS = [
  ".output",
  "node_modules",
  "scripts",
  "package.json",
] as const;

function isInside(base: string, target: string): boolean {
  return target === base || target.startsWith(`${base}${sep}`);
}

function assertPersonalDirectory(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`personal directory must not be a symbolic link: ${path}`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory())
    throw new Error(`personal path is not a directory: ${path}`);
  chmodSync(path, 0o700);
}

function expectedLinkTarget(
  runtime: string,
  appRoot: string,
  name: string,
): string {
  return resolve(runtime, relative(runtime, join(appRoot, name)));
}

function ensureRuntimeLink(
  runtime: string,
  appRoot: string,
  name: string,
): void {
  const target = join(appRoot, name);
  if (!existsSync(target))
    throw new Error(`shared runtime target is missing: ${target}`);
  const link = join(runtime, name);
  if (existsSync(link) || lstatExists(link)) {
    const info = lstatSync(link);
    if (!info.isSymbolicLink()) {
      throw new Error(`runtime link path is not a symbolic link: ${link}`);
    }
    const actual = resolve(runtime, readlinkSync(link));
    if (actual !== expectedLinkTarget(runtime, appRoot, name)) {
      throw new Error(`runtime link has an unexpected target: ${link}`);
    }
    return;
  }
  symlinkSync(relative(runtime, target), link, infoType(target));
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function infoType(path: string): "dir" | "file" {
  return lstatSync(path).isDirectory() ? "dir" : "file";
}

export function resolveUserLayout(
  usersDir: string,
  userId: TelegramUserId,
): UserLayout {
  const base = resolve(usersDir);
  const root = resolve(base, userId);
  if (!isInside(base, root) || root === base) {
    throw new Error("user layout escaped users root");
  }
  return {
    root,
    vault: join(root, "vault"),
    runtime: join(root, "runtime"),
    data: join(root, "runtime", "data"),
    sessions: join(root, "runtime", ".eve", ".workflow-data"),
    integrations: join(root, "integrations"),
    usage: join(root, "usage"),
  };
}

export function ensureUserLayout(layout: UserLayout, appRoot: string): void {
  if (!isAbsolute(layout.root) || !isAbsolute(appRoot)) {
    throw new Error("user layout and app root must be absolute");
  }
  for (const path of [
    layout.root,
    layout.vault,
    layout.runtime,
    layout.data,
    dirname(layout.sessions),
    layout.sessions,
    layout.integrations,
    layout.usage,
  ]) {
    assertPersonalDirectory(path);
  }
  for (const name of RUNTIME_LINKS)
    ensureRuntimeLink(layout.runtime, appRoot, name);
}

export function verifyUserLayout(layout: UserLayout, appRoot: string): void {
  for (const path of [
    layout.root,
    layout.vault,
    layout.runtime,
    layout.data,
    dirname(layout.sessions),
    layout.sessions,
    layout.integrations,
    layout.usage,
  ]) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`invalid personal directory: ${path}`);
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error(`personal directory permissions are too broad: ${path}`);
    }
  }
  for (const name of RUNTIME_LINKS) {
    const link = join(layout.runtime, name);
    const info = lstatSync(link);
    const actual = info.isSymbolicLink()
      ? resolve(layout.runtime, readlinkSync(link))
      : null;
    if (actual !== expectedLinkTarget(layout.runtime, appRoot, name)) {
      throw new Error(`runtime link has an unexpected target: ${link}`);
    }
  }
  if (lstatExists(join(layout.runtime, ".env"))) {
    throw new Error("runtime view must not contain .env");
  }
}
