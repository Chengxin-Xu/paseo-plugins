import { createHash } from 'node:crypto';
import type { BrowserSession } from '../shared/browser';

/** Content revision: every change of the serialized value yields a different revision. */
export function contentRevision(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0,22);}

/** The uptime counter ticks every second; clients extend it locally, so it alone never re-sends a session. */
export function sessionRevision(session:BrowserSession):string{
 return contentRevision(session.runtime?{...session,runtime:{...session.runtime,uptimeSeconds:0}}:session);
}
