import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const workspaceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
// viewRevision: the exact picture a click was made on. inputScope: the page context (tab, documents of the page and its
// frames, viewport, control) that keys, text, scrolling and page commands stay bound to while the picture refreshes; servers
// without it check viewRevision. documentScope: the page itself (tab, document, viewport), whoever controls it; a takeover
// confirmed on it runs only while it is unchanged.
export const targetSchema = z.object({tabId:z.string().min(1).max(100),viewRevision:z.string().min(1).max(100),inputScope:z.string().min(1).max(100).optional(),documentScope:z.string().min(1).max(100).optional()});
export const devicePresetSchema = z.enum(['desktop','iphone','pixel','ipad']);
export const dialogSchema = z.object({id:z.string(),tabId:z.string(),type:z.enum(['alert','confirm','prompt','beforeunload']),message:z.string(),defaultValue:z.string(),openedAt:z.number()});
export const modeSchema = z.enum(['manual', 'agent']);
export const tabSchema = z.object({ id:z.string(), title:z.string(), url:z.string(), active:z.boolean(), pinned:z.boolean().default(false) });
export const browserSettingsSchema = z.object({autoRecover:z.boolean(),maxTabs:z.number().int().min(2).max(100),maxArtifactMB:z.number().int().min(16).max(4096),artifactMaxAgeHours:z.number().int().min(1).max(720)});
export const runtimeSchema = z.object({recoveryCount:z.number(),lastRecoveredAt:z.number().nullable(),lastFailure:z.string().nullable(),artifactBytes:z.number(),artifactCount:z.number(),cleanedArtifacts:z.number(),uptimeSeconds:z.number()});
export const healthSchema = z.object({state:z.enum(['unknown','login_required','accessible','network_error']),summary:z.string(),checkedAt:z.number(),httpStatus:z.number().nullable(),origin:z.string()});
export const activitySchema = z.object({id:z.string(),source:z.enum(['agent','manual']),action:z.string(),actionId:z.string().optional(),status:z.enum(['running','completed','failed']),tabId:z.string().nullable(),pageTitle:z.string(),pageUrl:z.string(),startedAt:z.number(),endedAt:z.number().nullable()});
export const sessionSchema = z.object({
  workspaceId:workspaceIdSchema, status:z.enum(['idle','starting','running','recovering','error']),
  title:z.string(), url:z.string(), mode:modeSchema,
  width:z.number(), height:z.number(), tabs:z.array(tabSchema),
  agentId:z.string().nullable(), error:z.string().nullable(), agentBusy:z.boolean(),
  settings:browserSettingsSchema.optional(),runtime:runtimeSchema.optional(),health:healthSchema.nullable().optional(),
  activity:z.array(activitySchema).optional(),
  activeTabId:z.string().nullable().optional(),viewRevision:z.string().optional(),inputScope:z.string().nullable().optional(),documentScope:z.string().nullable().optional(),
  // A viewer the server no longer remembers must number its live input batches above this (browser.input refuses the rest).
  inputSeqFloor:z.number().int().min(0).optional(),devicePreset:z.enum(['desktop','iphone','pixel','ipad','custom']).optional(),viewerCount:z.number().optional(),dialog:dialogSchema.nullable().optional(),
  agentAvailability:z.enum(['available','unavailable','unknown']).optional(),
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
  maxWidth:z.number().int().min(64).max(8192).optional(),maxHeight:z.number().int().min(64).max(8192).optional(),sessionRevision:z.string().max(64).optional(),viewerId:z.string().min(1).max(100).optional()}),output:z.object({
  session:sessionSchema.optional(), sessionRevision:z.string().optional(),
  frame:z.object({id:z.string(),tabId:z.string(),viewRevision:z.string(),inputScope:z.string().optional(),documentScope:z.string().optional(),dataUrl:z.string(),width:z.number(),height:z.number(),capturedAt:z.number(),scale:z.number().optional()}).nullable(),
})});
export const actionSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('navigate'),url:z.string().min(1).max(4096)}),
  z.object({kind:z.enum(['back','forward','reload','demo','stop','restart','cleanup','fitWidth'])}),
  // url: open this address in the new tab (a workspace service) instead of the start page.
  z.object({kind:z.literal('newTab'),url:z.string().min(1).max(4096).optional()}),
  // A port from the list of ports Agents opened (browser.ports): the server opens its own address for it, nothing else.
  z.object({kind:z.literal('openPort'),port:z.number().int().min(1).max(65535)}),
  z.object({kind:z.literal('click'),x:z.number().finite(),y:z.number().finite()}),
  z.object({kind:z.literal('scroll'),deltaX:z.number().min(-3000).max(3000),deltaY:z.number().min(-3000).max(3000)}),
  z.object({kind:z.literal('text'),text:z.string().max(10000)}),
  z.object({kind:z.literal('key'),key:z.enum(['Enter','Tab','Escape','Backspace','Control+A','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'])}),
  z.object({kind:z.literal('mode'),mode:modeSchema}),
  z.object({kind:z.literal('viewport'),width:z.number().int().min(320).max(2560),height:z.number().int().min(320).max(1600)}),
  z.object({kind:z.enum(['tab','closeTab']),tabId:z.string().min(1).max(100)}),
  z.object({kind:z.literal('pin'),tabId:z.string().min(1).max(100),pinned:z.boolean()}),
  z.object({kind:z.literal('devicePreset'),preset:devicePresetSchema}),
  z.object({kind:z.literal('handleDialog'),dialogId:z.string().min(1).max(100),accept:z.boolean(),promptText:z.string().max(10000).optional()}),
  z.object({kind:z.literal('settings'),settings:browserSettingsSchema.partial()}),
  // From Agent mode: switch to manual, let the Agent's current step finish, then navigate only if the tab and page are unchanged.
  z.object({kind:z.literal('takeover'),then:z.discriminatedUnion('kind',[z.object({kind:z.enum(['back','forward','reload'])}),z.object({kind:z.literal('navigate'),url:z.string().min(1).max(4096)})])}),
]);
export const actionRpc = defineRpc({name:'browser.action',input:z.object({workspaceId:workspaceIdSchema,action:actionSchema,target:targetSchema.optional()}),output:sessionSchema});
export const inputKeySchema = z.enum(['Enter','Tab','Escape','Backspace','Control+A','ArrowUp','ArrowDown','ArrowLeft','ArrowRight']);
export const inputEventSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('click'),x:z.number().finite(),y:z.number().finite()}),
  z.object({kind:z.literal('scroll'),deltaX:z.number().min(-3000).max(3000),deltaY:z.number().min(-3000).max(3000)}),
  z.object({kind:z.literal('text'),text:z.string().min(1).max(10000)}),
  z.object({kind:z.literal('key'),key:inputKeySchema}),
]);
/**
 * Live input from one viewer, in order. seq increases with every batch the viewer sends; a replayed or reordered batch is
 * refused. A click must be the first event and needs the exact picture it was made on; the rest needs the page context.
 * applied: events that ran. continuation: the inputScope the viewer's queued input keeps using (null: it ends here).
 * stale: the page context changed, nothing more runs; busy: an Agent read is finishing, retry; blocked: a page dialog waits.
 * pending (blocked only): the event after the applied ones reached the page and waits for that dialog; without it, a dialog
 * that was already open stopped the batch before anything ran.
 */
