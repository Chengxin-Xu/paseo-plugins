import type { BrowserCDPSession, BrowserPage } from './browser-types';
import { setVerifiedViewport } from './viewport';
import { DEVICE_PRESETS, deviceIdentity } from '../shared/devices';
import type { BrowserDevicePreset } from '../shared/browser';

/**
 * Keep the CDP session attached: detaching can remove its emulation overrides. A custom size keeps desktop metrics and the
 * browser's own user agent (an empty override restores it); a preset presents its device with the real Chromium version.
 */
export async function applyDeviceEmulation(page:BrowserPage,cdp:BrowserCDPSession,preset:BrowserDevicePreset|'custom',size:{width:number;height:number},verify=true,browserVersion=''):Promise<void>{
 const device=DEVICE_PRESETS[preset==='custom'?'desktop':preset];
 if(verify)await setVerifiedViewport(page,size);else await page.setViewportSize(size);
 await cdp.send('Emulation.setDeviceMetricsOverride',{...size,screenWidth:size.width,screenHeight:size.height,deviceScaleFactor:device.deviceScaleFactor,mobile:device.isMobile});
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:device.hasTouch,maxTouchPoints:device.hasTouch?5:1});
 await cdp.send('Emulation.setUserAgentOverride',preset==='custom'?{userAgent:''}:deviceIdentity(preset,browserVersion));
}
