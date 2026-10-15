import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditCatalogs, findMessageIds, findUntranslated } from '../server/i18n-audit';
import { bindTranslator, catalogIds, checkCatalog, createTranslator } from '../shared/i18n';
import { t } from '../shared/text';
import zh from '../shared/locales/zh-CN.json';
import en from '../shared/locales/en.json';
import kitZh from '../shared/locales/kit/zh-CN.json';
import kitEn from '../shared/locales/kit/en.json';
import { actionTitle, agentStatus, pageHost, pageLocation } from '../client/overview-model';
import { controlLooks, tabGlyph } from '../client/agent-tabs-model';
import { BrowserActivityLog } from '../server/activity';
import { normalizeNavigationUrl } from '../server/navigation';
import { withoutAddresses } from '../server/browser-manager';
import { droppedMessage } from '../client/input-queue';

const root = fileURLToPath(new URL('..', import.meta.url));
// Keep dynamic prefixes explicit so the audit cannot hide an unused catalog section.
const dynamicPrefixes: string[] = ['activity.'];

test('built-in catalogs have exactly the same IDs and placeholders', () => {
  assert.deepEqual(auditCatalogs({ zh, en }), []);
});

test('plugin sources contain no unexplained untranslated CJK text', () => {
  assert.deepEqual(findUntranslated(root), []);
});

test('every message is used and every named message exists', () => {
  const ids = catalogIds(zh);
  const named = findMessageIds(root, zh);
  assert.deepEqual([...named].filter(id => !ids.includes(id)), []);
  assert.deepEqual(ids.filter(id => !named.has(id) && !dynamicPrefixes.some(prefix => id.startsWith(prefix))), []);
});

test('registration and settings text render in English and retain Chinese text', () => {
  try {
    bindTranslator(createTranslator('en', [en, kitEn]));
    assert.equal(t('boot.name'), 'Server browser');
    assert.equal(t('boot.openBrowser'), 'Open server browser');
    assert.equal(t('boot.openWorkspaceBrowser'), 'Open the current workspace browser');
    assert.equal(t('boot.slashDescription'), 'View and take over the current workspace browser');
    assert.equal(t('boot.settingsTitle'), 'Language');
    assert.equal(t('settings.description'), 'Run Chromium on the Paseo server and share it with your devices and browser agent.');
  } finally {
    bindTranslator(createTranslator('zh-CN', [zh, kitZh]));
  }
  assert.equal(t('boot.name'), '服务器浏览器');
  assert.equal(t('boot.openBrowser'), '打开服务器浏览器');
});

test('a custom language uses valid translations and falls back to English for a bad placeholder', () => {
  const custom = checkCatalog({ $meta: { name: '한국어' }, boot: { name: '서버 브라우저', openBrowser: '{invalid}' } }, en);
  assert.equal(custom.translated, 1);
  assert.equal(custom.invalid, 1);
  assert.equal(custom.total, catalogIds(en).length);
  assert.deepEqual(custom.issues, [{ code: 'badPlaceholder', id: 'boot.openBrowser', detail: '{invalid}' }]);
  const korean = createTranslator('ko', [custom.catalog, en, kitEn]);
  assert.equal(korean.t('boot.name'), '서버 브라우저');
  assert.equal(korean.t('boot.openBrowser'), 'Open server browser');
  assert.equal(korean.t('kitLanguage.title'), 'Language');
});

test('browser overview, controls and navigation errors render in English', () => {
  try {
    bindTranslator(createTranslator('en', [en, kitEn]));
    assert.equal(pageLocation(''), 'No page URL yet');
    assert.equal(pageHost('about:blank'), 'Local demo page');
    assert.equal(agentStatus(null), 'No linked agent yet');
    assert.equal(actionTitle('browser_click'), 'Click page');
    assert.equal(tabGlyph('permission')?.label, 'Needs approval');
    assert.equal(controlLooks.manual.label, 'Manual');
    assert.match(droppedMessage([{ event: { kind: 'text', text: 'a' }, target: { tabId: 'one', viewRevision: 'v' } }])!, /1 character or key was not sent/);
    assert.match(droppedMessage([{ event: { kind: 'text', text: 'ab' }, target: { tabId: 'one', viewRevision: 'v' } }])!, /2 characters or keys were not sent/);
    assert.throws(() => normalizeNavigationUrl('file:///private/example'), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /[\u3400-\u9fff]/);
      assert.match(error.message, /http|web|URL/i);
      return true;
    });
  } finally {
    bindTranslator(createTranslator('zh-CN', [zh, kitZh]));
  }
  assert.equal(controlLooks.manual.label, '手动');
});

test('activity identity and batching survive a language change', () => {
  const log = new BrowserActivityLog();
  const page = { tabId: 'one', pageTitle: 'User page title', pageUrl: 'https://example.test/' };
  const id = log.start('manual', 'text', page);
  log.finish(id, false);
  assert.equal(log.snapshot()[0].action, '输入文字');
  try {
    bindTranslator(createTranslator('en', [en, kitEn]));
    assert.equal(log.snapshot()[0].action, 'Type text');
    assert.equal(actionTitle(log.snapshot()[0].actionId ?? log.snapshot()[0].action), 'Type text');
    assert.equal(log.continue('manual', 'text', page), id);
    assert.equal(log.snapshot().length, 1);
    assert.equal(log.snapshot()[0].pageTitle, page.pageTitle);
  } finally {
    bindTranslator(createTranslator('zh-CN', [zh, kitZh]));
  }
});

test('custom address-redaction text cannot expand replacement tokens into a secret URL', () => {
  try {
    bindTranslator(createTranslator('en', [{ serverError: { redactedAddress: '$&' } }, en, kitEn]));
    assert.equal(withoutAddresses('https://example.test/?token=private'), '$&');
  } finally {
    bindTranslator(createTranslator('zh-CN', [zh, kitZh]));
  }
});