export const inputRpc = defineRpc({name:'browser.input',input:z.object({workspaceId:workspaceIdSchema,viewerId:z.string().min(1).max(100),seq:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),target:targetSchema,events:z.array(inputEventSchema).min(1).max(64)}),
  output:z.object({status:z.enum(['applied','stale','busy','blocked']),applied:z.number().int().min(0),continuation:z.string().nullable(),pending:z.boolean().optional(),session:sessionSchema})});
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
export type BrowserInputEvent = z.infer<typeof inputEventSchema>;
export type BrowserInputRequest = z.infer<typeof inputRpc.input>;
export type BrowserInputResult = z.infer<typeof inputRpc.output>;

// kind process: a browser still running for a workspace that is gone; profile: only its saved data (logins, cookies, cache) is left.
// label: the workspace's last known name; profileBytes and lastUsedAt describe the saved data.
export const orphanSchema = z.object({workspaceId:workspaceIdSchema,status:sessionSchema.shape.status,pid:z.number().nullable(),desiredRunning:z.boolean(),
  kind:z.enum(['process','profile']).optional(),label:z.string().nullable().optional(),profileBytes:z.number().nullable().optional(),lastUsedAt:z.number().nullable().optional()});
export const orphanRpc = defineRpc({name:'browser.orphans',input:z.object({}),output:z.object({items:z.array(orphanSchema)})});
export const stopOrphanRpc = defineRpc({name:'browser.orphan.stop',input:z.object({workspaceId:workspaceIdSchema}),output:z.object({stopped:z.literal(true)})});
/** Deletes everything the plugin kept for a workspace that is gone: Profile (logins, cookies, cache), saved tabs and files. */
export const deleteOrphanRpc = defineRpc({name:'browser.orphan.delete',input:z.object({workspaceId:workspaceIdSchema}),output:z.object({deleted:z.literal(true)})});
/** The workspace's own services (paseo.json scripts of type service), to open in the shared browser. */
export const serviceSchema = z.object({name:z.string(),url:z.string().nullable(),port:z.number().nullable(),running:z.boolean(),health:z.enum(['healthy','unhealthy']).nullable()});
export const servicesRpc = defineRpc({name:'browser.services',input:z.object({workspaceId:workspaceIdSchema}),output:z.object({items:z.array(serviceSchema)})});
export type BrowserService = z.infer<typeof serviceSchema>;
/**
 * A port an Agent opened: a listening TCP socket of a process that carries an Agent of this daemon (PASEO_AGENT_ID),
 * found in /proc on a Linux daemon host. scope: local (loopback only), all (every address), address (one other address,
 * named in `address`). process: the program name only; no command line or environment variable leaves the server.
 * openable: the shared browser may open it (link-local and metadata addresses are refused, as for every page).
 */
