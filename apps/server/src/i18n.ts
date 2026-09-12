/**
 * Server-side i18n for user-visible messages (API errors, env descriptions,
 * notification templates). Language is chosen once at boot from
 * OMP_DECK_LANG (en | zh, default en). Log lines stay English on purpose.
 *
 * Dictionary convention: key = the original English string (whitespace
 * normalized); the en resource maps each key to itself, zh carries the
 * translation. `i18n.t("…")` calls are scanned at build time to keep the
 * dictionaries in sync.
 */
import i18n from "i18next";

import en from "./i18n/en";
import zh from "./i18n/zh";

export type ServerLang = "en" | "zh";

export function resolveServerLang(env: Record<string, string | undefined>): ServerLang {
	const v = env.OMP_DECK_LANG?.trim().toLowerCase();
	if (v === "zh" || v === "zh-cn" || v === "zh-hans") return "zh";
	return "en";
}

void i18n.init({
	resources: {
		en: { translation: en },
		zh: { translation: zh },
	},
	lng: resolveServerLang(process.env),
	fallbackLng: "en",
	interpolation: { escapeValue: false },
	returnEmptyString: false,
});

export function getServerLang(): ServerLang {
	return i18n.language === "zh" ? "zh" : "en";
}

/**
 * Re-evaluate the language after the deck-managed .env has been loaded into
 * process.env (loadManagedEnvIntoProcess runs after module imports, so the
 * boot-time init above only sees the launching process env).
 */
export function applyDeckEnv(): void {
	const lang = resolveServerLang(process.env);
	if (i18n.language !== lang) void i18n.changeLanguage(lang);
}

export default i18n;
