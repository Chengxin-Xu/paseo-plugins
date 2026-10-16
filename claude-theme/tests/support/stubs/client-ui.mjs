const element = (name) => {
  const component = () => null;
  component.displayName = name;
  return component;
};
export const SettingsGroup = element("SettingsGroup");
export const SettingsSection = element("SettingsSection");
export const SettingsCard = element("SettingsCard");
export const SettingsRow = element("SettingsRow");
export const SettingsSwitch = element("SettingsSwitch");
export const SettingsSelect = element("SettingsSelect");
export const SettingsInput = element("SettingsInput");
export const SettingsAction = element("SettingsAction");
export const SidebarRow = element("SidebarRow");
export const SidebarSeparator = element("SidebarSeparator");
export const ExternalLink = element("ExternalLink");
