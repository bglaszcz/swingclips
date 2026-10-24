"""Finding the home server on the network, for the programs that talk to it from another PC (the night
worker, night_improve.py by hand, fixtures_export.py). The server's address can change (a new router,
another subnet: Oct 2026 it moved from 192.168.86.250 to 192.168.7.250), so nothing depends on one:

1. the address given (--server, or SWINGCLIPS_SERVER), as it is;
2. else the one that worked last time (LAST_FILE), then DEFAULT;
3. else a look round: each network this PC is on, the last address's network and HOME_NETWORKS (where
   the server lives; other subnets and VLANs reach it through the router), HOST first on each, then
   every address there. What's found is kept in LAST_FILE for next time.

A server is whatever answers GET /api/time with {"ms": <its clock>} (and "app": "swingclips" from Oct
2026 on). The phones (capture app, ServerFinder.kt) and the sim laptop's scripts (relay/golf-common.ps1)
look the same way.
"""
import ipaddress
import json
import re
import socket
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

DEFAULT = "http://192.168.7.250:8000"
# Networks looked round besides this PC's own: the first three numbers of a /24.
HOME_NETWORKS = ("192.168.7",)
PORT = 8000
# The server's usual last number (reserved for it in the router): tried first on every network.
HOST = 250
LAST_FILE = Path(__file__).with_name("last-server.txt")
# Seconds to wait for an address tried on its own, and for each one looked at in a sweep.
CHECK_S = 2.0
SWEEP_CONNECT_S = 0.5
SWEEP_THREADS = 64


def is_server(body) -> bool:
    """Whether a GET /api/time answer is a SwingClips server's."""
    try:
        got = json.loads(body)
    except (ValueError, TypeError):
        return False
    return (isinstance(got, dict) and isinstance(got.get("ms"), (int, float)) and not isinstance(got.get("ms"), bool)
            and got.get("app", "swingclips") == "swingclips")


def check(url: str, timeout: float = CHECK_S) -> bool:
    """Whether a SwingClips server answers at this address."""
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/api/time", timeout=timeout) as r:
            return r.status == 200 and is_server(r.read(4096))
    except (OSError, ValueError):
        return False


def network_of(address: str | None) -> str | None:
    """"192.168.7" from "http://192.168.7.250:8000" or "192.168.7.250"; None for a name."""
    m = re.match(r"^(?:https?://)?(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}(?::\d+)?/?$", (address or "").strip())
    return m.group(1) if m else None


def port_of(url: str | None) -> int:
    m = re.match(r"^(?:https?://)?[^/:]+:(\d+)", (url or "").strip())
    return int(m.group(1)) if m else PORT


def own_networks() -> list[str]:
    """The networks (first three numbers) of this PC's private IPv4 addresses, the one with the default route first."""
    ips = []
    try:
        # No packet is sent: connecting a UDP socket only picks the way out.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            ips.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        ips += [a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)]
    except OSError:
        pass
    out = []
    for ip in ips:
        try:
            a = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if a.is_private and not a.is_loopback and not a.is_link_local:
            out.append(network_of(ip))
    return list(dict.fromkeys(n for n in out if n))


def networks(last: str | None, own: list[str], home=HOME_NETWORKS) -> list[str]:
    """The networks to look round, in order and once each: the last address's, this PC's, the home ones."""
    return list(dict.fromkeys(n for n in [network_of(last), *own, *home] if n))


def sweep(nets: list[str], port: int = PORT, connect_s: float = SWEEP_CONNECT_S, threads: int = SWEEP_THREADS) -> str | None:
    """The first SwingClips server found on these networks: HOST on each first, then every other address."""

    def look(ip: str) -> str | None:
        try:
            socket.create_connection((ip, port), timeout=connect_s).close()
        except OSError:
            return None
        url = f"http://{ip}:{port}"
        return url if check(url) else None

    rounds = [[f"{n}.{HOST}" for n in nets], [f"{n}.{i}" for n in nets for i in range(1, 255) if i != HOST]]
    ex = ThreadPoolExecutor(threads)
    try:
        for ips in rounds:
            for f in as_completed([ex.submit(look, ip) for ip in ips]):
                if f.result():
                    return f.result()
        return None
    finally:
        ex.shutdown(wait=False, cancel_futures=True)   # the ones still looking end on their own


def read_last(path: Path = LAST_FILE) -> str | None:
    try:
        return path.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def save_last(url: str, path: Path = LAST_FILE) -> None:
    try:
        path.write_text(url + "\n", encoding="utf-8")
    except OSError:
        pass


def find(given: str | None = None, say=print, last_file: Path = LAST_FILE, default: str = DEFAULT,
         home=HOME_NETWORKS) -> str:
    """The server's address (see the top of this file). When nothing answers: the last one, else DEFAULT."""
    if given:
        return given.rstrip("/")
    last = read_last(last_file)
    for url in dict.fromkeys(u for u in (last, default) if u):
        if check(url):
            if url != last:
                save_last(url.rstrip("/"), last_file)
            return url.rstrip("/")
    nets = networks(last or default, own_networks(), home)
    say(f"Looking for the SwingClips server on {', '.join(n + '.x' for n in nets)} ...")
    found = sweep(nets, port_of(last or default))
    if found:
        save_last(found, last_file)
        say(f"Found the SwingClips server at {found}")
        return found
    say("Couldn't find the SwingClips server on the network (is it on?)")
    return (last or default).rstrip("/")


if __name__ == "__main__":
    print(find())
