import AppKit
import SwiftUI

// Colors from the dashboard design (graphite), only what the bar needs.
extension Color {
    init(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) {
        self.init(.sRGB, red: r / 255, green: g / 255, blue: b / 255, opacity: a)
    }
}

enum O {
    static let bg = Color(5, 5, 5)
    static let bar = Color(9, 9, 10)
    static let text = Color(244, 244, 244)
    static let dim = Color(240, 240, 240, 0.66)
    static let mute = Color(240, 240, 240, 0.44)
    static let line = Color.white.opacity(0.07)
    static let accent = Color(163, 163, 255)
    static let ok = Color(143, 207, 176)
    static let sand = Color(216, 193, 142)
    static let rose = Color(234, 140, 152)
    static let silver = Color(196, 196, 196)
    static let neutral = Color(200, 200, 212)

    static func tone(_ l: Level) -> Color {
        switch l { case .ok: ok; case .warn: sand; case .crit: rose }
    }
}

// MARK: - Window

@MainActor
func makeMainWindow(delegate: NSWindowDelegate) -> NSWindow {
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 880),
                     styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                     backing: .buffered, defer: false)
    w.title = "Keepwatch"
    w.titleVisibility = .hidden
    w.titlebarAppearsTransparent = true
    w.titlebarSeparatorStyle = .none
    // Empty toolbar: the title bar gets as tall as our bar, the traffic lights sit centered.
    w.toolbar = NSToolbar(identifier: "keepwatch.main")
    w.toolbarStyle = .unifiedCompact
    w.appearance = NSAppearance(named: .darkAqua)
    w.backgroundColor = NSColor(srgbRed: 5 / 255, green: 5 / 255, blue: 5 / 255, alpha: 1)
    w.minSize = NSSize(width: 900, height: 560)
    w.isReleasedWhenClosed = false
    w.tabbingMode = .disallowed
    w.delegate = delegate
    w.contentView = NSHostingView(rootView: RootView())
    w.setFrameAutosaveName("KeepwatchMain")
    if !w.setFrameUsingName("KeepwatchMain") { w.center() }
    return w
}

struct RootView: View {
    @State private var store = Store.shared
    @State private var web = Web.shared
    @State private var lock = AppLock.shared

    var body: some View {
        GeometryReader { g in
            VStack(spacing: 0) {
                Bar().frame(height: max(g.safeAreaInsets.top, 36))
                ZStack {
                    O.bg
                    WebHost().opacity(store.isReady && !lock.locked ? 1 : 0)
                    if lock.locked {
                        LockScreen()
                    } else if !store.isReady {
                        StateScreen()
                    } else if let f = web.failure[web.selected] {
                        FailureScreen(message: f)
                    }
                }
                .overlay(alignment: .bottom) {
                    if let n = web.notice {
                        Text(n)
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(O.text)
                            .padding(.horizontal, 14).frame(height: 32)
                            .background(Capsule().fill(Color(20, 20, 22, 0.96)))
                            .overlay(Capsule().strokeBorder(.white.opacity(0.1), lineWidth: 1))
                            .padding(.bottom, 20)
                    }
                }
            }
            .ignoresSafeArea(edges: .top)
        }
        .preferredColorScheme(.dark)
        .onAppear { if store.isReady && !lock.locked { web.activate() } }
        .onChange(of: store.isReady) { _, ready in if ready && !lock.locked { web.activate() } }
    }
}

struct WebHost: NSViewRepresentable {
    func makeNSView(context: Context) -> WebContainer {
        let c = WebContainer()
        c.isHidden = AppLock.shared.locked
        Web.shared.container = c
        if let wv = Web.shared.views[Web.shared.selected] { c.show(wv) }
        return c
    }
    func updateNSView(_ nsView: WebContainer, context: Context) {}
}

// MARK: - Bar in the title bar

struct Bar: View {
    @State private var store = Store.shared
    @State private var web = Web.shared
    @State private var lock = AppLock.shared

