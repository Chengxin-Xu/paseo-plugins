import { t } from './text';
import type { BrowserDevicePreset } from './browser';

/** `browser`: whose identity the preset presents. Chrome presets carry the running engine's real version; Safari ones send no Client Hints, like Safari. */
export type DevicePreset={title:string;width:number;height:number;deviceScaleFactor:number;hasTouch:boolean;isMobile:boolean;browser:'chrome-desktop'|'chrome-android'|'safari-iphone'|'safari-ipad'};
export const DEVICE_PRESETS:Record<BrowserDevicePreset,DevicePreset>={
 desktop:{get title(){return t('serverText.desktopChrome');},width:1280,height:800,deviceScaleFactor:1,hasTouch:false,isMobile:false,browser:'chrome-desktop'},
 iphone:{title:'iPhone 15 Pro',width:393,height:659,deviceScaleFactor:3,hasTouch:true,isMobile:true,browser:'safari-iphone'},
 pixel:{title:'Pixel 7',width:412,height:839,deviceScaleFactor:2.625,hasTouch:true,isMobile:true,browser:'chrome-android'},
 ipad:{title:'iPad Pro 11',width:834,height:1194,deviceScaleFactor:2,hasTouch:true,isMobile:true,browser:'safari-ipad'},
};

export type UserAgentMetadata={brands:{brand:string;version:string}[];fullVersionList:{brand:string;version:string}[];fullVersion:string;platform:string;platformVersion:string;architecture:string;model:string;mobile:boolean};
export type DeviceIdentity={userAgent:string;platform:string;userAgentMetadata?:UserAgentMetadata};

/** Chromium's own GREASE brand for a major version (user_agent_utils.cc), so the brand list matches the engine's. */
export function greaseBrand(major:number):{brand:string;version:string}{
 const chars=[' ','(',':','-','.','/',')',';','=','?','_'],versions=['8','99','24'];
 return {brand:`Not${chars[major%chars.length]}A${chars[(major+1)%chars.length]}Brand`,version:versions[major%versions.length]};
}

/**
 * What a preset tells websites, for the Chromium version that really runs (e.g. "153.0.8010.12"). Chrome presets use the
 * reduced user agent real Chrome sends (`Chrome/153.0.0.0`) and full Client Hints; Safari presets have no Client Hints.
 */
export function deviceIdentity(preset:BrowserDevicePreset,version:string):DeviceIdentity{
 const device=DEVICE_PRESETS[preset],full=/^\d+(\.\d+){3}$/.test(version)?version:'0.0.0.0',major=Number(full.split('.')[0]);
 if(device.browser==='safari-iphone')return {userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',platform:'iPhone'};
 if(device.browser==='safari-ipad')return {userAgent:'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',platform:'iPad'};
 const android=device.browser==='chrome-android',grease=greaseBrand(major);
 const brands=[{brand:'Chromium',version:String(major)},{brand:'Google Chrome',version:String(major)},grease];
 return {
  userAgent:android?`Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`:`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  platform:android?'Linux armv8l':'Linux x86_64',
  userAgentMetadata:{brands,fullVersionList:[{brand:'Chromium',version:full},{brand:'Google Chrome',version:full},{brand:grease.brand,version:`${grease.version}.0.0.0`}],fullVersion:full,platform:android?'Android':'Linux',platformVersion:android?'13.0.0':'',architecture:android?'arm':'x86',model:android?'Pixel 7':'',mobile:android},
 };
}
