import SwiftUI
import WidgetKit

// Views of the four widgets. Dark and calm like the dashboard; only deviations are colored.
// Light mode: light background with stronger tones; tinted/accented mode (desktop in the
// background): grayscale with the accent on what matters.

struct ServerEntry: TimelineEntry {
    var date: Date
    var snapshot: ServerSnapshot?
    var mac: MacBackupState
    /// nil = fresh; otherwise the reason ("Tailscale off", "unreachable").
    var failure: String?
    var placeholder = false

    static func sample(_ date: Date = Date()) -> ServerEntry {
        var mac = MacBackupState()
        mac.lastSuccess = Calendar.current.date(byAdding: .hour, value: -20, to: date)
        mac.lastSuccessSnapshots = 41
        return ServerEntry(date: date, snapshot: .sample, mac: mac, failure: nil, placeholder: true)
    }

    /// Snapshot not fresh: server unreachable or older than 40 min.
    var stale: Bool {
        guard let s = snapshot else { return true }
        return failure != nil || date.timeIntervalSince(s.fetchedAt) > 40 * 60
    }

    var staleText: String {
        guard let s = snapshot else { return failure ?? "no data yet" }
        let when = Calendar.current.isDate(s.fetchedAt, inSameDayAs: date) ? s.fetchedAt.clock : s.fetchedAt.relativeDay(now: date)
        return "\(failure ?? "old") · as of \(when)"
    }
}

struct Palette {
    var text: Color
    var dim: Color
    var faint: Color
    var ok: Color
    var warn: Color
    var crit: Color
    var bar: Color
    var line: Color
    var bg: Color
    var tinted: Bool

    init(_ scheme: ColorScheme, _ mode: WidgetRenderingMode) {
        tinted = mode != .fullColor
        if tinted {
            text = .primary; dim = .secondary; faint = .secondary.opacity(0.7)
            ok = .primary; warn = .primary; crit = .primary
            bar = .secondary.opacity(0.45); line = .secondary.opacity(0.25); bg = .clear
        } else if scheme == .dark {
            text = Color(red: 245 / 255, green: 245 / 255, blue: 247 / 255)
            dim = Color(red: 163 / 255, green: 163 / 255, blue: 173 / 255)
            faint = Color(red: 120 / 255, green: 120 / 255, blue: 130 / 255)
            ok = Color(red: 143 / 255, green: 207 / 255, blue: 176 / 255)
            warn = Color(red: 216 / 255, green: 193 / 255, blue: 142 / 255)
            crit = Color(red: 234 / 255, green: 140 / 255, blue: 152 / 255)
            bar = Color(red: 74 / 255, green: 74 / 255, blue: 85 / 255)
            line = Color.white.opacity(0.06)
            bg = Color(red: 24 / 255, green: 24 / 255, blue: 29 / 255)
        } else {
            text = Color(red: 28 / 255, green: 28 / 255, blue: 32 / 255)
            dim = Color(red: 104 / 255, green: 104 / 255, blue: 114 / 255)
            faint = Color(red: 140 / 255, green: 140 / 255, blue: 150 / 255)
            ok = Color(red: 38 / 255, green: 132 / 255, blue: 92 / 255)
            warn = Color(red: 150 / 255, green: 108 / 255, blue: 24 / 255)
            crit = Color(red: 196 / 255, green: 60 / 255, blue: 82 / 255)
            bar = Color(red: 200 / 255, green: 200 / 255, blue: 208 / 255)
            line = Color.black.opacity(0.07)
            bg = Color(red: 246 / 255, green: 246 / 255, blue: 249 / 255)
        }
    }

    func tone(_ t: Tone) -> Color { t == .ok ? ok : t == .warn ? warn : crit }
}

private struct PaletteReader<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.widgetRenderingMode) private var mode
    var content: (Palette) -> Content
    init(@ViewBuilder content: @escaping (Palette) -> Content) { self.content = content }
    var body: some View {
        let p = Palette(scheme, mode)
        content(p).containerBackground(for: .widget) { p.bg }
    }
}

private struct Dot: View {
    var color: Color
    var size: CGFloat = 8
    var body: some View { Circle().fill(color).frame(width: size, height: size).widgetAccentable() }
}

