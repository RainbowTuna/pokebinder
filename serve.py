"""Serve PokéBinder on this PC and your home Wi-Fi (so your phone can open it).

Also answers /card-image?pid=… like the Supabase picture relay (supabase/functions/card-image),
so the scanner's picture check works locally too. --no-browser: don't open a browser tab.
"""
import http.server
import os
import re
import socket
import sys
import urllib.request
import webbrowser
from urllib.parse import parse_qs, urlparse

PORT = 8000
# Windows consoles in some languages (e.g. Thai) can't print "é" – don't crash over it.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        if url.path != "/card-image":
            return super().do_GET()
        query = parse_qs(url.query)
        pid = query.get("pid", [""])[0]
        size = query.get("size", ["200w"])[0]
        if not re.fullmatch(r"\d{1,9}", pid) or size not in ("200w", "400w"):
            return self.send_error(400)
        try:
            with urllib.request.urlopen(f"https://tcgplayer-cdn.tcgplayer.com/product/{pid}_{size}.jpg", timeout=20) as r:
                body = r.read()
        except Exception:
            return self.send_error(404)
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no data is sent; just picks the Wi-Fi interface
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


os.chdir(os.path.dirname(os.path.abspath(__file__)))
ip = lan_ip()
print(f"\n  PokéBinder is running!\n\n  On this PC:  http://localhost:{PORT}")
if ip:
    print(f"  On phone:    http://{ip}:{PORT}   (same Wi-Fi)")
print("\n  Press Ctrl+C to stop.\n")
if "--no-browser" not in sys.argv:
    webbrowser.open(f"http://localhost:{PORT}")
http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
