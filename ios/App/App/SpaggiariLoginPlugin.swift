import Capacitor
import UIKit
import WebKit

/// Login ClasseViva con SPID/CIE per Aulera (iOS).
///
/// Apre la pagina di login UFFICIALE di ClasseViva in una WKWebView dedicata. Lo studente si
/// autentica con il proprio gestore SPID o con la CIE: le credenziali non passano da Aulera.
/// Dopo il login il plugin legge il cookie di sessione PHPSESSID (HttpOnly, invisibile a
/// JavaScript) dal WKHTTPCookieStore e lo invia alla pagina con l'evento "sessionCandidate";
/// la pagina lo fa verificare al backend e chiama close() (o resume() se non è ancora valido).
///
/// Eventi: "sessionCandidate" {phpsessid, url}, "closed" {}.
@objc(SpaggiariLoginPlugin)
public class SpaggiariLoginPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SpaggiariLoginPlugin"
    public let jsName = "SpaggiariLogin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise),
    ]

    static let spaggiariURL = "https://web.spaggiari.eu"
    static let defaultLoginURL = spaggiariURL + "/home/app/default/login.php"
    /// Schema URL con cui l'app CieID riporta l'utente in Aulera (registrato in Info.plist).
    static let returnScheme = "aulera"
    static weak var shared: SpaggiariLoginPlugin?

    private var loginController: SpaggiariLoginViewController?

    public override func load() {
        SpaggiariLoginPlugin.shared = self
    }

    @objc func open(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? SpaggiariLoginPlugin.defaultLoginURL
        guard url.hasPrefix(SpaggiariLoginPlugin.spaggiariURL + "/"), let target = URL(string: url) else {
            call.reject("URL non consentito")
            return
        }
        let clear = call.getBool("clearSession") ?? true
        let present = { [weak self] in
            guard let self = self else { return }
            let controller = SpaggiariLoginViewController(startURL: target, plugin: self)
            let nav = UINavigationController(rootViewController: controller)
            nav.modalPresentationStyle = .fullScreen
            self.loginController = controller
            self.bridge?.viewController?.present(nav, animated: true)
            call.resolve()
        }
        DispatchQueue.main.async {
            if clear {
                SpaggiariLoginPlugin.clearSpaggiariCookies { present() }
            } else {
                present()
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.loginController?.dismiss(animated: true)
            self.loginController = nil
            call.resolve()
        }
    }

    @objc func resume(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.loginController?.resumeAfterFailedCheck()
            call.resolve()
        }
    }

    @objc func clearSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            SpaggiariLoginPlugin.clearSpaggiariCookies { call.resolve() }
        }
    }

    /// Apre un URL https nel browser di sistema (download di allegati e materiali).
    @objc func openExternal(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), raw.hasPrefix("https://"), let url = URL(string: raw) else {
            call.reject("URL non valido")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { ok in
                ok ? call.resolve() : call.reject("Impossibile aprire il file")
            }
        }
    }

    // MARK: - Chiamate dal controller

    func emitSessionCandidate(phpsessid: String, url: String) {
        notifyListeners("sessionCandidate", data: ["phpsessid": phpsessid, "url": url])
    }

    func emitClosed() {
        loginController = nil
        notifyListeners("closed", data: [:])
    }

    /// Ritorno dall'app CieID: aulera://<url https> → riapre l'URL nella WebView di login.
    @discardableResult
    static func handleReturnURL(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == returnScheme else { return false }
        var rest = url.absoluteString
        if let range = rest.range(of: "\(returnScheme)://", options: [.caseInsensitive, .anchored]) {
            rest.removeSubrange(range)
        }
        if !rest.lowercased().hasPrefix("http") { rest = "https://" + rest }
        guard let next = URL(string: rest), next.scheme == "https" else { return false }
        shared?.loginController?.load(next)
        return true
    }

    static func clearSpaggiariCookies(_ done: @escaping () -> Void) {
        let store = WKWebsiteDataStore.default().httpCookieStore
        store.getAllCookies { cookies in
            let targets = cookies.filter { $0.domain.hasSuffix("spaggiari.eu") }
            if targets.isEmpty { done(); return }
            let group = DispatchGroup()
            for cookie in targets {
                group.enter()
                store.delete(cookie) { group.leave() }
            }
            group.notify(queue: .main) { done() }
        }
    }

    static func readPhpSessId(_ done: @escaping (String?) -> Void) {
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
            let value = cookies.first { $0.name == "PHPSESSID" && $0.domain.hasSuffix("spaggiari.eu") && !$0.value.isEmpty }?.value
            DispatchQueue.main.async { done(value) }
        }
    }
}

