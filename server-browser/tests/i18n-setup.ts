import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindTranslator, createTranslator } from '../shared/i18n';
import zh from '../shared/locales/zh-CN.json';
import kitZh from '../shared/locales/kit/zh-CN.json';

// Each test file runs in its own process with its own Paseo home: the locale service keeps state there
// (i18n-state.json, the language folder), which must not carry from one file to the next.
process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), 'server-browser-test-home-'));
// Existing tests assert the original Chinese output, independent of the test machine's locale.
bindTranslator(createTranslator('zh-CN', [zh, kitZh]));
