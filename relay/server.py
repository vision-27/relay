"""Local/team HTTP hub. Use a TLS reverse proxy for access beyond localhost."""

import ipaddress
import hashlib
import json
import mimetypes
import secrets
import sys
import time
import threading
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .store import Problem, Store
from .distribution import client_archive, installer_script
from .homebrew import asset as homebrew_asset

WEB = Path(__file__).parent / "web"


def configured_origin(directory, explicit=None):
    path=Path(directory)/'network.json'
    origin=explicit
    if not origin and path.exists():
        try:origin=json.loads(path.read_text(encoding='utf-8'))['public_origin']
        except (ValueError,KeyError,TypeError):
            raise ValueError('Invalid saved network settings. Repair network.json before starting the hub.') from None
        if not origin:raise ValueError('Saved network settings must specify public_origin')
    if not origin:return None
    if not isinstance(origin,str):raise ValueError('Workspace origin must be a URL')
    parsed=urlsplit(origin)
    if (parsed.scheme not in {'http','https'} or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in {'','/'}):
        raise ValueError('Workspace origin must be an exact http(s) origin without a path or credentials')
    return origin.rstrip('/')


class Hub(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, store, public_origin=None):
        super().__init__(address, Handler)
        self.stopping=threading.Event()
        self.store = store
        from .join import Pairings
        self.pairings = Pairings()
        port = self.server_address[1]
        self.origins = {f"http://localhost:{port}", f"http://127.0.0.1:{port}"}
        self.public_origin = configured_origin(store.directory,public_origin)
        if self.public_origin:
            self.origins.add(self.public_origin)

    def shutdown(self):
        self.stopping.set()
        super().shutdown()

    def server_close(self):
        self.stopping.set()
        super().server_close()


