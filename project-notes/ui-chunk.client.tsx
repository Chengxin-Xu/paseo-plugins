import { NotesSurface, NotesWorkspacePanel } from "./client/board";
import { PromptScreen, PromptPopover } from "./client/composer";

// Paseo freezes exports before running the module body; keep the default hoisted.
export default function chunk() { return { api: 1, createSurfaces }; }

function createSurfaces() {
  return { notes: NotesSurface, prompts: PromptScreen, "project-notes": NotesWorkspacePanel, "prompt-popover": PromptPopover };
}
