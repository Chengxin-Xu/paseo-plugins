import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const workspaceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
export const modeSchema = z.enum(['manual', 'agent']);
export const tabSchema = z.object({ id:z.string(), title:z.string(), url:z.string(), active:z.boolean(), pinned:z.boolean().default(false) });
export const browserSettingsSchema = z.object({autoRecover:z.boolean(),maxTabs:z.number().int().min(2).max(100),maxArtifactMB:z.number().int().min(16).max(4096),artifactMaxAgeHours:z.number().int().min(1).max(720)});
export const runtimeSchema = z.object({recoveryCount:z.number(),lastRecoveredAt:z.number().nullable(),lastFailure:z.string().nullable(),artifactBytes:z.number(),artifactCount:z.number(),cleanedArtifacts:z.number(),uptimeSeconds:z.number()});
export const healthSchema = z.object({state:z.enum(['unknown','login_required','accessible','network_error']),summary:z.string(),checkedAt:z.number(),httpStatus:z.number().nullable(),origin:z.string()});
export const activitySchema = z.object({id:z.string(),source:z.enum(['agent','manual']),action:z.string(),status:z.enum(['running','completed','failed']),tabId:z.string().nullable(),pageTitle:z.string(),pageUrl:z.string(),startedAt:z.number(),endedAt:z.number().nullable()});
export const sessionSchema = z.object({
  workspaceId:workspaceIdSchema, status:z.enum(['idle','starting','running','recovering','error']),
  title:z.string(), url:z.string(), mode:modeSchema,
  width:z.number(), height:z.number(), tabs:z.array(tabSchema),
  agentId:z.string().nullable(), error:z.string().nullable(), agentBusy:z.boolean(),
  settings:browserSettingsSchema.optional(),runtime:runtimeSchema.optional(),health:healthSchema.nullable().optional(),
  activity:z.array(activitySchema).optional(),
});
// cwd is no longer sent (0.9.2); it stays optional so a client still parses an older server's reply.
export const workspaceSchema = z.object({id:workspaceIdSchema,title:z.string(),cwd:z.string().optional(),projectId:z.string().nullable().optional(),projectTitle:z.string().optional()});
export const linkedAgentSchema = z.object({id:z.string(),title:z.string(),status:z.string(),provider:z.string(),needsPermission:z.boolean()});
export const overviewItemSchema = z.object({workspace:workspaceSchema,session:sessionSchema,agent:linkedAgentSchema.nullable(),observedAt:z.number()});
// A client that sends the revision it renders receives only {unchanged, revision, checkedAt} until the summary changes.
export const overviewRpc = defineRpc({name:'browser.overview',input:z.object({revision:z.string().max(64).optional()}),output:z.object({items:z.array(overviewItemSchema).optional(),checkedAt:z.number(),revision:z.string().optional(),unchanged:z.boolean().optional()})});
export const profileSchema = z.object({id:z.string(),name:z.string(),provider:z.string(),model:z.string().nullable()});
export const optionsRpc = defineRpc({name:'browser.options', input:z.object({}), output:z.object({workspaces:z.array(workspaceSchema),profiles:z.array(profileSchema)})});
export const startRpc = defineRpc({name:'browser.start',input:z.object({workspaceId:workspaceIdSchema}),output:sessionSchema});
export const stateRpc = defineRpc({name:'browser.state',input:z.object({workspaceId:workspaceIdSchema}),output:sessionSchema});
export const frameQualitySchema = z.enum(['smooth','balanced','sharp']);
// maxWidth/maxHeight: device pixels the viewer can actually show; larger viewports are captured downscaled.
// sessionRevision: the session is omitted while it is unchanged. width/height stay the page's CSS viewport.
export const frameRpc = defineRpc({name:'browser.frame',input:z.object({workspaceId:workspaceIdSchema,after:z.string().nullable().optional(),quality:frameQualitySchema.optional(),
  maxWidth:z.number().int().min(64).max(8192).optional(),maxHeight:z.number().int().min(64).max(8192).optional(),sessionRevision:z.string().max(64).optional()}),output:z.object({
  session:sessionSchema.optional(), sessionRevision:z.string().optional(),
  frame:z.object({id:z.string(),dataUrl:z.string(),width:z.number(),height:z.number(),capturedAt:z.number(),scale:z.number().optional()}).nullable(),
})});
export const actionSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('navigate'),url:z.string().min(1).max(4096)}),
  z.object({kind:z.enum(['back','forward','reload','demo','stop','newTab','restart','cleanup','fitWidth'])}),
  z.object({kind:z.literal('click'),x:z.number().finite(),y:z.number().finite()}),
  z.object({kind:z.literal('scroll'),deltaX:z.number().min(-3000).max(3000),deltaY:z.number().min(-3000).max(3000)}),
  z.object({kind:z.literal('text'),text:z.string().max(10000)}),
  z.object({kind:z.literal('key'),key:z.enum(['Enter','Tab','Escape','Backspace','Control+A','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'])}),
  z.object({kind:z.literal('mode'),mode:modeSchema}),
  z.object({kind:z.literal('viewport'),width:z.number().int().min(320).max(2560),height:z.number().int().min(320).max(1600)}),
  z.object({kind:z.enum(['tab','closeTab']),tabId:z.string().min(1).max(100)}),
  z.object({kind:z.literal('pin'),tabId:z.string().min(1).max(100),pinned:z.boolean()}),
  z.object({kind:z.literal('settings'),settings:browserSettingsSchema.partial()}),
]);
export const actionRpc = defineRpc({name:'browser.action',input:z.object({workspaceId:workspaceIdSchema,action:actionSchema}),output:sessionSchema});
export const agentRpc = defineRpc({name:'browser.agent',input:z.object({workspaceId:workspaceIdSchema,profileId:z.string().optional()}),output:z.object({agentId:z.string(),created:z.boolean(),session:sessionSchema})});
export const diagnosticsRpc = defineRpc({name:'browser.diagnostics',input:z.object({workspaceId:workspaceIdSchema}),output:z.object({session:sessionSchema,checks:z.array(z.object({name:z.string(),status:z.enum(['ok','warning','error']),detail:z.string()})),health:healthSchema})});
export const readingSchema = z.object({tabId:z.string(),title:z.string(),url:z.string(),content:z.string(),format:z.enum(['markdown','text']),method:z.enum(['readability','dom']),truncated:z.boolean(),characters:z.number()});
export const readPageInputSchema = z.object({workspaceId:workspaceIdSchema,tabId:z.string().optional(),mode:z.enum(['article','visible']).default('article'),selector:z.string().max(500).optional(),query:z.string().max(200).optional(),maxChars:z.number().int().min(500).max(60000).default(16000)});
export const readPageRpc = defineRpc({name:'browser.read',input:readPageInputSchema,output:readingSchema});
export type BrowserSession = z.infer<typeof sessionSchema>;
export type BrowserAction = z.infer<typeof actionSchema>;
export type BrowserWorkspace = z.infer<typeof workspaceSchema>;
export type BrowserProfile = z.infer<typeof profileSchema>;
export type BrowserFrameResult = z.infer<typeof frameRpc.output>;
export type BrowserFrameQuality = z.infer<typeof frameQualitySchema>;
export type BrowserOverviewResult = z.infer<typeof overviewRpc.output>;
export type BrowserSettings = z.infer<typeof browserSettingsSchema>;
export type BrowserHealth = z.infer<typeof healthSchema>;
export type BrowserReading = z.infer<typeof readingSchema>;
export type BrowserReadInput = z.infer<typeof readPageInputSchema>;
export type BrowserActivity = z.infer<typeof activitySchema>;
export type BrowserOverviewItem = z.infer<typeof overviewItemSchema>;
