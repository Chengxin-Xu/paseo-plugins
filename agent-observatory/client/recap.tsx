import { t } from "../shared/text";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { RecapLook } from "../shared/recap";
import { Badge, fontSize, gradient, hairline, hue, radius, relativeTime, space, withAlpha } from "./kit";
import { Breathe, Sweep } from "./motion";

/** The recap mark: a four-pointed star in fuchsia, breathing while a new recap is being written, grey once it is out of date. */
export function RecapMark({ theme, look, size = 12 }: { theme: PluginTheme; look: Pick<RecapLook, "state">; size?: number }) {
  const mark = <Text style={{ color: look.state === "stale" ? theme.colors.foregroundMuted : hue(theme, "fuchsia"), fontSize: size, lineHeight: size + 4, fontWeight: "800" }}>✦</Text>;
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{look.state === "updating" ? <Breathe>{mark}</Breathe> : mark}</View>;
}

/** What a screen reader says for a recap line or card. */
function recapLabel(look: RecapLook): string {
  const parts = [look.summary ?? t("recap.writingFirst"), look.next ? t("recap.nextSpoken", { next: look.next }) : null];
  const state = look.state === "updating" ? t("recap.updating") : look.state === "stale" ? t("recap.stale") : null, text = parts.filter(Boolean).join(" ");
  return state ? t("recap.spokenState", { state, text }) : t("recap.spoken", { text });
}

/**
 * 每轮小结 under a session's title and in the badge's popover: ✦, the goal and progress, then → the next step in violet, in at
 * most `lines` lines. Out of date (a turn since) it turns grey and says so; while a new one is written it says 更新中 and the star
 * breathes. The whole recap is in the session's detail.
 */
export function RecapLine({ theme, look, lines = 2 }: { theme: PluginTheme; look: RecapLook; lines?: number }) {
  const { colors } = theme, stale = look.state === "stale", updating = look.state === "updating";
  return <View accessible accessibilityLabel={recapLabel(look)} testID="recap-line" style={{ flexDirection: "row", alignItems: "flex-start", gap: 5, minWidth: 0 }}>
    <RecapMark theme={theme} look={look} />
    <Text numberOfLines={lines} style={{ flex: 1, minWidth: 0, color: stale ? colors.foregroundMuted : colors.foreground, fontSize: fontSize.meta, lineHeight: 16, opacity: updating && look.summary ? 0.8 : 1 }}>
      {updating ? <Text style={{ color: hue(theme, "fuchsia", "text"), fontWeight: "700" }}>{look.summary ? `${t("recap.updating")} · ` : t("recap.writingFirst")}</Text>
        : stale ? <Text style={{ fontWeight: "700" }}>{`${t("recap.stale")} · `}</Text> : null}
      {look.summary ?? ""}
      {/* The next step after an arrow (a no-break space keeps them together), in violet. */}
      {look.next ? <Text style={{ color: stale ? colors.foregroundMuted : hue(theme, "violet", "text"), fontWeight: "600" }}>{`  →\u00a0${look.next}`}</Text> : null}
    </Text>
  </View>;
}

/**
 * 每轮小结 at the top of a session's detail, in full: a fuchsia-to-violet card with the goal and progress, the next step and
 * who wrote it. While a new one is written a bar sweeps along its bottom; out of date it fades and says so.
 */
export function RecapCard({ theme, look }: { theme: PluginTheme; look: RecapLook }) {
  const { colors } = theme, stale = look.state === "stale", updating = look.state === "updating", fuchsia = hue(theme, "fuchsia");
  return <View accessible accessibilityLabel={recapLabel(look)} testID="recap-card" style={[{ borderRadius: radius.lg, borderWidth: hairline, borderColor: withAlpha(fuchsia, stale ? 0.2 : 0.45), overflow: "hidden" },
    stale ? { backgroundColor: colors.surface1 } : gradient(theme, [withAlpha(fuchsia, 0.2), withAlpha(hue(theme, "violet"), 0.07)], { angle: 120 })]}>
    <View style={{ padding: space.md, gap: space.xs + 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <RecapMark theme={theme} look={look} size={14} />
        <Text style={{ color: stale ? colors.foregroundMuted : hue(theme, "fuchsia", "text"), fontSize: fontSize.small, fontWeight: "800" }}>{t("recap.title")}</Text>
        {updating ? <Badge theme={theme} label={t("recap.updating")} tone="fuchsia" /> : stale ? <Badge theme={theme} label={t("recap.staleLong")} tone="neutral" /> : null}
        <View style={{ flex: 1 }} />
        {look.at ? <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{relativeTime(look.at)}</Text> : null}
      </View>
      {look.summary ? <Text selectable style={{ color: stale ? colors.foregroundMuted : colors.foreground, fontSize: fontSize.body, lineHeight: 21, fontWeight: "600" }}>{look.summary}</Text>
        : <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small }}>{t("recap.writingFirst")}</Text>}
      {look.next ? <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
        <Text style={{ color: stale ? colors.foregroundMuted : hue(theme, "violet", "text"), fontSize: fontSize.small, lineHeight: 19, fontWeight: "800" }}>{t("recap.next")}</Text>
        <Text selectable style={{ flex: 1, minWidth: 0, color: stale ? colors.foregroundMuted : colors.foreground, fontSize: fontSize.small, lineHeight: 19 }}>{look.next}</Text>
      </View> : null}
      {look.runner ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>{t("recap.writtenBy", { runner: look.runner })}</Text> : null}
    </View>
    {updating ? <Sweep color={fuchsia} track={withAlpha(fuchsia, 0.12)} height={2} /> : null}
  </View>;
}
