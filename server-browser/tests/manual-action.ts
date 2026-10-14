import { BrowserManager } from '../server/browser-manager';
import { needsManualTarget } from '../server/manual-target';
import type { BrowserAction, BrowserSession, BrowserTarget } from '../shared/browser';

/** Existing integration tests act as one freshly refreshed viewer; stale-target tests use the production manager directly. */
export class TestBrowserManager extends BrowserManager{
 override async action(workspaceId:string,action:BrowserAction,target?:BrowserTarget):Promise<BrowserSession>{
  if(!target&&needsManualTarget(action)){const state=await this.state(workspaceId);target={tabId:state.activeTabId!,viewRevision:state.viewRevision!};}
  return super.action(workspaceId,action,target);
 }
}