    var body: some View {
        ZStack {
            // Empty space drags the window
            Color.clear.contentShape(Rectangle()).gesture(WindowDragGesture())
            if lock.locked {
                // Locked: only the two status symbols, no buttons.
                HStack(spacing: 8) {
                    Color.clear.frame(width: 70, height: 1)
                    status(locked: true)
                    Spacer(minLength: 10)
                }
                .padding(.horizontal, 10)
            } else {
                controls
            }
        }
        .background(O.bar)
        .overlay(alignment: .bottom) {
            ZStack(alignment: .leading) {
                Rectangle().fill(O.line)
                if web.loading && store.isReady && !lock.locked {
                    GeometryReader { g in
                        Rectangle()
                            .fill(LinearGradient(colors: [.white.opacity(0.2), O.accent.opacity(0.9)], startPoint: .leading, endPoint: .trailing))
                            .frame(width: g.size.width * web.progress)
                            .animation(.easeOut(duration: 0.25), value: web.progress)
                    }
                }
            }
            .frame(height: 1)
        }
    }

    /// Dashboard: the status symbols left, three tools right. In Portainer, the Proxy Manager and the
    /// other web UIs a way back comes first - their links live on the dashboard page now, not in tabs.
    private var controls: some View {
        HStack(spacing: 8) {
            Color.clear.frame(width: 70, height: 1)   // traffic lights
            if web.selected != .dashboard {
                BackCrumb(title: web.selected.title)
            }
            status(locked: false)
            Spacer(minLength: 10)
            if web.selected != .dashboard {
                // The dashboard refreshes itself; the other UIs have no reload button of their own.
                BarIcon(symbol: "arrow.clockwise", help: "Reload (⌘R)") { web.reload() }
                    .disabled(!store.isReady)
            }
            BackupButton(iconOnly: true)
            BarIcon(symbol: "terminal", help: "Open Terminal with SSH to the server (⌘T)") { Terminal.openSSH() }
                .disabled(Config.current == nil)
            BarIcon(symbol: "lock", help: "Lock (⌘L)") { AppLock.shared.lock() }
        }
        .padding(.horizontal, 10)
    }
}

extension Bar {
    /// Two symbols, colored by state: this Mac's Tailscale connection (only with Tailscale) and the server.
    /// The words are in the tooltip; a button appears only when something needs a click.
    @ViewBuilder func status(locked: Bool) -> some View {
        HStack(spacing: 2) {
            if store.usesTailscale {
                StateSymbol(symbol: "point.3.connected.trianglepath.dotted", color: O.tone(store.macLevel),
                           help: "This Mac: \(store.macText)")
            }
            StateSymbol(symbol: "server.rack", color: store.serverLevel.map(O.tone) ?? O.neutral,
                       help: "\(Server.host.isEmpty ? "Server" : Store.serverName): \(store.serverText) - \(store.guidance)",
                       action: !locked && store.isReady && !store.health.isEmpty ? { web.choose(.dashboard) } : nil)
            if !locked, [.tailscaleOff, .needsLogin, .missing, .serverDown, .tunnelFailed].contains(store.phase) {
                Button(store.phase == .needsLogin ? "Open Tailscale" : (store.phase == .missing ? "Get Tailscale"
                    : store.phase == .tunnelFailed ? "Try Again" : "Connect")) {
                    store.userConnect()
                }
                .buttonStyle(SmallButton())
                .fixedSize()
                .padding(.leading, 6)
            }
        }
    }
}

/// A status symbol in the title bar: the color is the state, the tooltip says it in words.
struct StateSymbol: View {
    var symbol: String
    var color: Color
    var help: String
    var action: (() -> Void)? = nil
    @State private var hover = false
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(color)
            .frame(width: 26, height: 26)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(.white.opacity(hover && action != nil ? 0.06 : 0)))
            .contentShape(Rectangle())
            .onHover { hover = $0 }
            .onTapGesture { action?() }
            .help(help)
            .accessibilityLabel(help)
    }
}

/// "‹ Dashboard / Portainer": the way back out of a web UI.
struct BackCrumb: View {
    var title: String
    @State private var hover = false
    var body: some View {
        HStack(spacing: 6) {
            Button { Web.shared.choose(.dashboard) } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left").font(.system(size: 10.5, weight: .semibold))
                    Text("Dashboard")
                }
                .foregroundStyle(hover ? O.text : O.dim)
                .padding(.horizontal, 7)
                .frame(height: 24)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(.white.opacity(hover ? 0.06 : 0)))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hover = $0 }
            .help("Back to the dashboard (⌘1)")
            Text("/").foregroundStyle(O.mute)
            Text(title).foregroundStyle(O.text).lineLimit(1)
        }
        .font(.system(size: 12.5, weight: .medium))
        .fixedSize()
        .padding(.trailing, 4)
    }
}

