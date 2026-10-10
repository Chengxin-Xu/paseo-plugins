import { useEffect, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

/** iOS `inactive` (app switcher, notification shade, calls) counts as hidden too. */
export function isForeground(state: AppStateStatus | null | undefined) { return state !== "background" && state !== "inactive"; }

/** True while the app is in the foreground. On web, React Native Web maps page visibility onto AppState. */
export function useForeground(): boolean {
  const [foreground, setForeground] = useState(() => isForeground(AppState.currentState));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => setForeground(isForeground(state)));
    setForeground(isForeground(AppState.currentState));
    return () => subscription?.remove();
  }, []);
  return foreground;
}
