import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { previewPort } from "./preview-port.mjs";

// Builds the fixture preview (synthetic notes, in-memory RPCs, no daemon). `--serve` serves it on 127.0.0.1, port 4693
// unless PROJECT_NOTES_PREVIEW_PORT says otherwise. Development only: the plugin never runs this.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "preview", "dist");
export const PREVIEW_PORT = previewPort();
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ["preview/index.jsx"], bundle: true, outfile: join(output, "app.js"), platform: "browser", format: "iife", target: ["es2020"], jsx: "automatic", logLevel: "warning",
  alias: { "react-native": "react-native-web", "@getpaseo/plugin/client": "./preview/adapter.jsx", "@getpaseo/plugin/client/react-native": "./preview/adapter.jsx" },
  define: { "process.env.NODE_ENV": '"development"', __DEV__: "true" },
});
await writeFile(join(output, "index.html"), await readFile(join(root, "preview", "index.html")));
console.log("拾页 fixture preview built (synthetic data, in-memory RPCs).");
if (process.argv.includes("--serve")) {
  const files = new Map([["/", "index.html"], ["/index.html", "index.html"], ["/app.js", "app.js"]]);
  const send = (response, status, body, type) => {
    if (!response.headersSent) response.writeHead(status, type ? { "Content-Type": type } : {});
    response.end(body);
  };
  // One bad request (a target like `//` that is not a valid URL, a missing build) answers 400 or 500; the server keeps running.
  const server = createServer(async (request, response) => {
    try {
      let pathname;
      try { pathname = new URL(request.url || "/", `http://127.0.0.1:${PREVIEW_PORT}`).pathname; }
      catch { send(response, 400, "Bad request\n", "text/plain; charset=utf-8"); return; }
      const file = files.get(pathname);
      if (!file) { send(response, 404); return; }
      send(response, 200, await readFile(join(output, file)), file.endsWith("html") ? "text/html; charset=utf-8" : "application/javascript; charset=utf-8");
    } catch (error) {
      console.error(`Preview request ${request.url} failed: ${error.message}`);
      send(response, 500, "Preview unavailable; run npm run preview:build\n", "text/plain; charset=utf-8");
    }
  });
  server.on("error", error => {
    console.error(error.code === "EADDRINUSE" ? `Port ${PREVIEW_PORT} is in use. Set PROJECT_NOTES_PREVIEW_PORT to another port.` : error.message);
    process.exit(1);
  });
  server.listen(PREVIEW_PORT, "127.0.0.1", () => console.log(`Fixture http://127.0.0.1:${PREVIEW_PORT}`));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
}
