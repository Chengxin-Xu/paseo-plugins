import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "preview", "dist");
const port = Number(process.env.SERVER_BROWSER_PREVIEW_PORT) || 4196;
await mkdir(output, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ["preview/index.jsx"], bundle: true, outfile: join(output, "app.js"), platform: "browser", format: "iife", target: ["es2020"], jsx: "automatic", logLevel: "warning", loader: { ".jpg": "dataurl" }, alias: { "react-native": "react-native-web", "@getpaseo/plugin/client": "./preview/adapter.jsx", "@getpaseo/plugin/client/react-native": "./preview/adapter.jsx" }, define: { "process.env.NODE_ENV": '"development"', __DEV__: "true" } });
await writeFile(join(output, "index.html"), await readFile(join(root, "preview", "index.html")));
console.log("Server browser fixture built (synthetic data, no daemon).");
if (process.argv.includes("--serve")) {
  const server = createServer(async (request, response) => {
    // One bad request (an unparsable target, a missing build) answers with an error instead of stopping the preview.
    let pathname;
    try { pathname = new URL(request.url || "/", `http://127.0.0.1:${port}`).pathname; }
    catch { response.writeHead(400); response.end(); return; }
    const file = ({ "/": "index.html", "/index.html": "index.html", "/app.js": "app.js" })[pathname];
    if (!file) { response.writeHead(404); response.end(); return; }
    try {
      const body = await readFile(join(output, file));
      response.setHeader("Content-Type", file.endsWith("html") ? "text/html; charset=utf-8" : "application/javascript; charset=utf-8");
      response.end(body);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`Fixture http://127.0.0.1:${port}`));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
}
