import AppKit

enum LaunchWindow: Equatable {
    case setup, connectors, dashboard, front
    case page(String)

    enum Opening: Equatable, CustomStringConvertible {
        case atLogin
        case afterUpdate
        case byPerson

        var description: String {
            switch self {
            case .atLogin: "at_login"
            case .afterUpdate: "after_update"
            case .byPerson: "by_person"
            }
        }

        init(eventID: AEEventID?, propData: OSType?, restoreState: OSType?, updated: Bool = false) {
            let open = eventID == AEEventID(kAEOpenApplication)
            let login = propData == OSType(keyAELaunchedAsLogInItem) || restoreState == OSType(kAEYes)
            self = open && updated ? .afterUpdate : open && login ? .atLogin : .byPerson
        }

        init(_ event: NSAppleEventDescriptor?, updated: Bool = false) {
            self.init(eventID: event?.eventID, propData: event?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue,
                      restoreState: event?.paramDescriptor(forKeyword: keyAERestoreAppState)?.enumCodeValue, updated: updated)
        }
    }

    static func shown(_ opening: Opening, world: SetupWorld, open: Bool, needs: Bool, onboarding: Bool, resume: String?) -> LaunchWindow? {
        if world.opensAt != nil { return .setup }
        guard opening == .byPerson else { return nil }
        if open { return .front }
        if let resume { return .page(resume) }
        return needs && !onboarding ? .connectors : .dashboard
    }
}
