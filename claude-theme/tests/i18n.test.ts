import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { auditCatalogs, findMessageIds, findUntranslated } from "../server/i18n-audit.ts";
import { BUILTIN_CATALOGS } from "../server/locales.ts";
import { themeName } from "../shared/custom.ts";
import { bindTranslator, catalogIds, checkCatalog, createTranslator, type Catalog } from "../shared/i18n.ts";
import { t } from "../shared/text.ts";
import en from "../shared/locales/en.json";
import zh from "../shared/locales/zh-CN.json";
import kitEn from "../shared/locales/kit/en.json";
import kitZh from "../shared/locales/kit/zh-CN.json";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the built-in catalogs have the same messages and placeholders", () => {
  assert.deepEqual(auditCatalogs({ zh, en }), []);
});

test("no interface text is left untranslated in the source", () => {
  assert.deepEqual(findUntranslated(root), []);
});

test("every message is used and every named message exists", () => {
  const ids = catalogIds(zh);
  const named = findMessageIds(root, zh);
  assert.deepEqual([...named].filter((id) => !ids.includes(id)), []);
  assert.deepEqual(ids.filter((id) => !named.has(id)), []);
});

test("the screens speak English and Chinese, plurals included", () => {
  try {
    bindTranslator(createTranslator("en", [en, kitEn]));
    assert.equal(t("boot.customThemeName"), "🎨 Custom");
    assert.equal(t("boot.settingsTitle"), "Custom theme");
    assert.equal(t("custom.notInUse", { name: "🎨 Custom" }), "Not selected yet. Choose “🎨 Custom” in Settings → Appearance → Theme, and every change here will recolor the whole app.");
    assert.equal(t("checks.allPass", { total: 25 }), "All 25 checks pass");
    assert.equal(t("checks.someFail", { count: 1, total: 25 }), "1 of 25 checks fails");
    assert.equal(t("checks.someFail", { count: 3, total: 25 }), "3 of 25 checks fail");
    bindTranslator(createTranslator("zh-CN", [zh, kitZh]));
    assert.equal(t("boot.customThemeName"), "🎨 自定义");
    assert.equal(t("boot.settingsTitle"), "自定义主题");
    assert.equal(t("checks.someFail", { count: 3, total: 25 }), "25 项中有 3 项未达标");
  } finally {
    bindTranslator(null);
  }
});

test("a user's language uses what it translates and English for the rest", () => {
  const reference = { ...en, ...kitEn } as Catalog;
  const german = checkCatalog({ $meta: { name: "Deutsch" }, boot: { customThemeName: "🎨 Eigenes", settingsTitle: "{farbe}" } }, reference);
  assert.equal(german.translated, 1);
  assert.equal(german.invalid, 1);
  assert.deepEqual(german.issues, [{ code: "badPlaceholder", id: "boot.settingsTitle", detail: "{farbe}" }]);
  const translator = createTranslator("de", [german.catalog, en, kitEn]);
  assert.equal(translator.t("boot.customThemeName"), "🎨 Eigenes");
  assert.equal(translator.t("boot.settingsTitle"), "Custom theme");
  assert.equal(translator.t("kitLanguage.title"), "Language");
});

test("translators get this plugin's words and only the kit sections it shows", () => {
  for (const language of ["zh-CN", "en"] as const) {
    const [own, kit] = BUILTIN_CATALOGS[language];
    assert.equal(own, language === "en" ? en : zh);
    assert.deepEqual(Object.keys(kit!).sort(), ["kitLanguage", "kitLazy", "kitText"]);
    assert.ok(catalogIds(kit!).length > 10);
  }
});

test("each built-in theme name fits the app's theme list", () => {
  for (const catalog of [en, zh]) {
    const name = catalog.boot.customThemeName;
    assert.equal(themeName(name), name);
    assert.match(name, /^\p{Extended_Pictographic}/u);
  }
});
