/**
 * Server-side i18n for user-visible messages (API errors, env descriptions,
 * notification templates). English only — Chinese locale was removed.
 * Log lines stay English on purpose.
 *
 * Dictionary convention: key = the original English string (whitespace
 * normalized); the en resource maps each key to itself.
 * `i18n.t("…")` calls are scanned at build time to keep the dictionaries in sync.
 */
import i18n from "i18next";

import en from "./i18n/en";

export type ServerLang = "en";

export function resolveServerLang(_env: Record<string, string | undefined>): ServerLang {
	return "en";
}

void i18n.init({
	resources: {
		en: { translation: en },
	},
	lng: "en",
	fallbackLng: "en",
	interpolation: { escapeValue: false },
	returnEmptyString: false,
});

export function getServerLang(): ServerLang {
	return "en";
}

/**
 * Re-evaluate the language after the deck-managed .env has been loaded into
 * process.env. Kept as a no-op-friendly re-apply so boot order stays stable.
 */
export function applyDeckEnv(): void {
	if (i18n.language !== "en") void i18n.changeLanguage("en");
}

export default i18n;
