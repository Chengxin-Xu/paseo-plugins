import { t } from '../shared/text';
import type { BrowserAction, BrowserTarget } from '../shared/browser';

export const STALE_TARGET=()=>t('serverError.staleTarget');
/** A takeover confirmed on one page while the page shown there changed before it arrived: nothing changes, not even the mode. */
export const STALE_CONFIRMATION=()=>t('serverError.staleConfirmation');
export function needsManualTarget(action:BrowserAction):boolean{return !['mode','stop','restart','settings','cleanup','handleDialog'].includes(action.kind);}
/**
 * A click lands on coordinates, so it needs the exact picture it was made on (viewRevision changes after every input).
 * Everything else only needs the page context the viewer saw (inputScope: tab, document, viewport, control); a target
 * from a client that does not send one is checked against the exact picture, as before.
 */
export function assertManualTarget(target:BrowserTarget|undefined,current:{activeId:string|null;viewRevision:string;inputScope?:string|null},exact=false):void{
 const scoped=!exact&&!!target?.inputScope&&!!current.inputScope;
 if(!target||target.tabId!==current.activeId||(scoped?target.inputScope!==current.inputScope:target.viewRevision!==current.viewRevision))throw new Error(STALE_TARGET());
}
