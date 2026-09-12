import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";

export const LANG_STORAGE_KEY = "omp-deck:lang";
export const SUPPORTED_LANGS = ["en"] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

export function getStoredLang(): Lang {
	return "en";
}

export function setLang(_lang: Lang): void {
	try {
		localStorage.setItem(LANG_STORAGE_KEY, "en");
	} catch {
		// ignore storage failures
	}
	void i18n.changeLanguage("en");
}

i18n.use(initReactI18next).init({
	resources: {
		en: { translation: en },
	},
	lng: "en",
	fallbackLng: "en",
	interpolation: { escapeValue: false },
	returnEmptyString: false,
	missingKeyHandler: (_lngs, _ns, key) => {
		// Dev aid: collect every key that failed to resolve so the dictionary
		// can be completed (esp. keys passed via constants like t(section.label)).
		if (typeof window === "undefined" || !key) return;
		const w = window as unknown as { __missingI18nKeys?: string[] };
		w.__missingI18nKeys ??= [];
		if (!w.__missingI18nKeys.includes(key)) w.__missingI18nKeys.push(key);
	},
	saveMissing: true,
});

export default i18n;
