/**
 * Types for the part of React Native this plugin uses. Paseo supplies `react-native` to plugin bundles at run time (the
 * app's own copy), so the plugin installs nothing; this file only lets `tsc` check the settings screen without adding
 * React Native and its dependency tree to the dev dependencies. Keep it to what the code uses.
 */
declare module "react-native" {
  import type { ComponentType, ReactNode } from "react";

  export type ColorValue = string;
  export type DimensionValue = number | `${number}%` | "auto";
  export interface ViewStyle {
    readonly [property: string]: unknown;
    flex?: number;
    flexGrow?: number;
    flexShrink?: number;
    flexBasis?: DimensionValue;
    flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
    flexWrap?: "wrap" | "nowrap";
    alignItems?: "flex-start" | "flex-end" | "center" | "stretch" | "baseline";
    alignSelf?: "auto" | "flex-start" | "flex-end" | "center" | "stretch" | "baseline";
    justifyContent?: "flex-start" | "flex-end" | "center" | "space-between" | "space-around" | "space-evenly";
    gap?: number;
    rowGap?: number;
    columnGap?: number;
    position?: "absolute" | "relative";
    top?: DimensionValue;
    left?: DimensionValue;
    right?: DimensionValue;
    bottom?: DimensionValue;
    width?: DimensionValue;
    height?: DimensionValue;
    minWidth?: DimensionValue;
    maxWidth?: DimensionValue;
    minHeight?: DimensionValue;
    margin?: DimensionValue;
    marginTop?: DimensionValue;
    marginBottom?: DimensionValue;
    marginLeft?: DimensionValue;
    marginRight?: DimensionValue;
    marginHorizontal?: DimensionValue;
    marginVertical?: DimensionValue;
    padding?: DimensionValue;
    paddingTop?: DimensionValue;
    paddingBottom?: DimensionValue;
    paddingLeft?: DimensionValue;
    paddingRight?: DimensionValue;
    paddingHorizontal?: DimensionValue;
    paddingVertical?: DimensionValue;
    backgroundColor?: ColorValue;
    borderColor?: ColorValue;
    borderWidth?: number;
    borderTopWidth?: number;
    borderTopColor?: ColorValue;
    borderRadius?: number;
    overflow?: "visible" | "hidden";
    opacity?: number;
    pointerEvents?: "auto" | "none" | "box-none" | "box-only";
    transform?: readonly Record<string, unknown>[];
  }
  export interface TextStyle extends ViewStyle {
    color?: ColorValue;
    fontSize?: number;
    fontWeight?: "normal" | "bold" | "400" | "500" | "600" | "700" | "800";
    fontVariant?: readonly string[];
    fontFamily?: string;
    lineHeight?: number;
    letterSpacing?: number;
    textAlign?: "auto" | "left" | "right" | "center";
    textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  }
  type Falsy = undefined | null | false;
  export type StyleProp<T> = T | Falsy | readonly StyleProp<T>[];

