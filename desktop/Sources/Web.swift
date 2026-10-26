import AppKit
import Observation
import WebKit

/// One tab per admin UI from config.json, reachable only through the SSH tunnel.
/// The first one is the dashboard. Order = Cmd-1 ... Cmd-9.
struct Tab: Hashable, Identifiable, CustomStringConvertible {
    let rawValue: Int
    var id: Int { rawValue }
    var description: String { title }

    init?(rawValue: Int) {
        guard rawValue >= 0, rawValue < Self.uis.count else { return nil }
        self.rawValue = rawValue
    }
    private init(index: Int) { rawValue = index }

    static let dashboard = Tab(index: 0)
    private static var uis: [RemoteUI] { Config.current?.uis ?? AppConfig.defaultUIs }
    static var allCases: [Tab] { uis.indices.map { Tab(index: $0) } }

    var ui: RemoteUI { Self.uis.indices.contains(rawValue) ? Self.uis[rawValue] : AppConfig.defaultUIs[0] }
    var title: String { ui.name }
    /// Port on the server (127.0.0.1); locally: `Ports.local(port)`.
    var port: Int { ui.port }
    var home: URL { Ports.url(port, ui.path ?? "/") }
    var symbol: String {
        if self == .dashboard { return "gauge.with.dots.needle.33percent" }
        let n = title.lowercased()
        if n.contains("portainer") || n.contains("docker") { return "shippingbox" }
        if n.contains("proxy") || n.contains("nginx") { return "arrow.triangle.branch" }
        if n.contains("grafana") || n.contains("monitor") || n.contains("stats") { return "chart.xyaxis.line" }
        if n.contains("admin") || n.contains("key") || n.contains("auth") { return "key.horizontal" }
        return "macwindow"
    }
    /// Cmd-1 ... Cmd-9; tabs beyond the ninth have no shortcut.
    var shortcut: String { rawValue < 9 ? "\(rawValue + 1)" : "" }

    /// Tab for an address in the tunnel (http://localhost:<local port>).
    static func matching(_ url: URL) -> Tab? {
        guard Ports.isLocal(url), let remote = Ports.remote(forLocal: url.port ?? 80) else { return nil }
        return allCases.first { $0.port == remote }
    }
}

/// Keeps one WKWebView per UI. Created on first use; the state is kept afterwards.
@MainActor @Observable
final class Web: NSObject {
    static let shared = Web()

    var selected: Tab = Tab(rawValue: UserDefaults.standard.integer(forKey: "tab")) ?? .dashboard
    var progress: Double = 1
    var loading = false
    var failure: [Tab: String] = [:]
    var notice: String?

    @ObservationIgnored private(set) var views: [Tab: WKWebView] = [:]
    @ObservationIgnored private var observers: [NSKeyValueObservation] = []
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    @ObservationIgnored weak var container: WebContainer?

    // MARK: Tabs

    func select(_ tab: Tab, url: URL? = nil) {
        selected = tab
        UserDefaults.standard.set(tab.rawValue, forKey: "tab")
        let isNew = views[tab] == nil
        let wv = view(for: tab)
        if let url, url != wv.url { wv.load(URLRequest(url: url)) }
        else if isNew || (wv.url == nil && !wv.isLoading) { wv.load(URLRequest(url: tab.home)) }
        updateProgress()
        container?.show(wv)
    }

    /// Choose a tab; it only loads once there is a connection.
    func choose(_ tab: Tab) {
        if Store.shared.isReady { select(tab) } else { selected = tab; UserDefaults.standard.set(tab.rawValue, forKey: "tab") }
    }

    /// Load only once there is a connection.
    func activate() {
        if let page = pendingPage, selected == .dashboard {
            pendingPage = nil
            return select(.dashboard, url: Self.dashboardURL(page))
        }
        if failure[selected] != nil { retry() } else { select(selected) }
    }

    @ObservationIgnored private var pendingPage: DashPage?

    static func dashboardURL(_ page: DashPage) -> URL {
        Ports.url(Tab.dashboard.port, "/\(page.hash)")
    }

