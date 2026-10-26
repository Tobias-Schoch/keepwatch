"""Look up one IP (quick search, Cmd+K): country, SSH attempts, bans, logins.

Wired into dashboard.py:  GET /api/security/ip?ip=<ip>  ->  ip_info(query, globals())

Read-only. Uses what dashboard.py keeps anyway (country database, daily attempt
history, login IPs, fail2ban state) and queries the fail2ban database read-only
for the bans of this one IP. Without the fail2ban module, bans and jails stay empty.
"""

from __future__ import annotations

import ipaddress
import sqlite3

import config


def ip_info(query: dict, g: dict) -> dict:
    api_error = g["ApiError"]
    raw = (query.get("ip") or [""])[0].strip()
    try:
        ip = str(ipaddress.ip_address(raw))
    except ValueError:
        raise api_error(400, "That is not a valid IP address.")

    country = g["geo"](ip)
    f2b = config.enabled("fail2ban")

    # SSH attempts: per-day counts for this IP from the history (finished days) plus today, if counted yet.
    sec = g["SEC"]
    with sec["lock"]:
        per_day = {d: (e.get("ips") or {}).get(ip, 0) for d, e in sec["days"].items()}
    today = sec.get("today")
    if today:
        per_day[g["local_day"](g["now"]())] = (today.get("ips") or {}).get(ip, 0)
    hit = sorted(d for d, n in per_day.items() if n)
    attempts = {"total": sum(per_day.values()), "days": len(hit),
                "first": hit[0] if hit else None, "last": hit[-1] if hit else None,
                "since": sec.get("first")}
    top24 = None
    cur = g["safe"]("security")
    if cur and cur.get("enabled") is False:
        cur = None
    if cur:
        top24 = next((t["count"] for t in cur.get("topIps", []) if t["ip"] == ip), None)
    attempts["last24h"] = top24   # only known if the IP is among the 10 most frequent of the last 24 h

    # Bans: active per the fail2ban state, history from the fail2ban database.
    active, history = [], []
    if f2b:
        active = sorted({b["jail"] for b in (cur or {}).get("bans", []) if b["ip"] == ip and b["active"]})
        try:
            con = sqlite3.connect(f"file:{g['F2B_DB']}?mode=ro", uri=True, timeout=5)
            rows = con.execute("SELECT jail, timeofban, bantime, bancount FROM bans WHERE ip = ? "
                               "ORDER BY timeofban DESC LIMIT 20", (ip,)).fetchall()
            con.close()
            history = [{"jail": j, "bannedAt": tob, "expiresAt": None if bt < 0 else tob + bt, "banCount": n}
                       for j, tob, bt, n in rows]
        except sqlite3.Error:
            pass
    if config.enabled("ban-history") and ip in g["ban_history_ips"]():  # past attackers (keepwatch-ban-history)
        active.append("ban-history")

    # Successful logins (since the journal begins).
    logins = None
    with g["LOGINS"]["lock"]:
        e = g["LOGINS"]["ips"].get(ip)
        if e:
            logins = {"count": e.get("count", 0), "first": e.get("first"), "last": e.get("last"),
                      "users": list(e.get("users", [])), "methods": list(e.get("methods", []))}

    return {"ip": ip, "country": country, "tailnet": country.get("name") == "Tailnet",
            "attempts": attempts, "banned": active, "bans": history, "logins": logins,
            "jails": [j["name"] for j in (cur or {}).get("jails", [])] if f2b else []}
