import { createLocaleService } from "./server/i18n-server";
import { BUILTIN_CATALOGS } from "./server/locales";
import { registerClientChunks } from "./server/ui-chunk";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { BoardStore } from "./server/store";
import { DashboardService, ProjectDirectory, boardProjects } from "./server/dashboard";
import { projectsRpc, readBoardRpc, readDashboardRpc, readHistoryRpc, writeBoardRpc } from "./shared/board";
import { LaunchService, loadLaunchOptions } from "./server/launch";
import { launchOptionsRpc, launchRpc, launchStatusRpc } from "./shared/launch";
import { ComposerLibrary } from "./server/composer";
import { probeProject } from "./server/enhance";
import { promptEnvironmentRpc } from "./shared/enhance";
import { composerAttachmentsRpc, composerCapabilitiesRpc, composerSearchRpc, notesDeferred } from "./shared/composer";
import { DeferredSend } from "./server/deferred-send";
import { daemonHome, readSendCapabilities } from "./server/steerable-providers";

export default function contribute(server: PluginServerContext) {
  const locales = createLocaleService(server, { pluginId: "project-notes", builtins: BUILTIN_CATALOGS });
  const store = new BoardStore();
  const projects = new ProjectDirectory();
  const dashboard = new DashboardService(store, projects);
  const launches = new LaunchService(store, projects);
  const composer = new ComposerLibrary(store, projects);
  // One ledger for every prompt sent to an existing agent, sent now or queued for 「等这一轮结束再发」, in one file beside
  // the boards, kept across reloads. It plans a send now again from the daemon's provider config. After a reload it has
  // no daemon API until a call brings one, so every handler hands it over and delivery resumes with the next board or
  // picker read.
  const deferred = new DeferredSend({ file: join(daemonHome(), "plugin-data", "project-notes", "deferred-send.json"), capabilities: readSendCapabilities });
  const handle: PluginServerContext["handle"] = (contract, handler) => server.handle(contract, (input, context) => { deferred.use(context?.paseo); return handler(input, context); });
  registerClientChunks({ handle });
  handle(promptEnvironmentRpc, ({ projectId }, { paseo }) => probeProject(projectId, paseo, projects));
  handle(composerSearchRpc, (input, { paseo }) => composer.search(paseo, input.query, input.promptsOnly));
  handle(composerAttachmentsRpc, (input, { paseo }) => composer.attachments(paseo, input.query));
  handle(composerCapabilitiesRpc, async () => {
    const { steerable, slashSteerable, bases } = await readSendCapabilities();
    return { steerableProviders: steerable, slashSteerableProviders: slashSteerable, bases };
  });
  handle(notesDeferred.send, (input, { paseo }) => deferred.send(input, paseo));
  handle(notesDeferred.enqueue, (input, { paseo }) => deferred.enqueue(input, paseo));
  handle(notesDeferred.list, input => deferred.list(input));
  handle(notesDeferred.cancel, ({ messageId }) => deferred.cancel(messageId));
  handle(notesDeferred.resume, ({ messageId }, { paseo }) => deferred.resume(messageId, paseo));
  handle(launchOptionsRpc, (input, { paseo }) => loadLaunchOptions(paseo, input.projectId, () => projects.list(paseo)));
  handle(launchRpc, (input, { paseo }) => launches.start(input, paseo));
  handle(launchStatusRpc, (input, { paseo }) => launches.status(input.launchId, paseo));
  handle(projectsRpc, async (_input, { paseo }) => ({ projects: boardProjects(await projects.list(paseo)) }));
  handle(readBoardRpc, async ({ projectId }) => store.read(projectId));
  handle(readDashboardRpc, (input, { paseo }) => dashboard.read(paseo, input.revision, input.refreshProjectIds));
  handle(readHistoryRpc, input => store.readHistory(input.projectId, input.itemId));
  handle(writeBoardRpc, async input => store.write(input));
  return async () => { locales.dispose(); deferred.stop(); await launches.stop(); projects.stop(); };
}
