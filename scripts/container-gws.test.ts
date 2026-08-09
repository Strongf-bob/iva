import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

void test("production image pins and verifies the Google Workspace CLI", async () => {
  const containerfile = await readFile(new URL("../Containerfile", import.meta.url), "utf8");

  assert.match(containerfile, /ARG GWS_VERSION=0\.22\.5/u);
  assert.match(containerfile, /@googleworkspace\/cli@\$\{GWS_VERSION\}/u);
  assert.match(
    containerfile,
    /test "\$\(gws --version \| sed -n '1p'\)" = "gws \$\{GWS_VERSION\}"/u,
  );
});
