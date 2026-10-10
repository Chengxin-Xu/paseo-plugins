import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Builds the fixture preview (synthetic notes, in-memory RPCs, no daemon). `--serve` serves it on 127.0.0.1:4693.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "preview", "dist");
export const PREVIEW_PORT = 4693;
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ["preview/index.jsx"], bundle: true, outfile: join(output, "app.js"), platform: "browser", format: "iife", target: ["es2020"], jsx: "automatic", logLevel: "warning",
  alias: { "react-native": "react-native-web", "@getpaseo/plugin/client": "./preview/adapter.jsx", "@getpaseo/plugin/client/react-native": "./preview/adapter.jsx" },
  define: { "process.env.NODE_ENV": '"development"', __DEV__: "true" },
});
await writeFile(join(output, "index.html"), await readFile(join(root, "preview", "index.html")));
console.log("拾页 fixture preview built (synthetic data, in-memory RPCs).");
if (process.argv.includes("--serve")) {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", `http://127.0.0.1:${PREVIEW_PORT}`).pathname;
    const file = ({ "/": "index.html", "/index.html": "index.html", "/app.js": "app.js" })[pathname];
    if (!file) { response.writeHead(404); response.end(); return; }
    response.setHeader("Content-Type", file.endsWith("html") ? "text/html; charset=utf-8" : "application/javascript; charset=utf-8");
    response.end(await readFile(join(output, file)));
  });
  server.listen(PREVIEW_PORT, "127.0.0.1", () => console.log(`Fixture http://127.0.0.1:${PREVIEW_PORT}`));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
}
