// Preview stand-ins for the Paseo host modules. Real Lucide icons (the host resolves the same names from
// lucide-react-native), a modal that mimics the host's adaptive sheet (520 px dialog on desktop, 65 % bottom sheet
// below 720 px), toasts, clipboard and RPCs against the in-memory fixture server. Nothing leaves the page.
import * as Lucide from "lucide-react";
import { Children, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { call } from "./fixtures.js";

export { FlatList, ScrollView, TextInput };

export function Icon({ name, size = 16, color = "currentColor" }) {
  const Glyph = Lucide[name];
  if (!Glyph || name === "Icon" || name === "createLucideIcon") { console.error(`Unknown Lucide icon: ${name}`); return null; }
  return <Glyph size={size} color={color} strokeWidth={2} style={{ flexShrink: 0, display: "block" }} aria-hidden="true" />;
}

export function useRpc(contract) {
  return useMemo(() => async input => contract.output.parse(await call(contract.name, await contract.input.parseAsync(input))), [contract]);
}
export function useWorkspace(_workspaceId, select) {
  return select({ id: "wks_fixture", projectId: "prj_web", projectDisplayName: "web-app", cwd: "/home/user/projects/web-app" });
}

// ── Toasts ──────────────────────────────────────────────────────────────────────────────────────────────
const toastListeners = new Set();
let toasts = [];
globalThis.__notesToasts = [];
function pushToast(message, variant) {
  const toast = { id: Math.random().toString(36).slice(2), message, variant };
  globalThis.__notesToasts.push({ message, variant });
  toasts = [...toasts, toast].slice(-3);
  toastListeners.forEach(listener => listener());
  setTimeout(() => { toasts = toasts.filter(item => item !== toast); toastListeners.forEach(listener => listener()); }, 2600);
}
const toastApi = { show: (message, options) => pushToast(message, options?.variant ?? "default"), error: message => pushToast(message, "error") };
export function useToast() { return toastApi; }
export function Toasts({ theme }) {
  const list = useSyncExternalStore(listener => { toastListeners.add(listener); return () => toastListeners.delete(listener); }, () => toasts);
  if (!list.length) return null;
  return <View style={{ pointerEvents: "none", position: "fixed", left: 0, right: 0, bottom: 24, alignItems: "center", gap: 8, zIndex: 1000 }}>
    {list.map(toast => <View key={toast.id} accessibilityRole="status" style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, backgroundColor: theme.colors.surface2, borderWidth: 1, borderColor: theme.colors.border, boxShadow: "0 6px 24px rgba(0,0,0,0.25)" }}>
      <Icon name={toast.variant === "error" ? "CircleAlert" : "CircleCheck"} size={16} color={toast.variant === "error" ? theme.colors.statusDanger : theme.colors.statusSuccess} />
      <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{toast.message}</Text>
    </View>)}
  </View>;
}

globalThis.__clipboard = null;
globalThis.__notesCopies = [];
export async function copyText(text) {
  if (new URLSearchParams(location.search).get("scenario") === "copy-error") throw new Error("剪贴板不可用");
  globalThis.__clipboard = text; globalThis.__notesCopies.push(text);
}

// ── Modal: mirrors packages/app/src/components/adaptive-modal-sheet.tsx ────────────────────────────────────
const isCompact = () => globalThis.innerWidth < 720;
function useCompactViewport() {
  const [compact, setCompact] = useState(isCompact);
  useEffect(() => { const resize = () => setCompact(isCompact()); addEventListener("resize", resize); return () => removeEventListener("resize", resize); }, []);
  return compact;
}
export function Modal({ title, icon, open, onOpenChange, children }) {
  const compact = useCompactViewport();
  useEffect(() => {
    if (!open) return;
    const key = event => { if (event.key === "Escape") onOpenChange(false); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, onOpenChange]);
  if (!open) return null;
  const { colors } = globalThis.__previewTheme;
  // Like the host: a bounded (non-scrollable) body gets an 85 % tall card on desktop.
  const bounded = Children.toArray(children).some(child => child?.props?.scrollable === false);
  const header = <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 24, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.surface2 }}>
    {icon ? <View style={{ alignItems: "center", justifyContent: "center" }}>{icon}</View> : null}
    <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 14, fontWeight: "500" }}>{title}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={() => onOpenChange(false)} style={{ padding: 8, margin: -8, borderRadius: 8 }}><Icon name="X" size={16} color={colors.foregroundMuted} /></Pressable>
  </View>;
  if (compact) {
    return <View style={{ position: "fixed", inset: 0, zIndex: 50 }}>
      <Pressable accessibilityLabel="收起" onPress={() => onOpenChange(false)} style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.45)" }} />
      <View role="dialog" aria-label={title} style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "65%", backgroundColor: colors.surface0, borderTopLeftRadius: 16, borderTopRightRadius: 16, overflow: "hidden" }}>
        <View style={{ alignItems: "center", paddingTop: 8, paddingBottom: 2 }}><View style={{ width: 32, height: 4, borderRadius: 2, backgroundColor: "#52525b" }} /></View>
        {header}
        {children}
      </View>
    </View>;
  }
  return <View style={{ position: "fixed", inset: 0, zIndex: 50, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", padding: 24 }}>
    <Pressable accessibilityLabel="收起" onPress={() => onOpenChange(false)} style={{ position: "absolute", inset: 0 }} />
    <View role="dialog" aria-label={title} style={{ width: "100%", maxWidth: 520, maxHeight: "85%", ...(bounded ? { height: "85%" } : {}), flexShrink: 1, minHeight: 0, overflow: "hidden", backgroundColor: colors.surface1, borderRadius: 12, borderWidth: 1, borderColor: colors.surface2 }}>
      {header}
      {children}
    </View>
  </View>;
}
Modal.Content = function Content({ children, style, contentContainerStyle, scrollable = true }) {
  const inset = [{ padding: 24, gap: 16, flexGrow: 1 }, contentContainerStyle];
  if (!scrollable) return <View style={[{ flex: 1, minHeight: 0 }, style]}><View style={[inset, { flex: 1, minHeight: 0 }]}>{children}</View></View>;
  return <View style={[{ flexShrink: 1, minHeight: 0 }, style]}><ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1, minHeight: 0 }} contentContainerStyle={{ flexGrow: 1 }}><View style={inset}>{children}</View></ScrollView></View>;
};
