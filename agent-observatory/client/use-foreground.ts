import { useEffect, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

/** iOS reports `inactive` for the notification shade, calls and the app switcher; it hides the view like `background`. */
export const isForeground = (state: AppStateStatus | null | undefined) => state !== "background" && state !== "inactive";
export function useForeground(): boolean {
  const [foreground, setForeground] = useState(() => isForeground(AppState.currentState));
  useEffect(() => { const subscription = AppState.addEventListener("change", state => setForeground(isForeground(state))); return () => subscription.remove(); }, []);
  return foreground;
}
