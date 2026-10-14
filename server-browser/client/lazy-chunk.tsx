import { createElement, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { ClientChunkManifest, createClientChunkRpc } from "../shared/client-chunk";

declare const require: (name: string) => unknown;
const hostRequire = require;
type Surfaces = Record<string, ComponentType<any>>;
interface Chunk { api: number; createSurfaces(client: PluginClientContext): Surfaces }
interface Options {
  rpc: ReturnType<typeof createClientChunkRpc>;
  manifest: ClientChunkManifest;
  label: string;
  fallback?: (id: string, props: any) => ReactNode;
}

// The host evaluates a fresh stub after reconnect. Only source text survives globally; promises, evaluated modules
// and client contexts belong to that stub instance, so the old query client can never leak into a new connection.
const CACHE_KEY = "__paseoClientChunkTextsV1";
const globalStore = globalThis as unknown as Record<string, Map<string, string> | undefined>;
const texts = globalStore[CACHE_KEY] ?? (globalStore[CACHE_KEY] = new Map<string, string>());

export function createChunkLoader(client: PluginClientContext, options: Options) {
  let pending: Promise<Surfaces> | undefined, loaded: Surfaces | undefined, textHash: string | undefined;
  const mismatch = () => new Error(`${options.label}界面与插件版本不一致，请重新连接后再打开`);
  const fetchText = async () => {
    const cached = texts.get(options.manifest.hash);
    if (cached !== undefined) { textHash = options.manifest.hash; return cached; }
    const first = await client.rpc(options.rpc, { name: options.manifest.name, hash: options.manifest.hash, part: 0 });
    if (first.api !== options.manifest.api) throw mismatch();
    if (first.name !== options.manifest.name || first.part !== 0 || first.parts < 1) throw new Error("界面分片无效，请重试");
    let code = first.code;
    for (let part = 1; part < first.parts; part++) {
      const reply = await client.rpc(options.rpc, { name: first.name, hash: first.hash, part });
      if (reply.api !== first.api || reply.hash !== first.hash || reply.name !== first.name || reply.part !== part || reply.parts !== first.parts) throw new Error("界面版本已更新，请重试或重新连接");
      code += reply.code;
    }
    textHash = first.hash;
    texts.set(first.hash, code);
    return code;
  };
  const load = () => {
    if (loaded) return Promise.resolve(loaded);
    if (pending) return pending;
    pending = fetchText().then((code) => {
      // The same indirect eval and host module resolver as Paseo uses for catalog bundles.
      const factory = (0, eval)(code) as (resolve: typeof hostRequire) => { default?: () => Chunk };
      const chunk = factory(hostRequire).default?.();
      if (chunk?.api !== options.manifest.api || typeof chunk.createSurfaces !== "function") throw mismatch();
      const surfaces = chunk.createSurfaces(client);
      if (!surfaces || typeof surfaces !== "object" || Array.isArray(surfaces) || Object.values(surfaces).some((value) => typeof value !== "function")) throw mismatch();
      loaded = surfaces;
      return loaded;
    }).catch((error: unknown) => { if (textHash) texts.delete(textHash); pending = undefined; throw error; });
    return pending;
  };
  return { load, peek: () => loaded };
}

/** Ordinary function components: screens, panels and timeline renderers all accept these without Suspense. */
export function lazySurfaces(client: PluginClientContext, options: Options): (id: string) => ComponentType<any> {
  const loader = createChunkLoader(client, options);
  return (id) => function LazySurface(props: any) {
    const [state, setState] = useState<{ Component?: ComponentType<any>; error?: string }>(() => ({ Component: loader.peek()?.[id] }));
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      if (state.Component) return;
      let live = true;
      loader.load().then((ready) => {
        if (live) setState(ready[id] ? { Component: ready[id] } : { error: "界面版本不一致，请重新连接" });
      }, (error: unknown) => { if (live) setState({ error: error instanceof Error ? error.message : String(error) }); });
      return () => { live = false; };
    }, [attempt]);
    if (state.Component) return createElement(state.Component, props);
    const colors = props.theme?.colors ?? {};
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 16 }}>
      {state.error ? <><Text style={{ color: colors.foreground }}>{options.label}加载失败：{state.error}</Text>
        <Pressable accessibilityRole="button" onPress={() => { setState({}); setAttempt((value) => value + 1); }}><Text style={{ color: colors.accent }}>重试</Text></Pressable></>
        : options.fallback ? options.fallback(id, props) : <><ActivityIndicator color={colors.foregroundMuted} /><Text style={{ color: colors.foregroundMuted }}>正在加载{options.label}…</Text></>}
    </View>;
  };
}