/// WebView dedicata al login sul sito ufficiale di ClasseViva.
final class SpaggiariLoginViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private static let authPathHints = ["login", "auth-p7", "sso", "spid", "cie", "idp", "saml", "logout"]
    private static let verifyTimeout: TimeInterval = 9

    private let startURL: URL
    private weak var plugin: SpaggiariLoginPlugin?
    private var webView: WKWebView!
    private let overlay = UIView()
    private let progress = UIProgressView(progressViewStyle: .bar)
    private var verifying = false
    private var lastPostLoginURL: String?
    private var retries = 0
    private var timeoutWork: DispatchWorkItem?
    private var progressObservation: NSKeyValueObservation?

    init(startURL: URL, plugin: SpaggiariLoginPlugin) {
        self.startURL = startURL
        self.plugin = plugin
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) non supportato") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.02, green: 0.03, blue: 0.04, alpha: 1)
        title = "Accesso a ClasseViva"
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Chiudi", style: .plain, target: self, action: #selector(closeTapped))

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        progress.translatesAutoresizingMaskIntoConstraints = false
        progress.tintColor = UIColor(red: 0.25, green: 0.84, blue: 0.78, alpha: 1)
        view.addSubview(progress)

        overlay.translatesAutoresizingMaskIntoConstraints = false
        overlay.backgroundColor = view.backgroundColor
        overlay.isHidden = true
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.color = .white
        spinner.startAnimating()
        let label = UILabel()
        label.text = "Accesso ad Aulera in corso…"
        label.textColor = .white
        label.font = .preferredFont(forTextStyle: .headline)
        let stack = UIStackView(arrangedSubviews: [spinner, label])
        stack.axis = .vertical
        stack.spacing = 16
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(stack)
        view.addSubview(overlay)

        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            progress.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            progress.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: view.topAnchor),
            overlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            overlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
        ])

        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] web, _ in
            self?.progress.progress = Float(web.estimatedProgress)
            self?.progress.isHidden = web.estimatedProgress >= 1
        }
        webView.load(URLRequest(url: startURL))
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || navigationController?.isBeingDismissed == true {
            timeoutWork?.cancel()
            plugin?.emitClosed()
        }
    }

    @objc private func closeTapped() {
        dismiss(animated: true)
    }

    func load(_ url: URL) {
        webView.load(URLRequest(url: url))
    }

    func resumeAfterFailedCheck() {
        timeoutWork?.cancel()
        verifying = false
        overlay.isHidden = true
        // ClasseViva può completare la sessione un attimo dopo: riprova sulla stessa pagina.
        if let url = lastPostLoginURL, retries < 3 {
            retries += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.detectSession(url) }
        }
    }

    private func isPostLoginPage(_ url: URL?) -> Bool {
        guard let url = url, let host = url.host?.lowercased() else { return false }
        guard host == "spaggiari.eu" || host.hasSuffix(".spaggiari.eu"), !host.hasPrefix("www.") else { return false }
        let path = url.path.lowercased()
        return !SpaggiariLoginViewController.authPathHints.contains { path.contains($0) }
    }

    private func detectSession(_ urlString: String?) {
        guard let urlString = urlString, let url = URL(string: urlString), isPostLoginPage(url) else { return }
        if urlString != lastPostLoginURL { retries = 0 }
        lastPostLoginURL = urlString
        guard !verifying else { return }
        SpaggiariLoginPlugin.readPhpSessId { [weak self] value in
            guard let self = self, let value = value, !self.verifying else { return }
            self.verifying = true
            self.overlay.isHidden = false
            let work = DispatchWorkItem { [weak self] in self?.resumeAfterFailedCheck() }
            self.timeoutWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + SpaggiariLoginViewController.verifyTimeout, execute: work)
            self.plugin?.emitSessionCandidate(phpsessid: value, url: urlString)
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
        let absolute = url.absoluteString
        let scheme = url.scheme?.lowercased() ?? ""

        // CIE con app CieID (flusso IPZS): CIEID://<url>&sourceApp=<schema di ritorno>.
        if absolute.contains("/OpenApp"), let cie = URL(string: "CIEID://\(absolute)&sourceApp=\(SpaggiariLoginPlugin.returnScheme)") {
            UIApplication.shared.open(cie, options: [:]) { ok in
                if !ok, let store = URL(string: "https://apps.apple.com/it/app/cieid/id1504644677") {
                    UIApplication.shared.open(store)
                }
            }
            decisionHandler(.cancel)
            return
        }
        if scheme == "http" || scheme == "https" || scheme == "about" || scheme == "blob" || scheme == "data" {
            decisionHandler(.allow)
            return
        }
        // Altri schemi (app dei gestori SPID, mailto, tel…): app esterna.
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        detectSession(webView.url?.absoluteString)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        detectSession(webView.url?.absoluteString)
    }

    // Link con target=_blank: aprili nella stessa WebView.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }
}