struct BarIcon: View {
    var symbol: String
    var help: String
    var action: () -> Void
    @State private var hover = false
    @Environment(\.isEnabled) private var enabled
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 13))
                .foregroundStyle(hover ? O.text : O.mute)
                .frame(width: 28, height: 26)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(.white.opacity(hover ? 0.06 : 0)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(enabled ? 1 : 0.4)
        .onHover { hover = $0 }
        .help(help)
    }
}

struct SmallButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11.5, weight: .medium))
            .foregroundStyle(Color(11, 11, 15))
            .padding(.horizontal, 10)
            .frame(height: 22)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(LinearGradient(colors: [.white, O.silver], startPoint: .top, endPoint: .bottom)))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

struct BigButton: ButtonStyle {
    var primary = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(primary ? Color(11, 11, 15) : O.text)
            .padding(.horizontal, 14)
            .frame(height: 32)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(primary
                ? AnyShapeStyle(LinearGradient(colors: [.white, Color(236, 236, 236), O.silver], startPoint: .top, endPoint: .bottom))
                : AnyShapeStyle(LinearGradient(colors: [.white.opacity(0.085), .white.opacity(0.035)], startPoint: .top, endPoint: .bottom))))
            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(.white.opacity(primary ? 0.24 : 0.085), lineWidth: 1))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

// MARK: - Calm state screen without a connection

struct StateScreen: View {
    @State private var store = Store.shared
    var body: some View {
        ZStack {
            EllipticalGradient(colors: [Color(210, 212, 235, 0.08), .clear], center: UnitPoint(x: 0.5, y: 0),
                               startRadiusFraction: 0, endRadiusFraction: 0.6)
            VStack(spacing: 0) {
                Mark(size: 44)
                Text(store.headline)
                    .font(.system(size: 30, weight: .medium)).tracking(-1)
                    .foregroundStyle(LinearGradient(colors: [.white, O.silver], startPoint: .top, endPoint: .bottom))
                    .padding(.top, 22)
                Text(store.guidance)
                    .font(.system(size: 14)).foregroundStyle(O.dim)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 440)
                    .padding(.top, 10)
                if store.phase == .noConfig && Config.loadError == nil {
                    CommandBox(text: "./keepwatch desktop").padding(.top, 18)
                }
                HStack(spacing: 8) {
                    switch store.phase {
                    case .checking, .connecting, .tunnel:
                        ProgressView().controlSize(.small)
                    case .noConfig:
                        Button("Check Again") { store.userConnect() }.buttonStyle(BigButton())
                        Button("Enter Manually ...") { AppDelegate.shared?.showSettings(nil) }.buttonStyle(BigButton(primary: false))
                    case .tunnelFailed:
                        Button("Try Again") { store.userConnect() }.buttonStyle(BigButton())
                        Button("Open Terminal") { Terminal.openSSH() }.buttonStyle(BigButton(primary: false))
                    case .tailscaleOff:
                        Button("Connect") { store.userConnect() }.buttonStyle(BigButton())
                        Button("Open Tailscale") { Tailscale.openApp() }.buttonStyle(BigButton(primary: false))
                    case .needsLogin:
                        Button("Open Tailscale") { Tailscale.openApp() }.buttonStyle(BigButton())
                        Button("Check Again") { store.userConnect() }.buttonStyle(BigButton(primary: false))
                    case .missing:
                        Button("Get Tailscale") { store.userConnect() }.buttonStyle(BigButton())
                    case .serverDown:
                        Button("Check Again") { store.userConnect() }.buttonStyle(BigButton())
                        Button("Open Terminal") { Terminal.openSSH() }.buttonStyle(BigButton(primary: false))
                    case .ready:
                        EmptyView()
                    }
                }
                .frame(height: 32)
                .padding(.top, 24)
            }
            .padding(40)
        }
    }
}

