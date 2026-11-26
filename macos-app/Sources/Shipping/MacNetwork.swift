import Foundation
import HomeLink

public enum MacNetwork {
    public static func tell(_ link: HomeLink) async {
        let changes = link.mobileChanges()
        link.tell(network: link.mobile(pressed: false).stated)
        for await _ in changes { link.tell(network: link.mobile(pressed: false).stated) }
    }
}
