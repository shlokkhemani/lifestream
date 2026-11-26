import Foundation

extension HomeLink {
    public enum SettingsIndex {
        public enum Answer: String, Sendable, Equatable {
            case settingsPage
            case storage
            case modelDefaults
            case modelProviders
            case own
        }

        public struct Entry: Sendable, Equatable {
            public let id: String
            public let label: String
            public let icon: String
            public let host: Bool
            public let answer: Answer
        }

        public struct Group: Sendable, Equatable {
            public let label: String
            public let entries: [Entry]
        }

        public static let phone: [Group] = [
            Group(label: "Devices", entries: [
                Entry(id: "lifestream", label: "Lifestream", icon: "home", host: false, answer: .own),
                Entry(id: "this-phone", label: "This iPhone", icon: "phone-screen", host: false, answer: .own),
            ]),
            Group(label: "Lifestream", entries: [
                Entry(id: "storage", label: "Storage", icon: "drive", host: false, answer: .storage),
                Entry(id: "time", label: "Day and time", icon: "time", host: false, answer: .settingsPage),
            ]),
            Group(label: "App", entries: [
                Entry(id: "appearance", label: "Appearance", icon: "settings", host: false, answer: .own),
                Entry(id: "advanced", label: "Advanced", icon: "filter", host: false, answer: .settingsPage),
            ]),
            Group(label: "About", entries: [
                Entry(id: "version", label: "Version", icon: "info", host: false, answer: .own),
                Entry(id: "privacy-policy", label: "Privacy policy", icon: "private", host: false, answer: .own),
            ]),
        ]

        public static let mac: [Group] = [
            Group(label: "Lifestream", entries: [
                Entry(id: "home", label: "General", icon: "home", host: false, answer: .own),
                Entry(id: "storage", label: "Storage", icon: "drive", host: false, answer: .storage),
                Entry(id: "time", label: "Day and time", icon: "time", host: false, answer: .settingsPage),
                Entry(id: "recovery", label: "Recovery key", icon: "private", host: true, answer: .own),
            ]),
            Group(label: "Devices", entries: [
                Entry(id: "mac", label: "This Mac", icon: "work-mac", host: false, answer: .own),
                Entry(id: "iphone", label: "iPhone", icon: "phone-screen", host: false, answer: .own),
                Entry(id: "chrome", label: "Chrome extension", icon: "web", host: false, answer: .own),
            ]),
            Group(label: "Models", entries: [
                Entry(id: "defaults", label: "Default models", icon: "ai", host: false, answer: .modelDefaults),
                Entry(id: "providers", label: "Providers", icon: "ai-apps", host: false, answer: .modelProviders),
                Entry(id: "privacy", label: "Privacy", icon: "hidden", host: false, answer: .own),
                Entry(id: "meaning", label: "Search by meaning", icon: "search", host: false, answer: .own),
            ]),
            Group(label: "App", entries: [
                Entry(id: "appearance", label: "Appearance", icon: "settings", host: false, answer: .own),
                Entry(id: "updates", label: "Updates", icon: "update", host: true, answer: .own),
                Entry(id: "advanced", label: "Advanced", icon: "filter", host: false, answer: .settingsPage),
            ]),
        ]
    }
}
