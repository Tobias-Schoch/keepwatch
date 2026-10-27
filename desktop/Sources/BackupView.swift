import AppKit
import SwiftUI

// MARK: - Button in the bar

/// "Pull Backup" in the title bar: a sand dot if not pulled today; progress while running.
/// A click opens the panel with everything else.
struct BackupButton: View {
    /// Symbol only (the title bar): the text shows while a backup runs, the rest is in the tooltip.
    var iconOnly = false
    @State private var backup = Backup.shared
    @State private var hover = false

    var body: some View {
        Button { backup.panelOpen.toggle() } label: {
            ViewThatFits(in: .horizontal) {
                if !iconOnly { content(compact: false) }
                content(compact: true)
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 9)
            .frame(height: 24)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(.white.opacity(hover || backup.panelOpen ? 0.06 : 0)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help(help)
        .popover(isPresented: $backup.panelOpen, arrowEdge: .bottom) {
            BackupPanel().preferredColorScheme(.dark)
        }
    }

    private func content(compact: Bool) -> some View {
        HStack(spacing: 6) {
            ZStack(alignment: .topTrailing) {
                if backup.isRunning {
                    ProgressView().controlSize(.mini).frame(width: 13, height: 13)
                } else {
                    Image(systemName: "externaldrive.badge.icloud").font(.system(size: 12))
                }
                if !backup.isRunning && !backup.doneToday {
                    Circle().fill(O.sand).frame(width: 5, height: 5).offset(x: 3, y: -2)
                }
            }
            if !compact || backup.isRunning {
                Text(label).font(.system(size: 12, weight: .medium)).lineLimit(1)
            }
        }
        .fixedSize()
    }

    private var label: String {
        if backup.isRunning { return backup.shortStep }
        switch backup.phase {
        case .failed: return "Backup: error"
        default: return "Pull Backup"
        }
    }

    private var tint: Color {
        if case .failed = backup.phase { return O.rose }
        return hover || backup.panelOpen || backup.isRunning ? O.text : O.mute
    }

    private var help: String {
        if backup.doneToday { return "Pull the server backup to this Mac - \(backup.lastText)" }
        return "Pull the server backup to this Mac - not today yet (\(backup.lastText))"
    }
}

// MARK: - Panel with folder, requirements, progress and result

struct BackupPanel: View {
    @State private var backup = Backup.shared
    @State private var store = Store.shared
    @State private var showLog = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Backup on This Mac").font(.system(size: 15, weight: .semibold)).foregroundStyle(O.text)
                Text("Your own copy of the server backup (restic), only on request. Nothing is ever deleted on this Mac.")
                    .font(.system(size: 12)).foregroundStyle(O.mute).fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 0) {
                row("Last pulled") {
                    HStack(spacing: 6) {
                        if !backup.doneToday { Circle().fill(O.sand).frame(width: 6, height: 6) }
                        Text(lastLine).foregroundStyle(backup.doneToday ? O.text : O.sand)
                    }
                }
                Divider().overlay(O.line)
                row("Folder") {
                    HStack(spacing: 8) {
                        Text(backup.folderDisplay).font(.system(size: 12, design: .monospaced)).foregroundStyle(O.dim)
                            .lineLimit(1).truncationMode(.middle)
                        Button("Change ...") { backup.chooseFolder(for: NSApp.keyWindow) }
                            .buttonStyle(LinkStyle()).disabled(backup.isRunning)
                        Button { backup.revealFolder() } label: { Image(systemName: "folder") }
                            .buttonStyle(LinkStyle()).help("Show in Finder")
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.white.opacity(0.035)))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.white.opacity(0.06), lineWidth: 1))

