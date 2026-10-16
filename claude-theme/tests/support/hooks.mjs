/**
 * Module hooks for `node --test`, so tests run on Node alone (no bundler, no test framework). Paseo compiles plugins
 * with esbuild, which accepts what plain Node does not:
 * - extensionless relative imports (`./i18n`), as kit files use;
 * - JSON imported without `with { type: "json" }`, including named top-level sections (`import { boot } from …`);
 * - `.txt` imported as text (the generated chunk);
 * - `.tsx`, compiled here with TypeScript (a dev dependency) since Node strips types but not JSX.
 * Modules the Paseo app supplies at run time (React Native and the client SDK's host parts) resolve to small stand-ins.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let typescript;

const STUBS = {
  "react-native": new URL("./stubs/react-native.mjs", import.meta.url).href,
  "@getpaseo/plugin/client": new URL("./stubs/client.mjs", import.meta.url).href,
  "@getpaseo/plugin/client/ui": new URL("./stubs/client-ui.mjs", import.meta.url).href,
  "@getpaseo/plugin/client/react-native": new URL("./stubs/client-react-native.mjs", import.meta.url).href,
};
const KNOWN_EXTENSION = /\.(?:[cm]?[jt]sx?|json|txt)$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(STUBS, specifier)) return { url: STUBS[specifier], shortCircuit: true };
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const base = new URL(specifier, context.parentURL);
    if (!KNOWN_EXTENSION.test(base.pathname)) {
      for (const extension of [".ts", ".tsx"]) {
        const candidate = new URL(`${base.href}${extension}`);
        if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".json")) {
    const data = JSON.parse(await readFile(new URL(url), "utf8"));
    const names = Object.keys(data).filter((name) => IDENTIFIER.test(name) && name !== "default");
    const exports = names.map((name) => `export const ${name} = data[${JSON.stringify(name)}];`).join("\n");
    return { format: "module", source: `const data = ${JSON.stringify(data)};\nexport default data;\n${exports}\n`, shortCircuit: true };
  }
  if (url.startsWith("file:") && url.endsWith(".txt")) {
    return { format: "module", source: `export default ${JSON.stringify(await readFile(new URL(url), "utf8"))};\n`, shortCircuit: true };
  }
  if (url.startsWith("file:") && url.endsWith(".tsx")) {
    typescript ??= require("typescript");
    const ts = typescript;
    const { outputText } = ts.transpileModule(await readFile(new URL(url), "utf8"), {
      fileName: fileURLToPath(url),
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, allowImportingTsExtensions: true },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