  export interface LayoutChangeEvent {
    readonly nativeEvent: { readonly layout: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } };
  }
  export interface GestureResponderEvent {
    readonly nativeEvent: { readonly locationX: number; readonly locationY: number; readonly pageX: number; readonly pageY: number };
  }
  export interface AccessibilityActionEvent {
    readonly nativeEvent: { readonly actionName: string };
  }
  export type AccessibilityRole = "none" | "button" | "link" | "text" | "image" | "header" | "summary" | "adjustable" | "radio" | "radiogroup" | "switch" | "tab" | "tablist" | "progressbar" | "alert";
  export interface AccessibilityProps {
    accessible?: boolean;
    accessibilityRole?: AccessibilityRole;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityState?: { disabled?: boolean; selected?: boolean; checked?: boolean | "mixed"; busy?: boolean; expanded?: boolean };
    accessibilityValue?: { min?: number; max?: number; now?: number; text?: string };
    accessibilityActions?: readonly { name: string; label?: string }[];
    onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
    accessibilityLiveRegion?: "none" | "polite" | "assertive";
    "aria-label"?: string;
    "aria-selected"?: boolean;
    "aria-checked"?: boolean;
    "aria-expanded"?: boolean;
    "aria-valuemin"?: number;
    "aria-valuemax"?: number;
    "aria-valuenow"?: number;
    "aria-valuetext"?: string;
    testID?: string;
  }
  export interface ViewProps extends AccessibilityProps {
    /** react-native-web hands host components their DOM element; native gives a host instance. */
    ref?: { current: unknown } | ((instance: unknown) => void) | null;
    children?: ReactNode;
    style?: StyleProp<ViewStyle>;
    onLayout?: (event: LayoutChangeEvent) => void;
    hitSlop?: number | { top?: number; bottom?: number; left?: number; right?: number };
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: "auto" | "yes" | "no" | "no-hide-descendants";
  }
  export interface TextProps extends AccessibilityProps {
    children?: ReactNode;
    style?: StyleProp<TextStyle>;
    numberOfLines?: number;
    selectable?: boolean;
  }
  export interface PressableStateCallbackType {
    readonly pressed: boolean;
    readonly hovered?: boolean;
    readonly focused?: boolean;
  }
  export interface PressableProps extends AccessibilityProps {
    children?: ReactNode | ((state: PressableStateCallbackType) => ReactNode);
    style?: StyleProp<ViewStyle> | ((state: PressableStateCallbackType) => StyleProp<ViewStyle>);
    onPress?: (event: GestureResponderEvent) => void;
    disabled?: boolean;
    hitSlop?: number | { top?: number; bottom?: number; left?: number; right?: number };
  }
  export const View: ComponentType<ViewProps>;
  export const Text: ComponentType<TextProps>;
  export const Pressable: ComponentType<PressableProps>;
  export const ActivityIndicator: ComponentType<{ color?: ColorValue; size?: "small" | "large" | number; accessibilityLabel?: string }>;

  export interface PanResponderGestureState {
    readonly dx: number;
    readonly dy: number;
    readonly moveX: number;
    readonly moveY: number;
    readonly x0: number;
    readonly y0: number;
  }
  type PanHandler = (event: GestureResponderEvent, gesture: PanResponderGestureState) => void;
  type PanPredicate = (event: GestureResponderEvent, gesture: PanResponderGestureState) => boolean;
  export interface PanResponderCallbacks {
    onStartShouldSetPanResponder?: PanPredicate;
    onStartShouldSetPanResponderCapture?: PanPredicate;
    onMoveShouldSetPanResponder?: PanPredicate;
    onMoveShouldSetPanResponderCapture?: PanPredicate;
    onPanResponderGrant?: PanHandler;
    onPanResponderMove?: PanHandler;
    onPanResponderRelease?: PanHandler;
    onPanResponderTerminate?: PanHandler;
    onPanResponderTerminationRequest?: PanPredicate;
    onShouldBlockNativeResponder?: PanPredicate;
  }
  export interface PanResponderInstance {
    readonly panHandlers: Partial<ViewProps>;
  }
  export const PanResponder: { create(config: PanResponderCallbacks): PanResponderInstance };

  export const StyleSheet: {
    create<T extends { [name: string]: ViewStyle | TextStyle }>(styles: T): T;
    readonly hairlineWidth: number;
    readonly absoluteFillObject: { position: "absolute"; top: 0; left: 0; right: 0; bottom: 0 };
  };
  export const Platform: { readonly OS: "ios" | "android" | "web" | "windows" | "macos" };
  export const AccessibilityInfo: {
    isReduceMotionEnabled(): Promise<boolean>;
    addEventListener(event: "reduceMotionChanged", listener: (enabled: boolean) => void): { remove(): void };
  };
  export type AppStateStatus = "active" | "background" | "inactive" | "unknown" | "extension";
  export const AppState: {
    readonly currentState: AppStateStatus | null;
    addEventListener(event: "change", listener: (state: AppStateStatus) => void): { remove(): void };
  };

  type EasingFunction = (value: number) => number;
  export const Easing: {
    linear: EasingFunction;
    quad: EasingFunction;
    cubic: EasingFunction;
    sin: EasingFunction;
    in(easing: EasingFunction): EasingFunction;
    out(easing: EasingFunction): EasingFunction;
    inOut(easing: EasingFunction): EasingFunction;
  };
  export namespace Animated {
    interface InterpolationConfig {
      inputRange: readonly number[];
      outputRange: readonly number[] | readonly string[];
    }
    interface Interpolation {
      interpolate(config: InterpolationConfig): Interpolation;
    }
    class Value implements Interpolation {
      constructor(value: number);
      setValue(value: number): void;
      interpolate(config: InterpolationConfig): Interpolation;
    }
    interface CompositeAnimation {
      start(callback?: (result: { finished: boolean }) => void): void;
      stop(): void;
    }
    interface AnimationConfig {
      toValue: number;
      useNativeDriver: boolean;
      duration?: number;
      delay?: number;
      easing?: EasingFunction;
      isInteraction?: boolean;
      friction?: number;
      tension?: number;
    }
    function timing(value: Value, config: AnimationConfig): CompositeAnimation;
    function spring(value: Value, config: AnimationConfig): CompositeAnimation;
    function loop(animation: CompositeAnimation, config?: { iterations?: number }): CompositeAnimation;
    // Animated styles take interpolations where plain styles take numbers.
    const View: ComponentType<Omit<ViewProps, "style"> & { style?: unknown }>;
  }

  // Named by @getpaseo/plugin/client/react-native's declarations; this plugin does not use them.
  export type ScrollViewProps = ViewProps;
  export const ScrollView: ComponentType<ScrollViewProps>;
  export type ScrollView = { scrollTo(options: { x?: number; y?: number; animated?: boolean }): void };
  export type FlatListProps<Item> = ViewProps & { data: readonly Item[] };
  export type FlatList<Item> = { readonly __item?: Item };
  export type TextInputProps = ViewProps & { value?: string; onChangeText?: (text: string) => void };
  export type TextInput = { focus(): void; blur(): void };
}