export const agentPortSchema = z.object({
  port:z.number().int().min(1).max(65535),scope:z.enum(['local','all','address']),address:z.string().max(64).optional(),process:z.string().max(32),
  agentId:z.string().max(128),agentTitle:z.string().max(200).nullable(),agentStatus:z.enum(['initializing','running','idle','error','closed','archived']),
  workspaceId:z.string().max(200).nullable(),workspaceTitle:z.string().max(200).nullable(),projectTitle:z.string().max(200).nullable(),openable:z.boolean(),
});
/**
 * Ports Agents opened: `items` belong to the asked workspace, `others` to other workspaces. supported: false on hosts
 * without /proc (the group stays hidden). partial: caps or the deadline cut the scan short; uncertain: some owners' Agents
 * could not be looked up this time; failed: the scan itself failed. A client that sends the revision it renders gets
 * only {supported, unchanged, revision, scannedAt} while nothing changed.
 */
export const portsRpc = defineRpc({name:'browser.ports',input:z.object({workspaceId:workspaceIdSchema,revision:z.string().max(64).optional()}),
  output:z.object({supported:z.boolean(),items:z.array(agentPortSchema).optional(),others:z.array(agentPortSchema).optional(),partial:z.boolean().optional(),
    uncertain:z.boolean().optional(),failed:z.boolean().optional(),scannedAt:z.number(),revision:z.string().optional(),unchanged:z.boolean().optional()})});
export type BrowserAgentPort = z.infer<typeof agentPortSchema>;
export type BrowserPortsReply = z.infer<typeof portsRpc.output>;
export type BrowserTarget = z.infer<typeof targetSchema>;
export type BrowserDialog = z.infer<typeof dialogSchema>;
export type BrowserDevicePreset = z.infer<typeof devicePresetSchema>;
export type BrowserOrphan = z.infer<typeof orphanSchema>;
