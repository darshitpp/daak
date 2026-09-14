import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const cddl = readFileSync(resolve(here, "../../../proto/ipc.cddl"), "utf8");

test("ipc.cddl declares the versioned envelope and all four unions", () => {
  for (const rule of ["ipc-message", "ipc-request", "ipc-response", "ipc-event"]) {
    assert.match(cddl, new RegExp(`^${rule} =`, "m"), `missing rule ${rule}`);
  }
  assert.match(cddl, /"v":\s*uint/, "ipc-message must carry a version field");
});
