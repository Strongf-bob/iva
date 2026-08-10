import { isAbsolute, join } from "node:path";

export function personalDataDir(
  state: { personalRoot?: string },
  fallback: string,
): string {
  return state.personalRoot && isAbsolute(state.personalRoot)
    ? join(state.personalRoot, "runtime", "data")
    : fallback;
}