    /// Open a page in the dashboard (widget click). If the dashboard is loaded already,
    /// only set the hash - the page then switches without reloading.
    func open(page: DashPage) {
        guard Store.shared.isReady else {
            pendingPage = page
            choose(.dashboard)
            return
        }
        if let wv = views[.dashboard], !wv.isLoading, let u = wv.url, Tab.matching(u) == .dashboard {
            select(.dashboard)
            wv.evaluateJavaScript("location.hash = '\(page.hash)'", completionHandler: nil)
        } else {
            select(.dashboard, url: Self.dashboardURL(page))
        }
    }

    func view(for tab: Tab) -> WKWebView {
        if let v = views[tab] { return v }
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()          // logins persist
        cfg.applicationNameForUserAgent = "Version/26.0 Safari/605.1.15"
        cfg.preferences.isElementFullscreenEnabled = true
        Snapshot.attachConsole(cfg)
        if tab == .dashboard {
            // Touch ID for dangerous actions (WebAuthn does not work in WKWebView, see TouchID.swift).
            for name in TouchIDBridge.names {
                cfg.userContentController.addScriptMessageHandler(TouchIDBridge.shared, contentWorld: .page, name: name)
            }
        }
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = true
        wv.allowsMagnification = true
        wv.isInspectable = false
        wv.underPageBackgroundColor = NSColor(srgbRed: 5 / 255, green: 5 / 255, blue: 5 / 255, alpha: 1)
        wv.setValue(false, forKey: "drawsBackground")   // no white flash before the first paint
        wv.autoresizingMask = [.width, .height]
        views[tab] = wv
        observers.append(wv.observe(\.estimatedProgress, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.updateProgress() }
        })
        observers.append(wv.observe(\.isLoading, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.updateProgress() }
        })
        return wv
    }

    private func updateProgress() {
        guard let wv = views[selected] else { loading = false; return }
        if loading != wv.isLoading { loading = wv.isLoading }
        let p = wv.isLoading ? wv.estimatedProgress : 1
        if abs(p - progress) > 0.02 || p == 1 { progress = p }
    }

    private func tab(of wv: WKWebView) -> Tab? { views.first { $0.value === wv }?.key }

    // MARK: Actions

    func reload() {
        guard let wv = views[selected] else { return select(selected) }
        failure[selected] = nil
        if wv.url == nil { wv.load(URLRequest(url: selected.home)) } else { wv.reload() }
    }

    func retry() {
        failure[selected] = nil
        let wv = view(for: selected)
        wv.load(URLRequest(url: wv.url ?? selected.home))
        container?.show(wv)
    }

    func zoom(_ step: Double?) {
        guard let wv = views[selected] else { return }
        wv.pageZoom = step.map { min(3, max(0.5, wv.pageZoom + $0)) } ?? 1
    }

    /// Locked: hide the web views (also from window previews) and keep input away from them.
    func setHidden(_ hidden: Bool) {
        container?.isHidden = hidden
        // After unlocking the page gets the keyboard back (on lock: makeFirstResponder(nil)).
        if !hidden, let wv = views[selected], let w = wv.window { w.makeFirstResponder(wv) }
    }

    /// The local ports changed (the preferred ones were busy) or the configuration changed:
    /// drop all web views and load again.
    func portsChanged() {
        for v in views.values { v.removeFromSuperview() }
        views = [:]
        observers = []
        failure = [:]
        if Tab(rawValue: selected.rawValue) == nil { selected = .dashboard }
        if Store.shared.isReady { select(selected) }
    }

    func goBack() { views[selected]?.goBack() }
    func goForward() { views[selected]?.goForward() }

    func openInBrowser() {
        NSWorkspace.shared.open(views[selected]?.url ?? selected.home)
    }

    func show(notice text: String) {
        noticeTask?.cancel()
        notice = text
        noticeTask = Task {
            try? await Task.sleep(for: .seconds(3))
            if !Task.isCancelled { notice = nil }
        }
    }

    // MARK: Targets

    /// Point addresses of a UI at the tunnel: `http://localhost:<remote port>` (a UI that redirects
    /// to its own port on the server) and `http(s)://<host>:<remote port>` -> http://localhost:<local port>.
    private func fixed(_ url: URL) -> URL {
        guard let port = url.port, Ports.remote(forLocal: port) == nil, Ports.remote.contains(port),
              Ports.isLocal(url) || (!Server.host.isEmpty && url.host == Server.host),
              var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        c.scheme = "http"
        c.host = Ports.host
        c.port = Ports.local(port)
        return c.url ?? url
    }

    /// Where does a link go? A UI in the tunnel -> its tab, everything else -> the browser.
    private func route(_ raw: URL, from tab: Tab?) -> Bool {
        let url = fixed(raw)
        if let target = Tab.matching(url) {
            if target == tab {
                if url == raw { return true }
                views[target]?.load(URLRequest(url: url))
                return false
            }
            select(target, url: url)
            AppDelegate.shared?.showWindow(tab: nil)
            return false
        }
        NSWorkspace.shared.open(url)
        return false
    }
}

