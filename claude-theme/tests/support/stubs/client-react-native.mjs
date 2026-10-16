const element = (name) => {
  const component = () => null;
  component.displayName = name;
  return component;
};
export const Icon = element("Icon");
export const Modal = Object.assign(element("Modal"), { Content: element("Modal.Content") });
export const ScrollView = element("ScrollView");
export const FlatList = element("FlatList");
export const TextInput = element("TextInput");
export const useToast = () => ({ show() {}, error() {} });
export const useRevealedText = (text) => text;
export const copyText = async () => {};
