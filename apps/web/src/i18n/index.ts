import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zh from "./locales/zh.json";

export const LANG_STORAGE_KEY = "omp-deck:lang";
export const SUPPORTED_LANGS = ["en", "zh"] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

export function getStoredLang(): Lang {
	try {
		const v = localStorage.getItem(LANG_STORAGE_KEY);
		if (v === "en" || v === "zh") return v;
	} catch {
		// localStorage unavailable; fall through to default
	}
	const nav = typeof navigator !== "undefined" ? String(navigator.language ?? "") : "";
	return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function setLang(lang: Lang): void {
	try {
		localStorage.setItem(LANG_STORAGE_KEY, lang);
	} catch {
		// ignore storage failures; in-memory switch still applies
	}
	void i18n.changeLanguage(lang);
}

i18n.use(initReactI18next).init({
	resources: {
		en: { translation: en },
		zh: { translation: zh },
	},
	lng: getStoredLang(),
	fallbackLng: "en",
	interpolation: { escapeValue: false },
	returnEmptyString: false,
	missingKeyHandler: (lngs, _ns, key) => {
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