class Handler(BaseHTTPRequestHandler):
    server_version = "Relay/0.2"

    def stream(self, token):
        self.send_response(200)
        self.send_header('Content-Type','text/event-stream')
        self.send_header('Cache-Control','no-cache, no-transform')
        self.send_header('X-Accel-Buffering','no')
        self.send_header('Connection','close')
        self.end_headers()
        previous=None
        end=time.monotonic()+45
        while time.monotonic()<end and not self.server.stopping.is_set():
            try:self.server.store.authenticate(token)
            except Problem:break
            with self.server.store.connect() as db:
                signature=tuple(db.execute('''SELECT
                    (SELECT MAX(id) FROM events), (SELECT MAX(id) FROM observations),
                    (SELECT MAX(updated) FROM bindings), (SELECT MAX(updated) FROM jobs),
                    (SELECT SUM(last_seen) FROM sessions), (SELECT COUNT(*) FROM members),
                    (SELECT SUM(revoked) FROM members)''').fetchone())
            if signature!=previous:
                self.wfile.write(b'event: changed\ndata: {}\n\n')
                previous=signature
            else:self.wfile.write(b': heartbeat\n\n')
            self.wfile.flush()
            self.server.stopping.wait(1)
        self.close_connection=True

    def log_message(self, *_):
        pass  # URLs can contain search text. Do not log team content or credentials.

    def send(self, status, payload, content_type="application/json; charset=utf-8", cookie=None, attachment=None, archive_hash=None):
        content = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        if attachment:
            self.send_header('Content-Disposition', f'attachment; filename="{attachment}"')
        if archive_hash:
            self.send_header('X-Relay-Archive-SHA256', archive_hash)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(content)

    def cookie(self, token, clear=False):
        secure = "; Secure" if self.server.public_origin and self.server.public_origin.startswith("https:") else ""
        return f"relay_token={token}; HttpOnly; SameSite=Strict; Path=/" + ("; Max-Age=0" if clear else "") + secure

    def token(self):
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:]
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            return cookie["relay_token"].value if "relay_token" in cookie else ""
        except Exception:
            return ""

    def validate_origin(self):
        allowed_hosts = {urlsplit(o).netloc for o in self.server.origins}
        if self.headers.get("Host", "") not in allowed_hosts:
            raise Problem("Unrecognized host. Configure --public-origin for your team URL.", 403)
        origin = self.headers.get("Origin")
        if origin and origin not in self.server.origins:
            raise Problem("Cross-origin access is not allowed", 403)
        auth = self.headers.get("Authorization", "")
        # Revision 2 companions sent an empty "Bearer " before browser approval.
        # HTTPS proxies may trim it to "Bearer". Support only the two anonymous
        # device endpoints, without cookies or browser origins. This marker is
        # NOT authentication; approval still needs a member and polling a secret.
        legacy_pairing = (auth == 'Bearer' and not origin and not self.headers.get('Cookie')
                          and urlsplit(self.path).path in {'/api/pair/start', '/api/pair/poll'})
        if self.command == "POST" and not auth.startswith("Bearer ") and not legacy_pairing:
            if self.headers.get("X-Relay-Client") != "web":
                raise Problem("Missing browser request header", 403)

    def body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise Problem("Invalid content length")
        if length < 0 or length > 160000:
            raise Problem("Request is too large", 413)
        if self.headers.get_content_type() != "application/json":
            raise Problem("Use application/json", 415)
        try:
            value = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            raise Problem("Invalid JSON")
        if not isinstance(value, dict):
            raise Problem("Request must be a JSON object")
        return value

    def do_GET(self):
        self.dispatch()

    def do_HEAD(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def dispatch(self):
        try:
            self.validate_origin()
            path = urlsplit(self.path).path
            if path == "/health" and self.command == "GET":
                from .reliability import release_info
                return self.send(200, {"ok": True, **release_info()})
            workspace_url = self.server.public_origin or 'http://' + self.headers['Host']
            if path == '/install.py' and self.command == 'GET':
                return self.send(200, installer_script(workspace_url), 'text/plain; charset=utf-8')
            if path == '/client.zip' and self.command == 'GET':
                archive = client_archive()
                return self.send(200, archive, 'application/zip', attachment='relay-client.zip',
                                 archive_hash=hashlib.sha256(archive).hexdigest())
            if path.startswith('/homebrew/') and self.command in {'GET', 'HEAD'}:
                found = homebrew_asset(self.server.store.directory, path)
                if found is None:
                    raise Problem('Not found', 404)
                return self.send(200, *found)
            if not path.startswith("/api/"):
                if self.command != "GET":
                    raise Problem("Not found", 404)
                names = {"/": "index.html", "/app.js": "app.js", "/style.css": "style.css", "/live.css":"live.css", "/favicon.svg": "favicon.svg"}
                if path not in names:
                    raise Problem("Not found", 404)
                asset = WEB / names[path]
                return self.send(200, asset.read_bytes(), (mimetypes.guess_type(asset.name)[0] or "text/plain") + "; charset=utf-8")
            data = self.body() if self.command == "POST" else {}
            store = self.server.store
            if self.command == 'POST' and path in {'/api/invitation', '/api/join'}:
                from .join import invitation
                if path == '/api/invitation':
                    return self.send(200, invitation(store, data))
                token = invitation(store, data, redeem=True)
                return self.send(200, store.authenticate(token), cookie=self.cookie(token))
            if self.command == 'POST' and path.startswith('/api/pair/'):
                return self.send(200, self.server.pairings.run(path.rsplit('/', 1)[1], data, store, self.token()))
            if path == "/api/local-session" and self.command == "POST":
                host = urlsplit("http://" + self.headers.get("Host", "")).hostname
                if (not ipaddress.ip_address(self.client_address[0]).is_loopback
                        or host not in {"localhost", "127.0.0.1"} or self.server.public_origin):
                    raise Problem("Use your own access token to join this workspace.", 401)
                token = (store.directory / "owner-token").read_text(encoding="utf-8").strip()
                member = store.authenticate(token)
                return self.send(200, member, cookie=self.cookie(token))
            if path == "/api/login" and self.command == "POST":
                token = data.get("token", "")
                if not isinstance(token, str) or len(token) > 200:
                    raise Problem("Invalid token", 401)
                member = store.authenticate(token)
                return self.send(200, member, cookie=self.cookie(token))
            member = store.authenticate(self.token())
            if path == '/api/actions/invite-link' and self.command == 'POST':
                from .join import invite
                result = invite(store, member, data)
                return self.send(200, {'url': workspace_url + '/#invite=' + result['secret'],
                                       'expires_in': result['expires_in']})
            if path == '/api/download/relay-client.zip' and self.command == 'GET':
                archive = client_archive()
                return self.send(200, archive, 'application/zip', attachment='relay-client.zip',
                                 archive_hash=hashlib.sha256(archive).hexdigest())
            if path == "/api/logout" and self.command == "POST":
                return self.send(200, {"ok": True}, cookie=self.cookie("", clear=True))
            if self.command == "GET":
                query = parse_qs(urlsplit(self.path).query)
                if path == "/api/state":
                    return self.send(200, dict(store.state(member), workspace_url=workspace_url))
                if path == '/api/stream':
                    return self.stream(self.token())
                if path == "/api/search":
                    return self.send(200, store.search(member, query.get("project_id", [""])[0],
                        query.get("q", [""])[0], query.get("commit", [""])[0]))
                if path.startswith("/api/history/"):
                    return self.send(200, store.history(path.rsplit("/", 1)[1]))
            if self.command == "POST" and path.startswith("/api/actions/"):
                return self.send(200, store.mutate(path.rsplit("/", 1)[1], data, member))
            raise Problem("Not found", 404)
        except Problem as exc:
            self.send(exc.status, {"error": str(exc)})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as exc:
            print(f"Relay request failed: {type(exc).__name__}", file=sys.stderr)
            self.send(500, {"error": "Internal error. Check the hub terminal."})


def serve(args):
    args.public_origin=configured_origin(args.data,args.public_origin)
    if args.host not in {"127.0.0.1", "localhost"} and not args.public_origin:
        raise SystemExit("Remote binding requires --public-origin https://your-team-host (TLS reverse proxy), or an explicit http:// private-network URL.")
    store = Store(args.data)
    server = Hub((args.host, args.port), store, args.public_origin)
    print(f"Relay is running at http://localhost:{server.server_address[1]}", flush=True)
    if server.public_origin:print(f'Team address: {server.public_origin} (network proxy must be running)',flush=True)
    print(f"Workspace data: {store.directory}\nPress Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
