// Stand-ins for the React Native the Paseo app supplies: enough to import (not render) the plugin's views in Node.
const element = (name) => {
  const component = () => null;
  component.displayName = name;
  return component;
};
export const View = element("View");
export const Text = element("Text");
export const Pressable = element("Pressable");
export const ActivityIndicator = element("ActivityIndicator");
export const ScrollView = element("ScrollView");
export const StyleSheet = { create: (styles) => styles, hairlineWidth: 1, absoluteFillObject: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } };
export const Platform = { OS: "web" };
export const PanResponder = { create: () => ({ panHandlers: {} }) };
export const AccessibilityInfo = { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) };
export const AppState = { currentState: "active", addEventListener: () => ({ remove() {} }) };
const linear = (value) => value;
export const Easing = { linear, quad: linear, cubic: linear, sin: linear, in: (easing) => easing, out: (easing) => easing, inOut: (easing) => easing };
function Value(value) {
  this.value = value;
}
Value.prototype.setValue = function setValue(value) {
  this.value = value;
};
Value.prototype.interpolate = function interpolate() {
  return this;
};
const animation = () => ({ start() {}, stop() {} });
export const Animated = { Value, View: element("Animated.View"), timing: animation, spring: animation, loop: animation };
