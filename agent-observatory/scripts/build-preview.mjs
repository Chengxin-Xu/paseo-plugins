import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "preview", "dist");
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["preview/index.jsx"], bundle: true, outfile: join(output, "app.js"), platform: "browser",
  format: "iife", target: ["es2020"], sourcemap: true, jsx: "automatic", logLevel: "warning",
  alias: { "react-native": "react-native-web", "@getpaseo/plugin/client": "./preview/sdk-adapter.jsx",
    "@getpaseo/plugin/client/react-native": "./preview/sdk-adapter.jsx" },
  define: { "process.env.NODE_ENV": '"development"', __DEV__: "true" },
});
await writeFile(join(output, "index.html"), await readFile(join(root, "preview", "index.html")));
console.log("Built development fixture preview in preview/dist (synthetic data only).");

if (process.argv.includes("--serve")) {
  const port = Number(process.env.OBSERVATORY_PREVIEW_PORT ?? 4177);
  const allowed = new Map([["/", "index.html"], ["/index.html", "index.html"], ["/app.js", "app.js"], ["/app.js.map", "app.js.map"]]);
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
    const file = allowed.get(pathname);
    if (!file) { response.writeHead(404); response.end("Not found"); return; }
    try {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".map") ? "application/json" : "application/javascript; charset=utf-8");
      response.end(await readFile(join(output, file)));
    } catch { response.writeHead(500); response.end("Preview asset unavailable"); }
  });
  server.listen(port, "127.0.0.1", () => console.log(`Development fixture preview: http://127.0.0.1:${port}`));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
}