// MARK: - Navigation

extension Web: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { return decisionHandler(.download) }
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return decisionHandler(.allow) }
        // Just load subframes and internal schemes
        if action.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
        if ["about", "blob", "data", "javascript"].contains(scheme) { return decisionHandler(.allow) }
        if scheme != "http" && scheme != "https" {
            NSWorkspace.shared.open(url)          // mailto: etc.
            return decisionHandler(.cancel)
        }
        decisionHandler(route(url, from: tab(of: webView)) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if !response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") {
            decisionHandler(.download)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if let t = tab(of: webView), failure[t] != nil { failure[t] = nil }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(webView, error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(webView, error)
    }

    private func fail(_ webView: WKWebView, _ error: Error) {
        let e = error as NSError
        // cancelled, replaced by a download or by a redirect
        if e.code == NSURLErrorCancelled || (e.domain == "WebKitErrorDomain" && [102, 204].contains(e.code)) { return }
        guard let t = tab(of: webView) else { return }
        failure[t] = e.localizedDescription
        updateProgress()
        // Maybe the connection is gone - check again
        Task { await Store.shared.refresh() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

// MARK: - Windows, dialogs, uploads

extension Web: WKUIDelegate {
    /// target=_blank and window.open
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "http" || url.scheme == "https" {
            if Tab.matching(fixed(url)) == tab(of: webView) { webView.load(URLRequest(url: fixed(url))) }
            else { _ = route(url, from: nil) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        if let w = webView.window {
            panel.beginSheetModal(for: w) { r in completionHandler(r == .OK ? panel.urls : nil) }
        } else {
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        sheet(a, webView) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        sheet(a, webView) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        let a = NSAlert()
        a.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        sheet(a, webView) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    private func sheet(_ a: NSAlert, _ webView: WKWebView, _ done: @escaping @MainActor (NSApplication.ModalResponse) -> Void) {
        if let w = webView.window { a.beginSheetModal(for: w) { r in MainActor.assumeIsolated { done(r) } } }
        else { done(a.runModal()) }
    }
}

// MARK: - Downloads → ~/Downloads

extension Web: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping @MainActor (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = suggestedFilename.isEmpty ? "Download" : suggestedFilename
        var url = dir.appendingPathComponent(name)
        let base = url.deletingPathExtension().lastPathComponent, ext = url.pathExtension
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let path = download.progress.fileURL?.path else { return show(notice: "Download finished") }
        // makes the Downloads stack in the Dock bounce
        DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: path)
        show(notice: "Saved to Downloads: \((path as NSString).lastPathComponent)")
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        show(notice: "Download failed: \(error.localizedDescription)")
    }
}

// MARK: - Container holding the web view of the active tab

final class WebContainer: NSView {
    override var isFlipped: Bool { true }

    func show(_ wv: WKWebView) {
        if wv.superview !== self {
            wv.frame = bounds
            addSubview(wv)
        }
        for v in subviews { v.isHidden = v !== wv }
    }
}
