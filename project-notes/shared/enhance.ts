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
  const has = (name: string) => new RegExp(`^#{1,6}[ \\t]+${name}[ \\t]*$`, "m").test(headings);
  const sections: string[] = [];
  if (!has("目标")) sections.push(`## 目标\n${body || title || "{{目标}}"}`);
  else sections.push(body);
  if (!has("范围")) sections.push("## 范围\n{{范围}}\n仅修改与目标有关的文件。");
  if (!has("约束")) sections.push(`## 约束\n${environment.languages.length ? `项目语言：${environment.languages.join("、")}。\n` : ""}遵循项目现有约定，保留用户已有改动；不添加未经确认的依赖。\n{{补充约束}}`);
  if (!has("验收")) sections.push(`## 验收\n{{验收标准}}\n${environment.testCommands.length ? `核对并运行项目已有测试命令：\n${environment.testCommands.map(command => `- ${command}`).join("\n")}` : "{{测试命令}}"}\n说明验证结果与未覆盖的情况。`);
  const result = sections.join("\n\n");
  if (result.length > BODY_MAX_LENGTH) throw new Error("加入模板后超过正文上限，请先缩短草稿。");
  return result;
}