private struct Caption: View {
    var text: String
    var color: Color
    var body: some View {
        Text(text).font(.system(size: 11, weight: .medium)).foregroundStyle(color).lineLimit(1)
    }
}

/// Gray note for an old snapshot.
private struct StaleNote: View {
    var entry: ServerEntry
    var p: Palette
    var body: some View {
        if entry.stale {
            HStack(spacing: 4) {
                Image(systemName: "clock.arrow.circlepath").font(.system(size: 9, weight: .semibold))
                Text(entry.staleText).lineLimit(1).minimumScaleFactor(0.8)
            }
            .font(.system(size: 10.5, weight: .medium))
            .foregroundStyle(p.faint)
        }
    }
}

// MARK: - 1 · Status (small)

struct StatusView: View {
    var entry: ServerEntry
    var body: some View {
        PaletteReader { p in
            let s = entry.snapshot
            let top = s?.problems.first
            let tone: Tone? = entry.stale ? nil : (top?.level ?? .ok)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    Dot(color: tone.map(p.tone) ?? p.faint)
                    Caption(text: "Keepwatch", color: p.dim)
                }
                Spacer(minLength: 4)
                if let top {
                    Text(top.title)
                        .font(.system(size: 19, weight: .semibold)).tracking(-0.3)
                        .foregroundStyle(entry.stale ? p.dim : p.tone(top.level))
                        .lineLimit(3).minimumScaleFactor(0.75)
                        .widgetAccentable()
                    if let more = moreText(s?.problems.count ?? 0) {
                        Text(more).font(.system(size: 11.5)).foregroundStyle(p.dim).padding(.top, 3)
                    }
                } else if s == nil {
                    Text("No data yet").font(.system(size: 19, weight: .semibold)).foregroundStyle(p.dim)
                } else {
                    Text("All good.")
                        .font(.system(size: 24, weight: .semibold)).tracking(-0.5)
                        .foregroundStyle(entry.stale ? p.dim : p.text)
                }
                VStack(alignment: .leading, spacing: 2) {
                    if let counts = countsText(s), top == nil { Text(counts).foregroundStyle(p.dim) }
                    if entry.stale {
                        StaleNote(entry: entry, p: p)
                    } else if let b = s?.backup {
                        backupLine(b, p)
                    }
                }
                .font(.system(size: 11.5))
                .lineLimit(1)
                .padding(.top, 8)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
        .widgetURL(DashPage.overview.url)
    }

    private func moreText(_ n: Int) -> String? {
        n <= 1 ? nil : n == 2 ? "and 1 more" : "and \(n - 1) more"
    }

    private func countsText(_ s: ServerSnapshot?) -> String? {
        guard let s, let a = s.serviceCount, let b = s.siteCount else { return nil }
        return "\(a) services · \(b) sites"
    }

    @ViewBuilder private func backupLine(_ b: ServerSnapshot.BackupInfo, _ p: Palette) -> some View {
        if b.running {
            Text("Backup running").foregroundStyle(p.dim)
        } else if b.ok == false {
            Text("Backup failed").foregroundStyle(p.crit).widgetAccentable()
        } else if let t = b.lastAt {
            let old = entry.date.timeIntervalSince(t) > 26 * 3600
            Text("Backup \(t.relativeDay(now: entry.date))").foregroundStyle(old ? p.warn : p.dim)
        }
    }
}

// MARK: - 2 · Attacks (small)

