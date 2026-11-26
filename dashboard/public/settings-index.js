/** @typedef {'settingsPage' | 'storage' | 'models' | 'own'} SettingsAnswer */
/** @typedef {{ id: string, label: string, icon: string, host: boolean, answer: SettingsAnswer }} SettingsEntry */
/** @typedef {{ label: string, entries: SettingsEntry[] }} SettingsGroup */

/** @type {{ phone: SettingsGroup[], mac: SettingsGroup[] }} */
export const SETTINGS_INDEX = {
  phone: [
    { label: 'Devices', entries: [
      { id: 'lifestream', label: 'Lifestream', icon: 'home', host: false, answer: 'own' },
      { id: 'this-phone', label: 'This iPhone', icon: 'phone-screen', host: false, answer: 'own' },
    ] },
    { label: 'Lifestream', entries: [
      { id: 'storage', label: 'Storage', icon: 'drive', host: false, answer: 'storage' },
      { id: 'time', label: 'Day and time', icon: 'time', host: false, answer: 'settingsPage' },
    ] },
    { label: 'App', entries: [
      { id: 'appearance', label: 'Appearance', icon: 'settings', host: false, answer: 'own' },
      { id: 'advanced', label: 'Advanced', icon: 'filter', host: false, answer: 'settingsPage' },
    ] },
    { label: 'About', entries: [
      { id: 'version', label: 'Version', icon: 'info', host: false, answer: 'own' },
      { id: 'privacy-policy', label: 'Privacy policy', icon: 'private', host: false, answer: 'own' },
    ] },
  ],
  mac: [
    { label: 'Lifestream', entries: [
      { id: 'home', label: 'General', icon: 'home', host: false, answer: 'own' },
      { id: 'storage', label: 'Storage', icon: 'drive', host: false, answer: 'storage' },
      { id: 'time', label: 'Day and time', icon: 'time', host: false, answer: 'settingsPage' },
      { id: 'recovery', label: 'Recovery key', icon: 'private', host: true, answer: 'own' },
    ] },
    { label: 'Devices', entries: [
      { id: 'mac', label: 'This Mac', icon: 'work-mac', host: false, answer: 'own' },
      { id: 'iphone', label: 'iPhone', icon: 'phone-screen', host: false, answer: 'own' },
      { id: 'chrome', label: 'Chrome extension', icon: 'web', host: false, answer: 'own' },
    ] },
    { label: 'Models', entries: [
      { id: 'models', label: 'AI models', icon: 'ai', host: false, answer: 'models' },
      { id: 'privacy', label: 'Privacy', icon: 'hidden', host: false, answer: 'own' },
      { id: 'meaning', label: 'Search by meaning', icon: 'search', host: false, answer: 'own' },
    ] },
    { label: 'App', entries: [
      { id: 'appearance', label: 'Appearance', icon: 'settings', host: false, answer: 'own' },
      { id: 'updates', label: 'Updates', icon: 'update', host: true, answer: 'own' },
      { id: 'advanced', label: 'Advanced', icon: 'filter', host: false, answer: 'settingsPage' },
    ] },
  ],
};
