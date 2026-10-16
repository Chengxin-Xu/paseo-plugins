// Adapted from kingsleydon/paseo-plugins plugins/quick-prompts/client/pills.ts (MIT, see NOTICE): per agent, pills that
// keep their order update in place and the rest register again from the first change; sends are kept outside the
// registrations. Unlike the original, a pill never interrupts on its own: it goes through the plugin's send ledger.
import { t } from "../shared/text";
import type { PluginButton, PluginButtonContentProps, PluginButtonIcon, PluginButtonMenuEntry, PluginButtonRegistration, PluginComposerPillContribution } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { QUICK_PILL_LIMIT, pillLabel, quickRef, type QuickEntry } from "../shared/quick";
import type { AgentLite } from "./agent-directory";
import type { QuickSend } from "./quick-send";

/** What the user agrees to with 「中断并发送」 / 「仍然发送」 (the ledger's consent). */
export type QuickConsent = { interrupt: boolean; approvals: string[]; turn: string | null };
/** Why a pill asks first: the turn cannot take a message (interrupt), or approvals would be cancelled. */
export type QuickAsk = { approvals: boolean; consent: QuickConsent };

export interface QuickPillHost {
  addComposerPill(contribution: PluginComposerPillContribution): PluginButtonRegistration;
  /**
   * Sends through the plugin server (client/quick-send.ts, in a small chunk the first press loads). The host spins the
   * pill and disables it and its menu until the promise settles; failures are thrown and the host shows them.
   */
  send: QuickSend;
  /** A success toast. */
  notice(message: string): void;
  openManager(): void;
  /** The prompt picker opened on this prompt, for one with variables: the form its own pill opens. */
  fill(entry: QuickEntry): ComponentType<PluginButtonContentProps>;
  /**
   * The same form on a screen of its own, for a prompt with variables in the menu pill: a form inside the menu would
   * close whenever the menu changes with the agent's state (Paseo 0.11 closes an open menu on such an update).
   */
  openFill(agentId: string, entry: QuickEntry): void;
  icons: { send: PluginButtonIcon; ask: PluginButtonIcon; fill: PluginButtonIcon };
}

/**
 * Built-in providers whose running turns take a message (Paseo 0.11), as in send-plan.ts (kept apart: that module is not
 * resident); custom ids come from the server's capabilities.
 */
const STEERING = ["claude", "codex", "pi", "opencode", "omp"];

/**
 * Whether sending now would interrupt the turn or cancel approvals: then the pill asks first. Otherwise it sends at
 * once: an idle, unloaded or failed agent starts a turn; a running one that takes messages mid-turn gets it steered in.
 */
export function quickAsk(agent: Pick<AgentLite, "provider" | "status" | "pending" | "attention" | "turn">, steerable: ReadonlySet<string> | null): QuickAsk | null {
  const active = agent.status === "running" || agent.status === "initializing";
  const approvals = agent.pending.length > 0 || agent.attention === "permission";
  const steer = active && (STEERING.includes(agent.provider) || !!steerable?.has(agent.provider));
  return !approvals && (!active || steer) ? null : { approvals, consent: { interrupt: !steer, approvals: [...agent.pending], turn: agent.turn } };
}

type Pill = { id: string; content: string; registration: PluginButtonRegistration };
/** Every message a pill shows (complete ids, as the i18n audit wants). */
const WORDS = ["boot.quickSendTitle", "boot.quickAskTitle", "boot.quickFillTitle", "boot.quickMenuTitle", "boot.quickMenuLabel", "boot.quickMenuNarrow", "boot.quickManage", "boot.quickUntitled",
  "boot.quickWhyBusy", "boot.quickWhyApproval", "boot.quickAfterTurn", "boot.quickAfterApproval", "boot.quickInterrupt", "boot.quickSendAnyway"] as const;

/**
 * One-tap pills on every agent: one per prompt, or one menu pill for more than three. A pill sends at once when that
 * interrupts nothing; when the agent is busy or waits for approvals it opens 「等这一轮结束再发」 / 「中断并发送」; a prompt
 * with variables opens its fill form. A factory, not a class: Hermes (the phone app) rejects class syntax.
 */
