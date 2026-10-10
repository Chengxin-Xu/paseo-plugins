import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { MAX_READ_IMAGE_BYTES } from "../shared/read-image.js";
import { handleReadImage, imageRoots, isInside, resolveAbsolutePath } from "./read-image.js";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function contextWithCwd(cwd: string | null): PluginHandlerContext {
  return {
    paseo: {
      agents: {
        ref: () => ({
          refresh: async () => undefined,
          cwd,
        }),
      },
    },
  } as unknown as PluginHandlerContext;
}

/**
 * A sandbox with an agent workspace, a stand-in temp directory and an "elsewhere" directory that is
 * neither. The real system temp is not passed as a root, so the containment rules are what decide.
 */
function withSandbox(run: (dirs: { root: string; cwd: string; temp: string; elsewhere: string }) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "read-image-test-"));
  const dirs = { root, cwd: join(root, "workspace"), temp: join(root, "temp"), elsewhere: join(root, "elsewhere") };
  for (const dir of [dirs.cwd, dirs.temp, dirs.elsewhere]) mkdirSync(dir);
  return (async () => {
    await run(dirs);
  })().finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
}

const read = (filePath: string, cwd: string | null, temp: string[], agentId: string | undefined = "agent-1") =>
  handleReadImage({ filePath, ...(agentId ? { agentId } : {}) }, contextWithCwd(cwd), temp);

describe("resolveAbsolutePath", () => {
  it("keeps absolute paths and resolves relative paths against the agent cwd", () => {
    expect(resolveAbsolutePath("/tmp/a.png", null)).toBe("/tmp/a.png");
    expect(resolveAbsolutePath("shot.png", "/work/dir")).toBe(join("/work/dir", "shot.png"));
  });

  it("returns null for blank paths and relative paths without a cwd", () => {
    expect(resolveAbsolutePath("   ", "/work")).toBeNull();
    expect(resolveAbsolutePath("shot.png", null)).toBeNull();
  });
});

describe("isInside", () => {
  it("accepts the root and anything below it", () => {
    expect(isInside("/work", "/work")).toBe(true);
    expect(isInside("/work", "/work/a/b.png")).toBe(true);
    expect(isInside("/work", "/work/..png")).toBe(true);
  });

  it("rejects siblings, parents and dot-dot escapes", () => {
    expect(isInside("/work", "/work2/a.png")).toBe(false);
    expect(isInside("/work", "/")).toBe(false);
    expect(isInside("/work", "/work/../etc/passwd")).toBe(false);
    expect(isInside("/work/a", "/work/b/c.png")).toBe(false);
  });
});

describe("imageRoots", () => {
  it("uses the agent cwd and temp roots, resolving links, and skips missing or relative roots", async () => {
    await withSandbox(async ({ root, cwd, temp }) => {
      const link = join(root, "cwd-link");
      symlinkSync(cwd, link);
      const roots = await imageRoots(link, [temp, join(root, "missing"), "relative/dir"]);
      expect(roots.lexical).toEqual([link, temp, join(root, "missing")]);
      expect(roots.real).toEqual([cwd, temp].map((dir) => execFileSync("realpath", [dir]).toString().trim()));
    });
  });
});

