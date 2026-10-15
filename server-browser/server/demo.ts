import { t } from '../shared/text';
import { currentLanguage } from '../shared/i18n';
import { randomInt } from 'node:crypto';

/** Catalogs are user-editable data, so escape both page text and JavaScript inside HTML attributes. */
const html=(text:string):string=>text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));

/** Local demonstration content; it makes no network requests. */
export function demoHtml(): string {
  const challenge = String(randomInt(100000, 1000000));
  return `<!doctype html><html lang="${html(currentLanguage())}" data-server-browser-demo="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(t('demo.title'))}</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f4f7fc;color:#142844;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:920px;margin:auto;padding:48px 30px}small{letter-spacing:.13em;color:#547097;font-weight:700}h1{font-size:40px;line-height:1.2;letter-spacing:-.03em;margin:18px 0}p{color:#5d6f86;line-height:1.7}.badge{display:inline-flex;gap:9px;align-items:center;background:#def5e9;color:#137646;padding:8px 13px;border-radius:20px;font-size:13px}.dot{width:7px;height:7px;border-radius:100%;background:#15945b}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:30px}.card{background:white;border:1px solid #e0e7f1;border-radius:20px;padding:24px;box-shadow:0 8px 24px #10213d05}h2{font-size:19px;margin:0 0 10px}label{display:block;margin:16px 0 7px;font-size:14px}input{font:inherit;padding:12px;border:1px solid #cbd5e3;border-radius:10px;width:100%;background:white;color:#142844}button{font:600 15px inherit;border:0;padding:12px 18px;border-radius:10px;background:#2868ea;color:white;cursor:pointer;margin-top:12px}button:hover{background:#1558d8}output{display:block;margin-top:14px;font-weight:650;min-height:22px}.number{font-size:55px;font-weight:750;letter-spacing:-.04em;margin:12px 0}.code{letter-spacing:.25em;font:700 25px ui-monospace,monospace;color:#235ccc;background:#edf3ff;border-radius:10px;padding:16px;margin-top:15px}.wide{grid-column:1/-1}footer{margin-top:36px;border-top:1px solid #dae3ee;padding-top:20px;color:#738196;font-size:13px}.steps{display:flex;gap:10px;flex-wrap:wrap}.steps span{background:#edf3fc;border-radius:8px;padding:10px 12px;color:#3f5675;font-size:13px}@media(max-width:600px){main{padding:28px 20px}h1{font-size:30px}.grid{grid-template-columns:1fr}.card{padding:20px}.wide{grid-column:auto}}
  </style></head><body><main><div class="badge"><span class="dot"></span>${html(t('demo.badge'))}</div><h1>${html(t('demo.heading')).replace(/\n/g,'<br>')}</h1><p>${html(t('demo.description'))}</p><div class="steps"><span>${html(t('demo.stepManual'))}</span><span>${html(t('demo.stepType'))}</span><span>${html(t('demo.stepAgent'))}</span></div><div class="grid"><section class="card"><h2>${html(t('demo.clickHeading'))}</h2><p>${html(t('demo.clickDescription'))}</p><label for="visitor">${html(t('demo.nameLabel'))}</label><input id="visitor" placeholder="${html(t('demo.namePlaceholder'))}" autocomplete="off"><button id="greet" onclick="${html(`document.getElementById('greeting').textContent=${JSON.stringify(t('demo.greeting'))}.replace(/\\{name\\}/g,()=>document.getElementById('visitor').value||${JSON.stringify(t('demo.friend'))})`)}">${html(t('demo.greet'))}</button><output id="greeting" aria-live="polite"></output></section><section class="card"><h2>${html(t('demo.counterHeading'))}</h2><p>${html(t('demo.counterDescription'))}</p><div class="number" id="count" aria-live="polite">0</div><button id="increment" onclick="document.getElementById('count').textContent=String(Number(document.getElementById('count').textContent)+1)">${html(t('demo.increment'))}</button></section><section class="card wide"><h2>${html(t('demo.challengeHeading'))}</h2><p>${html(t('demo.challengeDescription'))}</p><div class="code" id="challenge">${challenge}</div><label for="answer">${html(t('demo.answerLabel'))}</label><input id="answer" inputmode="numeric" placeholder="${html(t('demo.answerPlaceholder'))}" autocomplete="off"><button id="verify" onclick="${html(`const ok=document.getElementById('answer').value.trim()===document.getElementById('challenge').textContent;document.getElementById('result').textContent=ok?${JSON.stringify(t('demo.success'))}:${JSON.stringify(t('demo.retry'))};document.getElementById('result').style.color=ok?'#137646':'#b34b31'`)}">${html(t('demo.verify'))}</button><output id="result" aria-live="polite"></output></section></div><footer>${html(t('demo.footer'))}</footer></main></body></html>`;
}

/** Re-label the local demo without reloading it or discarding inputs, the challenge, the counter, or prior results. */
export function demoRefreshScript():string {
  return `(() => {
    if(document.documentElement.getAttribute('data-server-browser-demo')!=='1')return false;
    const template=new DOMParser().parseFromString(${JSON.stringify(demoHtml())},'text/html');
    document.documentElement.lang=template.documentElement.lang;
    document.title=template.title;
    for(const selector of ['main > p','.steps span:nth-child(1)','.steps span:nth-child(2)','.steps span:nth-child(3)',
      '.card:nth-child(1) h2','.card:nth-child(1) p','label[for=visitor]','#greet',
      '.card:nth-child(2) h2','.card:nth-child(2) p','#increment',
      '.card:nth-child(3) h2','.card:nth-child(3) p','label[for=answer]','#verify','footer']){
      const target=document.querySelector(selector),source=template.querySelector(selector);
      if(target&&source)target.textContent=source.textContent;
    }
    for(const selector of ['h1','.badge']){
      const target=document.querySelector(selector),source=template.querySelector(selector);
      if(target&&source)target.replaceChildren(...Array.from(source.childNodes));
    }
    for(const selector of ['#visitor','#answer']){
      document.querySelector(selector)?.setAttribute('placeholder',template.querySelector(selector).getAttribute('placeholder'));
    }
    for(const selector of ['#greet','#verify']){
      document.querySelector(selector)?.setAttribute('onclick',template.querySelector(selector).getAttribute('onclick'));
    }
    return true;
  })()`;
}
