import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Dates format in UTC whatever the host's zone, so results are the same on every machine.
process.env.TZ = "UTC";
// Agent shells inherit PASEO_HOME=~/.paseo. Anything that falls back to the default store must land in a throwaway home.
const home = mkdtempSync(join(tmpdir(), "project-notes-home-"));
process.env.PASEO_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