            if !backup.isRunning, !backup.missing.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(backup.missing) { m in MissingRow(item: m) }
                }
            }

            status

            HStack(spacing: 8) {
                if backup.isRunning {
                    Button("Cancel") { backup.cancel() }.buttonStyle(BigButton(primary: false))
                } else {
                    Button(backup.phase == .idle ? "Pull Backup" : "Pull Again") { backup.start() }
                        .buttonStyle(BigButton())
                        .disabled(!backup.missing.isEmpty)
                        .opacity(backup.missing.isEmpty ? 1 : 0.45)
                    Toggle("verify all data", isOn: $backup.thorough)
                        .toggleStyle(.checkbox).font(.system(size: 12)).foregroundStyle(O.dim)
                        .help("restic check --read-data: reads every file of the copy. Takes much longer.")
                }
                Spacer()
                if !backup.log.isEmpty, !backup.isRunning {
                    Button(showLog ? "Hide Output" : "Output") { showLog.toggle() }.buttonStyle(LinkStyle())
                }
            }

            if showLog, !backup.log.isEmpty {
                ScrollView {
                    Text(backup.log.joined(separator: "\n"))
                        .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(O.dim)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: 120)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 8).fill(.black.opacity(0.35)))
            }
        }
        .padding(18)
        .frame(width: 420)
        .background(Color(14, 14, 16))
        .task { await backup.checkPrerequisites() }
        .onChange(of: store.tailscale) { _, _ in Task { await backup.checkPrerequisites() } }
    }

    private var lastLine: String {
        guard let t = backup.mac.lastSuccess else { return "never" }
        var s = t.relativeDay()
        if let n = backup.mac.lastSuccessSnapshots { s += " · \(Backup.snapshotsText(n))" }
        if let b = backup.mac.lastSuccessBytes { s += " · \(Backup.bytes(b))" }
        return backup.doneToday ? s : "not today yet · \(s)"
    }

    @ViewBuilder private var status: some View {
        switch backup.phase {
        case .running:
            VStack(alignment: .leading, spacing: 8) {
                Text(backup.step).font(.system(size: 13, weight: .medium)).foregroundStyle(O.text)
                if let f = backup.fraction {
                    ProgressView(value: f).tint(O.accent)
                } else {
                    ProgressView().progressViewStyle(.linear).tint(O.accent)
                }
            }
        case .done(let s):
            VStack(alignment: .leading, spacing: 4) {
                Label("Pulled and verified ✓", systemImage: "checkmark.circle").foregroundStyle(O.ok)
                    .font(.system(size: 13, weight: .medium))
                Text("\(Backup.newText(s.new)) · \(Backup.snapshotsText(s.snapshots)) on this Mac · \(Backup.bytes(s.bytes))"
                     + (s.thorough ? " · all data read" : ""))
                    .font(.system(size: 12)).foregroundStyle(O.dim)
                if let n = s.newest {
                    Text("Server's newest snapshot: \(n.relativeDay())").font(.system(size: 12)).foregroundStyle(O.mute)
                }
            }
        case .failed(let m):
            VStack(alignment: .leading, spacing: 4) {
                Label("Not pulled", systemImage: "exclamationmark.triangle").foregroundStyle(O.rose)
                    .font(.system(size: 13, weight: .medium))
                Text(m).font(.system(size: 12)).foregroundStyle(O.dim).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .cancelled:
            Text(backup.resultText ?? "").font(.system(size: 12)).foregroundStyle(O.sand)
                .fixedSize(horizontal: false, vertical: true)
        case .idle:
            EmptyView()
        }
    }

    private func row<V: View>(_ label: String, @ViewBuilder _ value: () -> V) -> some View {
        HStack(spacing: 10) {
            Text(label).font(.system(size: 12)).foregroundStyle(O.mute).frame(width: 92, alignment: .leading)
            value().font(.system(size: 12.5))
            Spacer(minLength: 0)
        }
        .frame(minHeight: 34)
    }
}

/// A missing requirement: a sentence, a command to copy, maybe a fitting button.
struct MissingRow: View {
    var item: Backup.Missing
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(item.title, systemImage: "exclamationmark.circle")
                .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(O.sand)
            Text(item.detail).font(.system(size: 12)).foregroundStyle(O.dim).fixedSize(horizontal: false, vertical: true)
            if let cmd = item.command {
                HStack(spacing: 6) {
                    Text(cmd).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(O.text)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    Button(copied ? "copied" : "Copy") {
                        Clip.copy(cmd)
                        copied = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                    }
                    .buttonStyle(LinkStyle())
                    Button("In Terminal") { Terminal.run(cmd) }.buttonStyle(LinkStyle())
                }
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(.black.opacity(0.35)))
            }
            if item.kind == .tailscale {
                Button("Connect") { Store.shared.userConnect() }.buttonStyle(SmallButton())
            }
            if item.kind == .folder {
                Button("Choose Another Folder ...") { Backup.shared.chooseFolder(for: NSApp.keyWindow) }.buttonStyle(SmallButton())
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(O.sand.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(O.sand.opacity(0.18), lineWidth: 1))
    }
}

struct LinkStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(O.accent.opacity(configuration.isPressed ? 0.6 : (enabled ? 1 : 0.4)))
            .contentShape(Rectangle())
    }
}
