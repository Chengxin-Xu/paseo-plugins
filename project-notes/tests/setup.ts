import { bindTranslator, createTranslator } from "../shared/i18n";
import zh from "../shared/locales/zh-CN.json";
import kitZh from "../shared/locales/kit/zh-CN.json";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

bindTranslator(createTranslator("zh-CN", [zh, kitZh]));

// Dates format in UTC whatever the host's zone, so results are the same on every machine.
process.env.TZ = "UTC";
// Agent shells inherit PASEO_HOME=~/.paseo. Anything that falls back to the default store must land in a throwaway home.
const home = mkdtempSync(join(tmpdir(), "project-notes-home-"));
process.env.PASEO_HOME = home;
mkdirSync(join(home, "plugin-data/project-notes"), { recursive: true });
writeFileSync(join(home, "plugin-data/project-notes/i18n-state.json"), JSON.stringify({ setting: "zh-CN", device: "zh-CN" }));
afterAll(() => rmSync(home, { recursive: true, force: true }));
