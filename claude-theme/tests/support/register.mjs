// Loaded with `node --import`: teaches Node's test runner the module shapes Paseo's bundler accepts (see hooks.mjs).
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);

// Paseo evaluates client bundles inside a CommonJS wrapper whose `require` serves the app's modules; the lazy-chunk
// loader keeps a reference to it at load. Tests evaluate chunks with their own resolver, so this one only refuses.
globalThis.require ??= (name) => {
  throw new Error(`Module "${name}" is only available inside the Paseo app`);
};