struct AttacksView: View {
    var entry: ServerEntry
    var body: some View {
        PaletteReader { p in
            let a = entry.snapshot?.attacks
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Caption(text: "Attacks today", color: p.dim)
                    Spacer(minLength: 0)
                }
                Text(a.map { $0.today.formatted(.number) } ?? "-")
                    .font(.system(size: 30, weight: .semibold)).tracking(-0.6)
                    .foregroundStyle(entry.stale ? p.dim : p.text)
                    .padding(.top, 4)
                    .minimumScaleFactor(0.7).lineLimit(1)
                if entry.stale {
                    StaleNote(entry: entry, p: p).padding(.top, 1)
                } else if let a, a.today > 0 {
                    Text("\(Int((Double(a.blockedToday) / Double(a.today) * 100).rounded())) % from banned IPs")
                        .font(.system(size: 11.5)).foregroundStyle(p.dim)
                } else {
                    Text("nobody knocking").font(.system(size: 11.5)).foregroundStyle(p.dim)
                }
                Spacer(minLength: 6)
                if let a { Bars(days: a.days, p: p, dimmed: entry.stale) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
        .widgetURL(DashPage.security.url)
    }
}

/// 7 days, today on the right. Red: attempts from addresses banned today.
private struct Bars: View {
    var days: [ServerSnapshot.AttackDay]
    var p: Palette
    var dimmed: Bool
    var body: some View {
        let maxV = max(days.map(\.attempts).max() ?? 1, 1)
        GeometryReader { g in
            HStack(alignment: .bottom, spacing: 4) {
                ForEach(Array(days.enumerated()), id: \.offset) { i, d in
                    let h = max(3, g.size.height * CGFloat(d.attempts) / CGFloat(maxV))
                    let red = d.attempts > 0 ? h * CGFloat(d.blocked) / CGFloat(d.attempts) : 0
                    VStack(spacing: 0) {
                        Spacer(minLength: 0)
                        Rectangle().fill(p.bar).frame(height: max(0, h - red))
                        Rectangle().fill(p.crit).frame(height: red).widgetAccentable()
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 2, style: .continuous))
                    .opacity(dimmed ? 0.45 : (i == days.count - 1 ? 1 : 0.62))
                }
            }
        }
        .frame(height: 40)
    }
}

// MARK: - 3 · Services (medium)

