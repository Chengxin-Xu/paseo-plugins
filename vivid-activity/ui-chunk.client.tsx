import { DetailBody, ReasoningText } from "./client/activity-details";
import { ActivitySettings } from "./client/settings";

export default function chunk() {
  return { api: 1, createSurfaces() { return { detail: DetailBody, reasoning: ReasoningText, settings: ActivitySettings }; } };
}