export function createQuickPills(host: QuickPillHost) {
  /** Shown prompts; null until the list is read, so nothing flashes before. */
  let entries: QuickEntry[] | null = null, steerable: ReadonlySet<string> | null = null, textVersion = 0, narrow = false;
  const targets = new Map<string, AgentLite>(), registered = new Map<string, { workspaceId: string; pills: Pill[] }>();
  /** The server saw the agent busy before the directory did: ask for that turn, with the server's consent. */
  const overrides = new Map<string, { ask: QuickAsk; state: string; until: number }>();
  /** Presses still going (the chunk loading, the server answering): another press of the same prompt joins it. */
  const running = new Map<string, Promise<void>>();
  /** Prompts the server found variables in since the list was saved: their pills open the fill form from now on. */
  const templates = new Set<string>();
  const state = (agent: AgentLite) => `${agent.status}|${agent.turn}|${agent.pending.join()}`;
  // The pills' own words: only a change of these redraws them. The full catalog arriving with the same boot text must
  // not, since an update that replaces a behavior closes the menu or form the user has open.
  const words = () => WORDS.map(id => t(id, { title: "", count: 2 })).join("\n");
  let spoken = words();

  function askFor(agent: AgentLite): QuickAsk | null {
    const override = overrides.get(agent.id);
    if (override && override.until > Date.now() && override.state === state(agent)) return override.ask;
    overrides.delete(agent.id);
    return quickAsk(agent, steerable);
  }

  function run(agentId: string, entry: QuickEntry, options: { wait?: boolean; consent?: QuickConsent } = {}): Promise<void> {
    const slot = `${agentId}\n${quickRef(entry)}`, known = running.get(slot);
    if (known) return known;
    const done = host.send({ agentId, projectId: entry.projectId, itemId: entry.itemId, ...options }, {
      notice: host.notice,
      unconfirmed: error => t("boot.quickUnconfirmed", { title: entry.label, error }),
      notSent: error => t("boot.quickNotSent", { title: entry.label, error }),
      template: () => { templates.add(quickRef(entry)); syncAll(); },
      // The agent became busy since the pill was drawn: the next press asks, with the server's consent.
      confirm: consent => {
        const agent = targets.get(agentId);
        if (agent) { overrides.set(agentId, { ask: { approvals: consent.approvals.length > 0, consent }, state: state(agent), until: Date.now() + 120_000 }); sync(agentId); }
      },
    }).then(() => { running.delete(slot); }, (error: unknown) => { running.delete(slot); throw error; });
    running.set(slot, done);
    return done;
  }

  const named = (entry: QuickEntry) => entry.label || t("boot.quickUntitled");
  const askItems = (agentId: string, entry: QuickEntry, ask: QuickAsk): PluginButtonMenuEntry[] => [
    { kind: "item", id: "why", title: t(ask.approvals ? "boot.quickWhyApproval" : "boot.quickWhyBusy"), icon: "Info", disabled: true, behavior: { kind: "action", onPress: () => undefined } },
    { kind: "item", id: "wait", title: t(ask.approvals ? "boot.quickAfterApproval" : "boot.quickAfterTurn"), icon: "Clock3", behavior: { kind: "action", onPress: () => run(agentId, entry, { wait: true }) } },
    { kind: "item", id: "now", title: t(ask.approvals ? "boot.quickSendAnyway" : "boot.quickInterrupt"), icon: "Zap", behavior: { kind: "action", onPress: () => run(agentId, entry, { consent: ask.consent }) } },
  ];
  function pillButton(agentId: string, entry: QuickEntry, ask: QuickAsk | null): PluginButton {
    const label = pillLabel(named(entry)), title = named(entry);
    if (entry.template) return { title: t("boot.quickFillTitle", { title }), label, icon: host.icons.fill, behavior: { kind: "popover", Content: host.fill(entry) } };
    return ask ? { title: t("boot.quickAskTitle", { title }), label, icon: host.icons.ask, behavior: { kind: "menu", items: askItems(agentId, entry, ask) } }
      : { title: t("boot.quickSendTitle", { title }), label, icon: host.icons.send, behavior: { kind: "action", onPress: () => run(agentId, entry) } };
  }
  function menuButton(agentId: string, shown: QuickEntry[], ask: QuickAsk | null): PluginButton {
    const items = shown.map((entry, index): PluginButtonMenuEntry => ({ kind: "item", id: `p${index}`, title: pillLabel(named(entry), 40), icon: entry.template ? "Braces" : ask ? "Clock3" : "Zap",
      behavior: entry.template ? { kind: "action", onPress: () => host.openFill(agentId, entry) } : ask ? { kind: "menu", items: askItems(agentId, entry, ask) } : { kind: "action", onPress: () => run(agentId, entry) } }));
    // Narrow: the shortest label the language allows, so the row keeps room for the other plugins' pills.
    return { title: t("boot.quickMenuTitle"), label: t(narrow ? "boot.quickMenuNarrow" : "boot.quickMenuLabel", { count: shown.length }), icon: ask ? host.icons.ask : host.icons.send, behavior: { kind: "menu", items: [...items,
      { kind: "separator", id: "manage-line" }, { kind: "item", id: "manage", title: t("boot.quickManage"), icon: "Settings2", behavior: { kind: "action", onPress: () => host.openManager() } }] } };
  }
  function specs(agent: AgentLite): { id: string; content: string; button(): PluginButton }[] {
    if (!entries?.length) return [];
    const shown = entries.map(entry => templates.has(quickRef(entry)) ? { ...entry, template: true } : entry), ask = askFor(agent), mode = ask ? JSON.stringify(ask) : "";
    // A narrow window (a phone) has one pill row for every plugin: one menu pill there, else up to three separate ones.
    if (narrow || shown.length > QUICK_PILL_LIMIT) return [{ id: "quick-menu", content: JSON.stringify([textVersion, shown, mode]), button: () => menuButton(agent.id, shown, ask) }];
    return shown.map(entry => ({ id: `quick-${entry.itemId}`, content: JSON.stringify([textVersion, entry, entry.template ? "" : mode]), button: () => pillButton(agent.id, entry, ask) }));
  }

  function clear(agentId: string) {
    for (const pill of registered.get(agentId)?.pills ?? []) pill.registration.remove();
    registered.delete(agentId);
  }
  /** Same place, same id: update when it changed. From the first difference on: register again (order is display order). */
  function sync(agentId: string) {
    const agent = targets.get(agentId), workspaceId = agent?.workspaceId;
    if (!agent || !workspaceId || entries === null) return clear(agentId);
    if (registered.get(agentId)?.workspaceId !== workspaceId) clear(agentId);
    const current = registered.get(agentId)?.pills ?? [], next = specs(agent), kept: Pill[] = [];
    let index = 0;
    for (; index < current.length && index < next.length && current[index]!.id === next[index]!.id; index++) {
      const pill = current[index]!, spec = next[index]!;
      // The whole button: a changed menu needs its complete new behavior.
      if (pill.content !== spec.content) { pill.content = spec.content; pill.registration.update(spec.button()); }
      kept.push(pill);
    }
    for (const pill of current.slice(index)) pill.registration.remove();
    for (const spec of next.slice(index)) kept.push({ id: spec.id, content: spec.content, registration: host.addComposerPill({ id: spec.id, workspaceId, agentId, button: spec.button() }) });
    if (kept.length) registered.set(agentId, { workspaceId, pills: kept }); else registered.delete(agentId);
  }
  const syncAll = () => { for (const agentId of [...targets.keys()]) sync(agentId); };
  return {
    /** The list in order; hidden entries get no pill. */
    setEntries(list: readonly QuickEntry[]) { entries = list.filter(entry => !entry.hidden); syncAll(); },
    /** Providers (custom ids too) whose turns take a message mid-turn, from the server. */
    setSteerable(ids: readonly string[]) { steerable = new Set(ids); syncAll(); },
    setAgent(agent: AgentLite) { targets.set(agent.id, agent); sync(agent.id); },
    removeAgent(agentId: string) { targets.delete(agentId); overrides.delete(agentId); clear(agentId); },
    refreshText() { const next = words(); if (next !== spoken) { spoken = next; textVersion++; syncAll(); } },
    /** A narrow window (rotation, a folding screen, a resized window): the pills fold into the menu pill, or unfold. */
    setNarrow(value: boolean) { if (value !== narrow) { narrow = value; syncAll(); } },
    /** Whether a prompt shows (the server's capabilities matter only then). */
    active: () => !!entries?.length,
    removeAll() { for (const agentId of [...registered.keys()]) clear(agentId); targets.clear(); overrides.clear(); },
  };
}
