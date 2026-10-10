// Regenerates the preview's fixture frames (synthetic pages with fictional names, no network):
//   node --import tsx preview/make-frames.mjs
// Set BROWSER_TEST_EXECUTABLE to use a Chromium other than Playwright's own (and LD_LIBRARY_PATH for missing system libraries).
import { chromium } from "playwright-core";
import { writeFile } from "node:fs/promises";
import { demoHtml } from "../server/demo.ts";

const font = `-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Noto Sans CJK SC",sans-serif`;
const pullRequest = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;font:14px ${font};color:#1f2328;background:#fff}
header{height:62px;background:#f6f8fa;border-bottom:1px solid #d1d9e0;display:flex;align-items:center;gap:14px;padding:0 32px}
.logo{width:30px;height:30px;border-radius:50%;background:#1f2328}.crumb{font-size:15px}.crumb b{font-weight:600}
.search{margin-left:auto;width:260px;height:32px;border:1px solid #d1d9e0;border-radius:6px;background:#fff;color:#59636e;padding:6px 10px;font-size:13px}
nav{display:flex;gap:22px;padding:0 32px;border-bottom:1px solid #d1d9e0;height:46px;align-items:flex-end}
nav span{padding-bottom:11px;color:#59636e}nav .on{color:#1f2328;border-bottom:2px solid #fd8c73;font-weight:600}
main{display:grid;grid-template-columns:1fr 250px;gap:28px;padding:22px 32px}
h1{font-size:26px;font-weight:400;margin:0 0 10px}h1 em{color:#59636e;font-style:normal}
.state{display:flex;align-items:center;gap:10px;color:#59636e;margin-bottom:18px}.pill{background:#1f883d;color:#fff;border-radius:16px;padding:5px 12px;font-weight:600}
.tabs{display:flex;gap:18px;border-bottom:1px solid #d1d9e0;margin-bottom:18px}.tabs span{padding:8px 2px;color:#59636e}.tabs .on{border-bottom:2px solid #fd8c73;color:#1f2328;font-weight:600}
.comment{display:grid;grid-template-columns:40px 1fr;gap:14px;margin-bottom:16px}.avatar{width:40px;height:40px;border-radius:50%;background:#8250df}.avatar.b{background:#bf8700}
.box{border:1px solid #d1d9e0;border-radius:6px}.box .head{background:#f6f8fa;border-bottom:1px solid #d1d9e0;padding:9px 14px;color:#59636e}.box .body{padding:14px;line-height:1.65}
.check{display:flex;gap:10px;align-items:center;padding:10px 14px;border-top:1px solid #d1d9e0}.ok{width:14px;height:14px;border-radius:50%;background:#1f883d}
aside h3{font-size:12px;color:#59636e;margin:0 0 8px;font-weight:600}aside p{margin:0 0 18px;padding-bottom:16px;border-bottom:1px solid #d1d9e0}
.label{display:inline-block;border-radius:12px;padding:2px 9px;font-size:12px;font-weight:600;margin-right:6px;background:#ddf4ff;color:#0969da}.label.r{background:#ffebe9;color:#cf222e}
button{background:#1f883d;color:#fff;border:0;border-radius:6px;padding:8px 16px;font:600 14px ${font}}
</style></head><body><header><div class="logo"></div><div class="crumb">acme / <b>web-app</b></div><div class="search">输入 / 搜索</div></header>
<nav><span>Code</span><span>Issues 42</span><span class="on">Pull requests 7</span><span>Actions</span><span>Projects</span><span>Security</span></nav>
<main><section><h1>fix: 断线重连后保留草稿 <em>#128</em></h1><div class="state"><span class="pill">Open</span><span><b>alice</b> 想将 3 个提交合并到 main，来自 fix/task-retry</span></div>
<div class="tabs"><span class="on">对话 4</span><span>提交 3</span><span>检查 5</span><span>文件变更 6</span></div>
<div class="comment"><div class="avatar"></div><div class="box"><div class="head"><b>alice</b> 评论于 2 小时前</div><div class="body">网络切换后，编辑中的任务草稿会被刷新覆盖。本 PR 在重新连接前把草稿写入本地缓存，恢复后提示用户合并差异。<br>验收：错误可见、草稿不丢失、重复提交只执行一次。</div></div></div>
<div class="comment"><div class="avatar b"></div><div class="box"><div class="head"><b>bob</b> 评论于 34 分钟前</div><div class="body">已在弱网环境复现并验证，建议补一条断线重连的端到端测试。</div></div></div>
<div class="box"><div class="check"><span class="ok"></span>全部检查已通过<span style="margin-left:auto;color:#59636e">5 项成功</span></div><div class="check"><span class="ok"></span>Unit tests<span style="margin-left:auto;color:#59636e">1 分 12 秒</span></div><div class="check"><span class="ok"></span>Build<span style="margin-left:auto;color:#59636e">2 分 40 秒</span></div><div class="check" style="justify-content:flex-end"><button>Merge pull request</button></div></div>
</section><aside><h3>Reviewers</h3><p>bob · 已批准</p><h3>Assignees</h3><p>alice</p><h3>Labels</h3><p><span class="label">bug</span><span class="label r">priority</span></p><h3>Milestone</h3><p>2.4.1</p></aside></main></body></html>`;
const docs = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;font:15px ${font};color:#20242a;background:#fff}
header{height:56px;border-bottom:1px solid #e6e8eb;display:flex;align-items:center;gap:26px;padding:0 28px}
.brand{font-weight:700;font-size:17px;display:flex;gap:9px;align-items:center}.brand i{width:22px;height:22px;border-radius:6px;background:#20744a;display:inline-block}
header span{color:#5b6470;font-size:14px}.kbd{margin-left:auto;border:1px solid #e6e8eb;border-radius:8px;padding:6px 12px;color:#8a929c;font-size:13px;width:220px}
.wrap{display:grid;grid-template-columns:230px 1fr 190px}
.side{border-right:1px solid #eef0f2;padding:22px 20px;font-size:14px;line-height:2.1;color:#4a525c}.side b{display:block;color:#20242a;margin-top:10px}.side .on{color:#20744a;font-weight:600}
article{padding:30px 44px;line-height:1.75}h1{font-size:30px;margin:0 0 8px}.lead{color:#5b6470;margin:0 0 22px}
h2{font-size:20px;margin:26px 0 8px}code{font:13px ui-monospace,monospace;background:#f3f5f7;border-radius:4px;padding:2px 5px}
pre{background:#101412;color:#d6e2dc;border-radius:10px;padding:16px 18px;font:13px/1.7 ui-monospace,monospace;margin:14px 0}
.note{border-left:3px solid #20744a;background:#f2f8f5;padding:10px 14px;border-radius:0 8px 8px 0;color:#2d5a44;font-size:14px}
.toc{padding:30px 18px;font-size:13px;color:#5b6470;line-height:2}.toc b{color:#20242a}
</style></head><body><header><div class="brand"><i></i>Acme Docs</div><span>指南</span><span>组件</span><span>API</span><span>更新日志</span><div class="kbd">搜索文档 ⌘K</div></header>
<div class="wrap"><div class="side"><b>开始</b><span class="on">快速上手</span><br>项目结构<br>本地开发<b>指南</b>路由与页面<br>数据请求<br>主题与图标<b>参考</b>命令行<br>配置项</div>
<article><h1>快速上手</h1><p class="lead">五分钟内创建一个 Acme 应用，并在本地开发服务器上预览。</p>
<h2>1. 创建项目</h2><p>在终端运行下面的命令，脚手架会生成 <code>src/</code>、<code>public/</code> 和配置文件。</p>
<pre>acme create web-app --template starter
cd web-app
acme dev --port 5173</pre>
<div class="note">开发服务器启动后，保存文件即可看到页面自动刷新。</div>
<h2>2. 添加页面</h2><p>在 <code>src/pages</code> 下新建文件即可得到对应路由，数据请求写在页面的 <code>load()</code> 函数里。</p></article>
<div class="toc"><b>本页内容</b><br>创建项目<br>添加页面<br>本地调试<br>部署</div></div></body></html>`;
const login = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;height:100vh;font:15px ${font};color:#1d2433;background:linear-gradient(135deg,#eef3fb,#f7f9fc 60%,#eaf1fb);display:flex;align-items:center;justify-content:center}
.card{width:400px;background:#fff;border-radius:16px;box-shadow:0 12px 40px #1d243314;padding:36px 38px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;margin-bottom:26px}.brand i{width:28px;height:28px;border-radius:8px;background:#3056d3;display:inline-block}
h1{font-size:22px;margin:0 0 6px}p{color:#6a7385;margin:0 0 22px;font-size:14px}
label{display:block;font-size:13px;color:#4a5263;margin:14px 0 7px}.field{height:42px;border:1px solid #cfd6e3;border-radius:9px;padding:10px 12px;color:#9aa2b1;font-size:14px}
.field.focus{border-color:#3056d3;box-shadow:0 0 0 3px #3056d322;color:#1d2433}
button{width:100%;height:44px;margin-top:22px;background:#3056d3;color:#fff;border:0;border-radius:9px;font:600 15px ${font}}
.row{display:flex;justify-content:space-between;margin-top:16px;font-size:13px;color:#3056d3}
</style></head><body><div class="card"><div class="brand"><i></i>统一身份认证</div><h1>登录管理后台</h1><p>请使用企业账号登录，登录状态会保留在服务器浏览器中。</p>
<label>账号</label><div class="field focus">demo.user</div><label>密码</label><div class="field">请输入密码</div><button>登录</button><div class="row"><span>扫码登录</span><span>忘记密码</span></div></div></body></html>`;

const browser = await chromium.launch(process.env.BROWSER_TEST_EXECUTABLE ? { executablePath: process.env.BROWSER_TEST_EXECUTABLE } : {});
const page = await browser.newPage({ viewport: { width: 1120, height: 720 }, deviceScaleFactor: 1 });
for (const [name, html] of [["pr", pullRequest], ["docs", docs], ["login", login], ["demo", demoHtml()]]) {
  await page.setContent(html, { waitUntil: "load" });
  await writeFile(new URL(`./fixtures/${name}.jpg`, import.meta.url), await page.screenshot({ type: "jpeg", quality: 70 }));
  console.log("frame", name);
}
await browser.close();