describe("handleReadImage", () => {
  it("returns base64 for an image in the agent cwd", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      const file = join(cwd, "shot.png");
      writeFileSync(file, PNG_BYTES);
      const result = await read(file, cwd, [temp]);
      expect(result.status).toBe("ok");
      expect(result.mimeType).toBe("image/png");
      expect(result.byteSize).toBe(PNG_BYTES.length);
      expect(Buffer.from(result.data ?? "", "base64").equals(PNG_BYTES)).toBe(true);
    });
  });

  it("resolves relative paths against the agent cwd", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      mkdirSync(join(cwd, "shots"));
      writeFileSync(join(cwd, "shots", "shot.png"), PNG_BYTES);
      expect((await read("shots/shot.png", cwd, [temp])).status).toBe("ok");
    });
  });

  it("reads screenshots from the temp directory, even without an agent", async () => {
    await withSandbox(async ({ temp }) => {
      const file = join(temp, "screenshot.png");
      writeFileSync(file, PNG_BYTES);
      expect((await read(file, null, [temp], undefined)).status).toBe("ok");
    });
  });

  it("refuses images outside the agent cwd and temp directories without revealing whether they exist", async () => {
    await withSandbox(async ({ cwd, temp, elsewhere }) => {
      const file = join(elsewhere, "secret.png");
      writeFileSync(file, PNG_BYTES);
      const existing = await read(file, cwd, [temp]);
      const missing = await read(join(elsewhere, "missing.png"), cwd, [temp]);
      expect(existing).toEqual({ status: "outside" });
      expect(missing).toEqual({ status: "outside" });
    });
  });

  it("refuses dot-dot escapes from the cwd", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      writeFileSync(join(cwd, "..", "elsewhere", "secret.png"), PNG_BYTES);
      expect((await read("../elsewhere/secret.png", cwd, [temp])).status).toBe("outside");
      expect((await read(join(cwd, "..", "elsewhere", "secret.png"), cwd, [temp])).status).toBe("outside");
    });
  });

  it("follows links by their real target: a link out of the cwd is refused, a link into it is allowed", async () => {
    await withSandbox(async ({ cwd, temp, elsewhere }) => {
      writeFileSync(join(elsewhere, "secret.png"), PNG_BYTES);
      symlinkSync(join(elsewhere, "secret.png"), join(cwd, "innocent.png"));
      symlinkSync(elsewhere, join(cwd, "linked-dir"));
      expect((await read(join(cwd, "innocent.png"), cwd, [temp])).status).toBe("outside");
      expect((await read("linked-dir/secret.png", cwd, [temp])).status).toBe("outside");
      writeFileSync(join(cwd, "real.png"), PNG_BYTES);
      symlinkSync(join(cwd, "real.png"), join(cwd, "alias.png"));
      expect((await read("alias.png", cwd, [temp])).status).toBe("ok");
    });
  });

  it("refuses absolute paths when the agent is unknown and the file is not in a temp directory", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      const file = join(cwd, "shot.png");
      writeFileSync(file, PNG_BYTES);
      expect((await read(file, null, [temp], undefined)).status).toBe("outside");
    });
  });

  it("falls back to the temp directories alone when the agent id cannot be resolved", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      const unknownAgent = {
        paseo: { agents: { ref: () => ({ refresh: async () => { throw new Error("Agent not found"); }, cwd: null }) } },
      } as unknown as PluginHandlerContext;
      writeFileSync(join(cwd, "shot.png"), PNG_BYTES);
      writeFileSync(join(temp, "shot.png"), PNG_BYTES);
      const call = (filePath: string) => handleReadImage({ filePath, agentId: "no-such-agent" }, unknownAgent, [temp]);
      expect((await call(join(cwd, "shot.png"))).status).toBe("outside");
      expect((await call("shot.png")).status).toBe("unavailable");
      expect((await call(join(temp, "shot.png"))).status).toBe("ok");
    });
  });

  it("reports not-found for missing files and directories inside the roots", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      expect((await read(join(cwd, "missing.png"), cwd, [temp])).status).toBe("not-found");
      expect((await read(cwd, cwd, [temp])).status).toBe("not-found");
    });
  });

  it("does not block on a FIFO", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      const fifo = join(cwd, "pipe.png");
      execFileSync("mkfifo", [fifo]);
      expect((await read(fifo, cwd, [temp])).status).toBe("not-found");
    });
  });

  it("reports not-image for text files", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      writeFileSync(join(cwd, "notes.md"), "# hello\n");
      expect((await read("notes.md", cwd, [temp])).status).toBe("not-image");
    });
  });

  it("reports too-large without reading the file", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      const file = join(cwd, "huge.png");
      writeFileSync(file, Buffer.alloc(MAX_READ_IMAGE_BYTES + 1, 0));
      const result = await read(file, cwd, [temp]);
      expect(result.status).toBe("too-large");
      expect(result.byteSize).toBe(MAX_READ_IMAGE_BYTES + 1);
      expect(result.data).toBeUndefined();
    });
  });

  it("reports unavailable for relative paths without an agent cwd", async () => {
    const result = await handleReadImage({ filePath: "shot.png" }, contextWithCwd(null));
    expect(result.status).toBe("unavailable");
  });

  it("allows the system temp directory by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "read-image-default-"));
    try {
      writeFileSync(join(dir, "shot.png"), PNG_BYTES);
      const result = await handleReadImage({ filePath: join(dir, "shot.png") }, contextWithCwd(null));
      expect(result.status).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
