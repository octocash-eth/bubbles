import { createContext, useCallback, useContext, useEffect } from "react";

export function ThemeMeta() {
  return <meta name="color-scheme" content="light" />;
}

type Theme = "light";
type Ctx = { theme: Theme; resolvedTheme: Theme; setTheme: (t: Theme) => void };
export const ThemeContext = createContext<Ctx>({ theme: "light", resolvedTheme: "light", setTheme: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // The app is light-only; keep <html> pinned to light.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("dark");
    root.setAttribute("data-theme", "light");
  }, []);

  const setTheme = useCallback((_t: Theme) => {}, []);

  return (
    <ThemeContext.Provider value={{ theme: "light", resolvedTheme: "light", setTheme }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