struct FailureScreen: View {
    var message: String
    @State private var web = Web.shared
    var body: some View {
        ZStack {
            O.bg
            VStack(spacing: 0) {
                Image(systemName: "wifi.exclamationmark").font(.system(size: 28, weight: .light)).foregroundStyle(O.mute)
                Text("\(web.selected.title) does not load.")
                    .font(.system(size: 22, weight: .medium)).tracking(-0.6).foregroundStyle(O.text)
                    .padding(.top, 16)
                Text(message).font(.system(size: 13)).foregroundStyle(O.mute)
                    .multilineTextAlignment(.center).frame(maxWidth: 440).padding(.top, 8)
                HStack(spacing: 8) {
                    Button("Try Again") { web.retry() }.buttonStyle(BigButton())
                    Button("Open in Browser") { web.openInBrowser() }.buttonStyle(BigButton(primary: false))
                }
                .padding(.top, 22)
            }
        }
    }
}

// MARK: - Locked

struct LockScreen: View {
    @State private var lock = AppLock.shared
    var body: some View {
        ZStack {
            O.bg
            EllipticalGradient(colors: [Color(210, 212, 235, 0.08), .clear], center: UnitPoint(x: 0.5, y: 0),
                               startRadiusFraction: 0, endRadiusFraction: 0.6)
            VStack(spacing: 0) {
                Image(systemName: "lock").font(.system(size: 34, weight: .light)).foregroundStyle(O.dim)
                Text("Locked")
                    .font(.system(size: 30, weight: .medium)).tracking(-1)
                    .foregroundStyle(LinearGradient(colors: [.white, O.silver], startPoint: .top, endPoint: .bottom))
                    .padding(.top, 20)
                Text(lock.message ?? "Unlock with Touch ID - or with this Mac's password. After \(minutes) without input the app locks itself.")
                    .font(.system(size: 14)).foregroundStyle(lock.message == nil ? O.dim : O.rose)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 440)
                    .padding(.top, 10)
                Button {
                    lock.unlock()
                } label: {
                    HStack(spacing: 8) {
                        if lock.prompting { ProgressView().controlSize(.small) } else { Image(systemName: "touchid") }
                        Text("Unlock")
                    }
                }
                .buttonStyle(BigButton())
                .disabled(lock.prompting)
                .padding(.top, 24)
            }
            .padding(40)
        }
    }

    private var minutes: String {
        let s = Int(AppLock.timeout)
        return s >= 120 ? "\(s / 60) minutes" : "\(s) seconds"
    }
}

/// The dashboard's mark (Shell.tsx), graphite colors.
struct Mark: View {
    var size: CGFloat = 22
    var body: some View {
        Canvas { ctx, sz in
            let s = sz.width / 24
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * s, y: y * s) }
            var gem = Path(); gem.addLines([p(12, 1.5), p(21, 8), p(12, 22.5), p(3, 8)]); gem.closeSubpath()
            ctx.fill(gem, with: .linearGradient(Gradient(stops: [.init(color: .white, location: 0), .init(color: Color(166, 166, 166), location: 0.55),
                                                                 .init(color: Color(44, 44, 44), location: 1)]),
                                                startPoint: p(0, 0), endPoint: p(24, 24)))
            var b = Path(); b.addLines([p(12, 1.5), p(21, 8), p(12, 11.2)]); b.closeSubpath()
            ctx.fill(b, with: .linearGradient(Gradient(colors: [Color(228, 228, 228).opacity(0.9), Color(26, 26, 26).opacity(0.9)]),
                                              startPoint: p(24, 0), endPoint: p(0, 24)))
            var c = Path(); c.addLines([p(12, 11.2), p(21, 8), p(12, 22.5)]); c.closeSubpath()
            ctx.fill(c, with: .color(Color(20, 20, 26).opacity(0.55)))
        }
        .frame(width: size, height: size)
    }
}

/// A command in monospace with a copy button (first-run screen).
struct CommandBox: View {
    var text: String
    @State private var copied = false
    var body: some View {
        HStack(spacing: 10) {
            Text(text).font(.system(size: 13, design: .monospaced)).foregroundStyle(O.text).textSelection(.enabled)
            Button(copied ? "copied" : "Copy") {
                Clip.copy(text)
                copied = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
            }
            .buttonStyle(LinkStyle())
        }
        .padding(.horizontal, 14).frame(height: 34)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(.black.opacity(0.4)))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(.white.opacity(0.08), lineWidth: 1))
    }
}
