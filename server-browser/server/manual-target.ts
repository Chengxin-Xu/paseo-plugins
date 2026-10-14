import type { BrowserAction, BrowserTarget } from '../shared/browser';

export const STALE_TARGET='画面已经变化，本次操作已取消。请等待刷新后的画面再操作。';
/** A takeover confirmed on one page while the page shown there changed before it arrived: nothing changes, not even the mode. */
export const STALE_CONFIRMATION='确认之前页面已经变化，这次没有切到手动，也没有执行。请看清当前页面后再操作。';
export function needsManualTarget(action:BrowserAction):boolean{return !['mode','stop','restart','settings','cleanup','handleDialog'].includes(action.kind);}
/**
 * A click lands on coordinates, so it needs the exact picture it was made on (viewRevision changes after every input).
 * Everything else only needs the page context the viewer saw (inputScope: tab, document, viewport, control); a target
 * from a client that does not send one is checked against the exact picture, as before.
 */
export function assertManualTarget(target:BrowserTarget|undefined,current:{activeId:string|null;viewRevision:string;inputScope?:string|null},exact=false):void{
 const scoped=!exact&&!!target?.inputScope&&!!current.inputScope;
 if(!target||target.tabId!==current.activeId||(scoped?target.inputScope!==current.inputScope:target.viewRevision!==current.viewRevision))throw new Error(STALE_TARGET);
}
