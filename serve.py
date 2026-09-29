"""Serve PokéBinder on this PC and your home Wi-Fi (so your phone can open it)."""
import http.server
import os
import socket
import webbrowser

PORT = 8000


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
webbrowser.open(f"http://localhost:{PORT}")
http.server.ThreadingHTTPServer(("0.0.0.0", PORT), http.server.SimpleHTTPRequestHandler).serve_forever()
