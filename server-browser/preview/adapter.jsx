// Preview stand-ins for the host APIs: real Lucide icons, host-shaped modal sheets and toasts, a fixture RPC.
import * as Lucide from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { rpc } from "./fixtures.js";

export { FlatList, ScrollView, TextInput };
globalThis.__missingIcons = new Set();
export function Icon({ name, size = 16, color = "currentColor" }) {
  const Glyph = Lucide[name] ?? Lucide[`${name}Icon`];
  if (!Glyph) globalThis.__missingIcons.add(name);
  const Resolved = Glyph ?? Lucide.Circle;
  return <Resolved size={size} color={color} strokeWidth={1.75} style={{ flexShrink: 0 }} aria-hidden="true" />;
}

const compact = () => innerWidth < 700;
/** Mirrors the host's AdaptiveModalSheet: a centered card on desktop, a bottom sheet on phones. */
export function Modal({ title, open, onOpenChange, children }) {
  useEffect(() => {
    if (!open) return;
    const key = event => { if (event.key === "Escape") onOpenChange(false); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, onOpenChange]);
  if (!open) return null;
  const { colors } = globalThis.__previewTheme;
  const sheet = compact();
  return <View style={{ position: "fixed", inset: 0, zIndex: 50, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: sheet ? "flex-end" : "center", padding: sheet ? 0 : 24 }}>
    <Pressable accessibilityLabel="关闭弹层背景" onPress={() => onOpenChange(false)} style={{ position: "absolute", inset: 0 }} />
    <View role="dialog" aria-label={title} style={[{ width: "100%", maxHeight: "85%", overflow: "hidden" }, sheet ? { backgroundColor: colors.surface0, borderTopLeftRadius: 16, borderTopRightRadius: 16 } : { maxWidth: 520, backgroundColor: colors.surface1, borderRadius: 12, borderWidth: 1, borderColor: colors.surface2 }]}>
      {sheet ? <View style={{ alignSelf: "center", width: 36, height: 4, borderRadius: 2, marginTop: 8, backgroundColor: colors.surface2 }} /> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 24, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.surface2 }}>
        <Text style={{ flex: 1, color: colors.foreground, fontSize: 14, fontWeight: "500" }}>{title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={() => onOpenChange(false)} style={{ padding: 8, margin: -8, borderRadius: 8 }}><Icon name="X" size={16} color={colors.foregroundMuted} /></Pressable>
      </View>
      {children}
    </View>
  </View>;
}
Modal.Content = function Content({ children, contentContainerStyle, scrollable = true }) {
  return scrollable ? <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={[{ padding: 24, gap: 16 }, contentContainerStyle]}>{children}</ScrollView> : <View style={[{ padding: 24, gap: 16, flexShrink: 1 }, contentContainerStyle]}>{children}</View>;
};

const toastListeners = new Set();
globalThis.__toasts = [];
const pushToast = (message, variant) => { globalThis.__toasts.push({ message, variant }); for (const listener of toastListeners) listener({ message, variant, at: Date.now() }); };
export function useToast() { return useMemo(() => ({ show: (message, options) => pushToast(message, options?.variant ?? "default"), error: message => pushToast(message, "error") }), []); }
export function ToastHost() {
  const [toast, setToast] = useState(null);
  useEffect(() => { const listener = value => setToast(value); toastListeners.add(listener); return () => { toastListeners.delete(listener); }; }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 2600); return () => clearTimeout(timer); }, [toast]);
  if (!toast) return null;
  const { colors } = globalThis.__previewTheme;
  return <View pointerEvents="none" style={{ position: "fixed", left: 0, right: 0, bottom: 24, alignItems: "center", zIndex: 80 }}>
    <View accessibilityRole="alert" style={{ maxWidth: 360, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border }}>
      <Text style={{ color: toast.variant === "error" ? colors.statusDanger : colors.foreground, fontSize: 13 }}>{toast.message}</Text>
    </View>
  </View>;
}
export async function copyText(text) { globalThis.__clipboard = text; }

export function useRpc(contract) { return useMemo(() => async input => contract.output.parse(await rpc(contract.name, contract.input.parse(input))), [contract]); }
globalThis.__opened = [];
export async function openExternalUrl(url) { globalThis.__opened.push(url); }
