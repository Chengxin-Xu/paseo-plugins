import type { PluginServerContext } from "@getpaseo/plugin/server";
import { BoardStore } from "./server/store";
import { DashboardService, ProjectDirectory, boardProjects } from "./server/dashboard";
import { projectsRpc, readBoardRpc, readDashboardRpc, writeBoardRpc } from "./shared/board";
import { LaunchService, loadLaunchOptions } from "./server/launch";
import { launchOptionsRpc, launchRpc, launchStatusRpc } from "./shared/launch";

export default function contribute(server: PluginServerContext) {
  const store = new BoardStore();
  const projects = new ProjectDirectory();
  const dashboard = new DashboardService(store, projects);
  const launches = new LaunchService(store, projects);
  server.handle(launchOptionsRpc, (input, { paseo }) => loadLaunchOptions(paseo, input.projectId, () => projects.list(paseo)));
  server.handle(launchRpc, (input, { paseo }) => launches.start(input, paseo));
  server.handle(launchStatusRpc, (input, { paseo }) => launches.status(input.launchId, paseo));
  server.handle(projectsRpc, async (_input, { paseo }) => ({ projects: boardProjects(await projects.list(paseo), "尚未归入项目的想法") }));
  server.handle(readBoardRpc, async ({ projectId }) => store.read(projectId));
  server.handle(readDashboardRpc, (input, { paseo }) => dashboard.read(paseo, input.revision));
  server.handle(writeBoardRpc, async input => store.write(input));
  return () => { launches.stop(); projects.stop(); };
}
