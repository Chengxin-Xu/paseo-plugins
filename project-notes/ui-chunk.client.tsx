import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { ChunkExtras } from "./client/lazy-chunk";
import { followText } from "./shared/i18n";
import { NotesLanguageSettings } from "./client/settings";
import { NotesSurface, NotesWorkspacePanel } from "./client/board";
import { PromptScreen, PromptPopover } from "./client/composer";

// Paseo freezes exports before running the module body; keep the default hoisted.
export default function chunk() { return { api: 1, createSurfaces }; }

function createSurfaces(_client: PluginClientContext, extras?: ChunkExtras) {
  followText(extras?.text);
  return { notes: NotesSurface, prompts: PromptScreen, "project-notes": NotesWorkspacePanel, "prompt-popover": PromptPopover, language: NotesLanguageSettings };
}
