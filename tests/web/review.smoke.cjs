// Real browser against HTTP/Records fixtures; no Docker or model execution.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const server = spawn('uv', ['run', '--locked', 'python', '-m', 'tests.web.review_fixture'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let browser;
  try {
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('review fixture startup timeout')), 20000);
      createInterface({input:server.stdout}).once('line', line => {clearTimeout(timer);resolve(JSON.parse(line));});
      server.once('exit', code => reject(new Error(`fixture exited ${code}`)));
    });
    browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    const base=`http://127.0.0.1:${info.port}`;
    await page.goto(`${base}/#token=web-workflow-fixture-not-a-production-secret`);
    await page.goto(`${base}/#projects/${info.project}`);
    await page.getByRole('heading',{name:'实验复盘',exact:true}).waitFor();
    await page.getByLabel('查看实验',{exact:true}).selectOption(info.second);
    await page.getByLabel('对照实验',{exact:true}).selectOption(info.first);
    await page.getByRole('columnheader',{name:'对照实验',exact:true}).waitFor();
    assert.equal(await page.locator('.metric-series').count(),2);
    await page.getByRole('button',{name:/claude-code/}).click();
    await page.getByText('录制样例：查看两次实验的学习曲线',{exact:true}).waitFor();
    await page.screenshot({path:'/tmp/infra-refactor-review-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'/tmp/infra-refactor-review-mobile.png',fullPage:true});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await page.setViewportSize({width:1440,height:1000});
    page.once('dialog', dialog=>dialog.accept());
    await page.getByRole('button',{name:'用当前代码重跑',exact:true}).click();
    await page.waitForURL(/#execution\//);
    await page.getByRole('heading',{name:'运行状态',exact:true}).waitFor();
    assert.notEqual(page.url(),`${base}/#execution/${info.second}`);
    assert.equal(await page.getByRole('link',{name:'科研项目',exact:true}).getAttribute('aria-current'),'page');
    await page.getByText('重跑来源：',{exact:false}).waitFor();
    assert.deepEqual(errors,[]);
    console.log('Review browser passed: metrics comparison, code/configuration, host session, rerun, deep-link navigation, mobile.');
  } finally {await browser?.close();server.kill('SIGTERM');}
})().catch(error=>{console.error(error);process.exitCode=1;});