struct ServicesView: View {
    var entry: ServerEntry
    var body: some View {
        PaletteReader { p in
            let list = entry.snapshot?.services ?? []
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    Caption(text: "Services", color: p.dim)
                    Spacer(minLength: 4)
                    if entry.stale { StaleNote(entry: entry, p: p) } else { Caption(text: "today", color: p.faint) }
                }
                .padding(.bottom, 4)
                if list.isEmpty {
                    Spacer()
                    Text("No data yet").font(.system(size: 13)).foregroundStyle(p.dim)
                    Spacer()
                } else {
                    let shown = Array(list.prefix(5))
                    ForEach(Array(shown.enumerated()), id: \.offset) { i, svc in
                        ServiceRow(svc: svc, p: p, stale: entry.stale)
                        if i < shown.count - 1 { Rectangle().fill(p.line).frame(height: 1) }
                    }
                    if list.count > 5 {
                        Text("and \(list.count - 5) more").font(.system(size: 10.5)).foregroundStyle(p.faint).padding(.top, 2)
                    }
                    Spacer(minLength: 0)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .widgetURL(DashPage.services.url)
    }
}

private struct ServiceRow: View {
    var svc: ServerSnapshot.Service
    var p: Palette
    var stale: Bool
    var body: some View {
        let c = stale ? p.faint : p.tone(svc.tone)
        HStack(spacing: 9) {
            Dot(color: c, size: 7)
            Text(svc.name).font(.system(size: 12.5)).foregroundStyle(stale ? p.dim : p.text).lineLimit(1)
            Spacer(minLength: 6)
            if svc.problem {
                Text(svc.note)
                    .font(.system(size: 11, weight: .medium)).foregroundStyle(c).lineLimit(1)
                    .padding(.horizontal, 7).padding(.vertical, 1.5)
                    .overlay(Capsule().strokeBorder(c.opacity(0.5), lineWidth: 1))
                    .widgetAccentable()
            } else {
                Text(svc.note).font(.system(size: 11.5)).foregroundStyle(p.dim).lineLimit(1)
            }
        }
        .frame(maxHeight: 22)
    }
}

// MARK: - 4 · Backup & Maintenance (medium)

struct MaintenanceView: View {
    var entry: ServerEntry
    var body: some View {
        PaletteReader { p in
            let s = entry.snapshot
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    Caption(text: "Backup & Maintenance", color: p.dim)
                    Spacer(minLength: 4)
                    StaleNote(entry: entry, p: p)
                }
                Spacer(minLength: 6)
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 10) {
                    GridRow {
                        server(s?.backup, p)
                        mac(p)
                    }
                    GridRow {
                        updates(s?.updates, p)
                        certs(s?.certs, p)
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .widgetURL(DashPage.backups.url)
    }

    private func cell(_ label: String, _ value: String, _ sub: String, _ subColor: Color, _ p: Palette, accent: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.system(size: 11)).foregroundStyle(p.dim)
            Text(value).font(.system(size: 16, weight: .semibold)).tracking(-0.2)
                .foregroundStyle(entry.stale ? p.dim : p.text).lineLimit(1).minimumScaleFactor(0.75)
            Text(sub).font(.system(size: 11)).foregroundStyle(subColor).lineLimit(1).minimumScaleFactor(0.85)
                .widgetAccentable(accent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func server(_ b: ServerSnapshot.BackupInfo?, _ p: Palette) -> some View {
        guard let b else { return cell("Last backup", "-", "unknown", p.dim, p) }
        let when = b.lastAt.map { $0.relativeDay(now: entry.date) } ?? "none yet"
        if b.running { return cell("Last backup", when, "running", p.dim, p) }
        if b.ok == false { return cell("Last backup", when, "failed", p.crit, p, accent: true) }
        let old = b.lastAt.map { entry.date.timeIntervalSince($0) > 26 * 3600 } ?? true
        let names = b.targets.map { $0.lowercased() == "local" ? "local" : $0 }
        let complete = !b.configured.isEmpty && b.targets.count == b.configured.count
        let sub = names.isEmpty ? "no target" : names.joined(separator: " + ") + (complete ? "" : " (not all)")
        return cell("Last backup", when, sub, old || !complete ? p.warn : p.ok, p, accent: old || !complete)
    }

    private func mac(_ p: Palette) -> some View {
        let m = entry.mac
        guard let t = m.lastSuccess else {
            return cell("Pulled to Mac", "never", "pull it in the app", p.warn, p, accent: true)
        }
        let today = Calendar.current.isDate(t, inSameDayAs: entry.date)
        let failedSince = m.lastRunOK == false && (m.lastRun ?? .distantPast) > t && m.lastError != MacBackupState.cancelled
        if failedSince { return cell("Pulled to Mac", t.relativeDay(now: entry.date), "last attempt failed", p.crit, p, accent: true) }
        return cell("Pulled to Mac", t.relativeDay(now: entry.date), today ? "verified ✓" : "not today yet",
                    today ? p.ok : p.warn, p, accent: !today)
    }

    private func updates(_ u: ServerSnapshot.Updates?, _ p: Palette) -> some View {
        guard let u else { return cell("Updates", "-", "unknown", p.dim, p) }
        if u.images > 0 {
            return cell("Updates", "\(u.images) available", u.names.prefix(2).joined(separator: ", "), p.dim, p)
        }
        if u.reboot { return cell("Updates", u.apt > 0 ? "\(u.apt) packages" : "installed", "reboot needed", p.warn, p, accent: true) }
        if u.apt > 0 {
            return cell("Updates", u.apt == 1 ? "1 system package" : "\(u.apt) system packages",
                        u.aptSecurity > 0 ? "\(u.aptSecurity) security" : "containers current",
                        u.aptSecurity > 0 ? p.warn : p.dim, p, accent: u.aptSecurity > 0)
        }
        return cell("Updates", "all current", "containers and system", p.dim, p)
    }

    private func certs(_ c: ServerSnapshot.Certs?, _ p: Palette) -> some View {
        guard let c else { return cell("Certificates", "-", "unknown", p.dim, p) }
        let short = String(c.domain.split(separator: ".").first ?? Substring(c.domain))
        if c.minDays < 14 {
            let tone = c.minDays < 7 ? p.crit : p.warn
            return cell("Certificates", c.minDays <= 0 ? "expired" : "\(c.minDays) day\(c.minDays == 1 ? "" : "s") left", c.domain, tone, p, accent: true)
        }
        return cell("Certificates", "all ≥ \(c.minDays) days", "next: \(short)", p.dim, p)
    }
}
