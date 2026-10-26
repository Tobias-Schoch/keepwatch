import AppKit
import WebKit

/// Only for testing a build: `KEEPWATCH_SNAPSHOT=/path/folder .../Keepwatch` writes `window.png`
/// and `statusicon.png` there after a few seconds. Without the variable nothing happens.
enum Snapshot {
    @MainActor static func scheduleIfRequested() {
        guard let dir = ProcessInfo.processInfo.environment["KEEPWATCH_SNAPSHOT"], !dir.isEmpty else { return }
        let delay = Double(ProcessInfo.processInfo.environment["KEEPWATCH_SNAPSHOT_DELAY"] ?? "") ?? 9
        let url = URL(fileURLWithPath: dir)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        if let t = ProcessInfo.processInfo.environment["KEEPWATCH_SNAPSHOT_TAB"], let n = Int(t), let tab = Tab(rawValue: n) {
            Web.shared.choose(tab)
        }
        scheduleBackupSeries(url)
        scheduleTouchIDProbe(url)
        scheduleClickProbe(url)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            if let w = AppDelegate.shared?.mainWindow {
                _ = capture(windowID: CGWindowID(w.windowNumber), to: url.appendingPathComponent("window.png"))
                // Do clicks in the title bar reach our own bar?
                if let frame = w.contentView?.superview {
                    var lines = ""
                    for x in [frame.bounds.midX, frame.bounds.maxX - 60, 150] {
                        let p = NSPoint(x: x, y: frame.bounds.maxY - 18)
                        let hit = frame.hitTest(p)
                        lines += "x=\(Int(x)): \(hit.map { String(describing: type(of: $0)) } ?? "nil")\n"
                    }
                    let top = w.frame.height - w.contentLayoutRect.height
                    lines += "title bar: \(top) pt\n"
                    lines += "tab: \(Web.shared.selected) failures: \(Web.shared.failure)\n"
                    lines += "tunnel: \(Tunnel.shared.state) port offset \(Ports.offset) · locked: \(AppLock.shared.locked) · phase: \(Store.shared.phase)\n"
                    for (t, v) in Web.shared.views { lines += "  \(t): \(v.url?.absoluteString ?? "-") loading=\(v.isLoading)\n" }
                    try? lines.write(to: url.appendingPathComponent("hittest.txt"), atomically: true, encoding: .utf8)
                }
            }
            let strip = NSImage(size: NSSize(width: 84, height: 44), flipped: false) { _ in
                for (row, name) in [NSAppearance.Name.darkAqua, .aqua].enumerated() {
                    (row == 0 ? NSColor(white: 0.12, alpha: 1) : NSColor(white: 0.92, alpha: 1)).setFill()
                    NSRect(x: 0, y: CGFloat(row) * 22, width: 84, height: 22).fill()
                    NSAppearance(named: name)!.performAsCurrentDrawingAppearance {
                        for (i, l) in [Level.ok, .warn, .crit].enumerated() {
                            StatusIcon.image(level: l).draw(in: NSRect(x: 4 + CGFloat(i) * 28, y: CGFloat(row) * 22 + 3, width: 20, height: 16))
                        }
                    }
                }
                return true
            }
            if let tiff = strip.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
                try? rep.representation(using: .png, properties: [:])?.write(to: url.appendingPathComponent("statusicon.png"))
            }
        }
    }

    /// Test "Pull Backup": `KEEPWATCH_SNAPSHOT_BACKUP=panel|start|cancel` opens the panel or starts
    /// a run (and cancels it after `KEEPWATCH_SNAPSHOT_CANCEL` s). Every `KEEPWATCH_SNAPSHOT_EVERY` s
    /// (default 2) it writes `backup-<n>.png` (panel) and `bar-<n>.png` (window),
    /// `KEEPWATCH_SNAPSHOT_COUNT` in total (default 10), plus `backup.txt` with the steps.
    @MainActor private static func scheduleBackupSeries(_ dir: URL) {
        let env = ProcessInfo.processInfo.environment
        guard let mode = env["KEEPWATCH_SNAPSHOT_BACKUP"] else { return }
        let every = Double(env["KEEPWATCH_SNAPSHOT_EVERY"] ?? "") ?? 2
        let count = Int(env["KEEPWATCH_SNAPSHOT_COUNT"] ?? "") ?? 10
        let b = Backup.shared
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            b.panelOpen = true
            if mode != "panel" { b.start() }
            if mode == "cancel" {
                let after = Double(env["KEEPWATCH_SNAPSHOT_CANCEL"] ?? "") ?? 4
                DispatchQueue.main.asyncAfter(deadline: .now() + after) { b.cancel() }
            }
        }
        var log = ""
        for i in 1...count {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3 + every * Double(i)) {
                log += "\(i): \(b.phase) · \(b.step) · \(b.fraction.map { String(format: "%.2f", $0) } ?? "-") · missing: \(b.missing.map(\.title))\n"
                try? log.write(to: dir.appendingPathComponent("backup.txt"), atomically: true, encoding: .utf8)
                for w in NSApp.windows where w.isVisible && w.windowNumber > 0 {
                    let isPanel = w !== AppDelegate.shared?.mainWindow
                    if !isPanel || w.frame.width > 200 {
                        _ = capture(windowID: CGWindowID(w.windowNumber),
                                    to: dir.appendingPathComponent("\(isPanel ? "backup" : "bar")-\(i).png"))
                    }
                }
            }
        }
    }

    /// `KEEPWATCH_SNAPSHOT_TOUCHID=1`: asks the bridge in the loaded dashboard - only requests that
    /// are rejected without Touch ID (unknown id, foreign RP ID) - and writes the answers to `touchid.txt`.
    @MainActor private static func scheduleTouchIDProbe(_ dir: URL) {
        guard ProcessInfo.processInfo.environment["KEEPWATCH_SNAPSHOT_TOUCHID"] == "1" else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            guard let wv = Web.shared.views[.dashboard] else {
                try? "no dashboard loaded\n".write(to: dir.appendingPathComponent("touchid.txt"), atomically: true, encoding: .utf8)
                return
            }
            let js = """
            const b = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.keepwatchTouchID;
            if (!b) return "no bridge";
            const ch = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
            const a = await b.postMessage({op: "sign", challenge: ch, rpId: location.hostname, allow: ["other-other-other-1"], reason: "Test"});
            const c = await b.postMessage({op: "sign", challenge: ch, rpId: "example.com", allow: [], reason: "Test"});
            const d = await b.postMessage({op: "nothing"});
            return location.origin + "\\nunknown id: " + JSON.stringify(a) + "\\nforeign RP ID: " + JSON.stringify(c) + "\\nno challenge: " + JSON.stringify(d);
            """
            wv.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
                let text: String
                switch result {
                case .success(let v): text = "\(v)\n"
                case .failure(let e): text = "error: \(e)\n"
                }
                try? text.write(to: dir.appendingPathComponent("touchid.txt"), atomically: true, encoding: .utf8)
            }
        }
    }

    /// `KEEPWATCH_SNAPSHOT_CLICK=1`: do clicks and keys reach the page? Starts locked (with
    /// KEEPWATCH_SNAPSHOT_NOPROMPT=1), unlocks after 8 s without a finger (test mode only), sends real
    /// events through the event loop (NSApp.sendEvent - also through the monitors) and reads
    /// counters from the page; then Cmd-L lock -> unlock -> once more. Result: click.txt.
    @MainActor private static func scheduleClickProbe(_ dir: URL) {
        guard ProcessInfo.processInfo.environment["KEEPWATCH_SNAPSHOT_CLICK"] == "1" else { return }
        var log = ""
        func write() { try? log.write(to: dir.appendingPathComponent("click.txt"), atomically: true, encoding: .utf8) }
        func round(_ name: String, at t: Double) {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) {
                guard let w = AppDelegate.shared?.mainWindow, let wv = Web.shared.views[.dashboard] else {
                    log += "\(name): no window/dashboard\n"; return write()
                }
                NSApp.activate(ignoringOtherApps: true)
                w.makeKeyAndOrderFront(nil)
                let setup = "if(!window.__k){addEventListener('mousedown',()=>__k.d++,true);addEventListener('click',()=>__k.c++,true);addEventListener('keydown',()=>__k.k++,true)};window.__k={c:0,d:0,k:0};true"
                wv.evaluateJavaScript(setup) { _, _ in
                    MainActor.assumeIsolated {
                        let r = wv.convert(wv.bounds, to: nil)
                        let p = NSPoint(x: r.midX, y: r.midY)
                        let hit = w.contentView?.superview?.hitTest(w.contentView!.superview!.convert(p, from: nil))
                        log += "\(name): locked=\(AppLock.shared.locked) key=\(w.isKeyWindow) container.hidden=\(Web.shared.container?.isHidden ?? true) hit=\(hit.map { String(describing: type(of: $0)) } ?? "nil") firstResponder=\(w.firstResponder.map { String(describing: type(of: $0)) } ?? "nil")\n"
                        // Same path as real events: NSApp.sendEvent (local monitors, then window, hitTest, WKWebView).
                        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                            if let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                          windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
                                NSApp.sendEvent(e)
                            }
                        }
                        for type in [NSEvent.EventType.keyDown, .keyUp] {
                            if let e = NSEvent.keyEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                        windowNumber: w.windowNumber, context: nil, characters: "x", charactersIgnoringModifiers: "x",
                                                        isARepeat: false, keyCode: 7) {
                                NSApp.sendEvent(e)
                            }
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                            wv.evaluateJavaScript("JSON.stringify(window.__k)+' hidden='+document.hidden+' focus='+document.hasFocus()") { v, e in
                                MainActor.assumeIsolated {
                                    log += "  page: \(v ?? e.map { "\($0)" } ?? "-")\n"
                                    write()
                                }
                            }
                        }
                    }
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            AppLock.shared.testUnlock(); log += "unlocked (test mode)\n"
            NSApp.activate(ignoringOtherApps: true)   // the window must be in front, otherwise WebKit takes nothing
        }
        round("after launch+unlock", at: 11)
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { AppLock.shared.lock(); log += "locked (Cmd-L)\n" }
        DispatchQueue.main.asyncAfter(deadline: .now() + 17) { AppLock.shared.testUnlock(); log += "unlocked (test mode)\n" }
        round("after Cmd-L+unlock", at: 19)
    }

    /// In test mode write the pages' console errors to console.log.
    @MainActor static func attachConsole(_ cfg: WKWebViewConfiguration) {
        guard let dir = ProcessInfo.processInfo.environment["KEEPWATCH_SNAPSHOT"] else { return }
        ConsoleLog.shared.path = dir + "/console.log"
        let js = """
        (function(){const s=m=>{try{webkit.messageHandlers.log.postMessage(location.host+' '+m)}catch(e){}};
        addEventListener('error',e=>s('error '+e.message+' @'+e.filename+':'+e.lineno));
        addEventListener('unhandledrejection',e=>s('reject '+(e.reason&&e.reason.message||e.reason)));
        const ce=console.error;console.error=function(...a){s('console.error '+a.join(' '));ce.apply(console,a)};
        const cw=console.warn;console.warn=function(...a){s('console.warn '+a.join(' '));cw.apply(console,a)};})();
        """
        cfg.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        cfg.userContentController.add(ConsoleLog.shared, name: "log")
    }

    /// Any app may capture its own windows without the screen recording permission.
    private typealias CreateImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
    @MainActor static func capture(windowID: CGWindowID, to url: URL) -> Bool {
        guard let h = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW),
              let sym = dlsym(h, "CGWindowListCreateImage") else { return false }
        let fn = unsafeBitCast(sym, to: CreateImage.self)
        // kCGWindowListOptionIncludingWindow = 1 << 3, kCGWindowImageBoundsIgnoreFraming = 1 << 0
        guard let img = fn(.null, 1 << 3, windowID, 1 << 0)?.takeRetainedValue(), img.width > 10 else { return false }
        let rep = NSBitmapImageRep(cgImage: img)
        return (try? rep.representation(using: .png, properties: [:])?.write(to: url)) != nil
    }
}

final class ConsoleLog: NSObject, WKScriptMessageHandler {
    static let shared = ConsoleLog()
    var path = ""
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        let line = "\(message.body)\n"
        if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(Data(line.utf8)); h.closeFile() }
        else { try? line.write(toFile: path, atomically: true, encoding: .utf8) }
    }
}
