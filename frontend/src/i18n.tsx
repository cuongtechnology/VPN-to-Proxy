import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import en from "./locales/en";
import vi from "./locales/vi";
export type Key = keyof typeof en;
type Locale = "en" | "vi";
const Context = createContext({
  locale: "en" as Locale,
  setLocale: (_: Locale) => {},
  t: (key: Key, _?: Record<string, string>): string => en[key],
});
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => {
    try {
      return localStorage.getItem("vpntoproxy.locale") === "vi" ? "vi" : "en";
    } catch {
      return "en";
    }
  });
  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      localStorage.setItem("vpntoproxy.locale", locale);
    } catch {
      /* Language remains available for this session. */
    }
  }, [locale]);
  const t = (key: Key, params?: Record<string, string>) =>
    Object.entries(params ?? {}).reduce(
      (s, [k, v]) => s.replaceAll(`{{${k}}}`, v),
      (locale === "vi" ? vi : en)[key] as string,
    );
  return (
    <Context.Provider value={{ locale, setLocale, t }}>
      {children}
    </Context.Provider>
  );
}
export const useLanguage = () => useContext(Context);
