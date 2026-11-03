import Capacitor
import UIKit

/// Bridge di Capacitor con i plugin locali di Aulera.
class AuleraViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SpaggiariLoginPlugin())
    }
}
