import { t } from "./text";
import { joinList } from "./i18n";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { BODY_MAX_LENGTH } from "./schema";

export const environmentSchema = z.object({ languages: z.array(z.string()), testCommands: z.array(z.string()), notices: z.array(z.string()) });
export type ProjectEnvironment = z.infer<typeof environmentSchema>;
export const promptEnvironmentRpc = defineRpc({
  name: "project-notes.prompt.environment", input: z.object({ projectId: z.string().min(1).max(500) }), output: environmentSchema,
});

/** Keep the original draft verbatim; add only the sections it does not already contain. */
export function structurePrompt(title: string, body: string, environment: ProjectEnvironment): string {
  let fence = "", fenceLength = 0;
  const headings = body.split(/\r?\n/).filter(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) { fence = marker[0]!; fenceLength = marker.length; }
      else if (marker[0] === fence && marker.length >= fenceLength && /^[`~]+[ \t]*$/.test(line.trim())) fence = "";
      return false;
    }
    return !fence;
  }).join("\n");
  // i18n-ignore: Headings recognized in existing user drafts, including drafts created before translation.
  const knownHeadings = { goal: ["目标", "Goal"], scope: ["范围", "Scope"], constraints: ["约束", "Constraints"], acceptance: ["验收", "Acceptance"] };
  const titles = { goal: t("enhance.goalHeading"), scope: t("enhance.scopeHeading"), constraints: t("enhance.constraintsHeading"), acceptance: t("enhance.acceptanceHeading") };
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const has = (kind: keyof typeof titles) => [...knownHeadings[kind], titles[kind]].some(name => new RegExp(`^#{1,6}[ \\t]+${escape(name)}[ \\t]*$`, "mi").test(headings));
  const variable = (name: string) => `{{${name}}}`;
  const sections: string[] = [];
  if (!has("goal")) sections.push(t("enhance.goalSection", { heading: titles.goal, goal: body || title || variable(t("enhance.goalVariable")) }));
  else sections.push(body);
  if (!has("scope")) sections.push(t("enhance.scopeSection", { heading: titles.scope, scope: variable(t("enhance.scopeVariable")) }));
  if (!has("constraints")) sections.push(t("enhance.constraintsSection", {
    heading: titles.constraints,
    languages: environment.languages.length ? t("enhance.languages", { languages: joinList(environment.languages) }) : "",
    constraints: variable(t("enhance.constraintsVariable")),
  }));
  if (!has("acceptance")) sections.push(t("enhance.acceptanceSection", {
    heading: titles.acceptance, acceptance: variable(t("enhance.acceptanceVariable")),
    tests: environment.testCommands.length ? t("enhance.testCommands", { commands: environment.testCommands.map(command => `- ${command}`).join("\n") }) : variable(t("enhance.testsVariable")),
  }));
  const result = sections.join("\n\n");
  if (result.length > BODY_MAX_LENGTH) throw new Error(t("enhance.tooLong"));
  return result;
}
