"""Outbound-only local connector. Never executes commands requested by a peer."""

import json
import os
import socket
import ssl
import subprocess
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen, build_opener, HTTPRedirectHandler, HTTPSHandler
from .processes import background_options


class HubUnavailable(ValueError):
    """Transient hub failure, distinct from source and model errors."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # Never forward a credential to a redirected host.


def tls_context():
    """Use trust anchors, not Windows' cached intermediate CA certificates.

    Python's Windows default also imports the CA cache. An expired cross-signed
    intermediate there can shadow the valid chain supplied by the server.
    Keep Python's secure defaults and normal OpenSSL CA-file overrides; never
    change the machine trust store, turn off hostname checks or retry unverified.
    """
    if os.name != 'nt':
        return ssl.create_default_context()
    roots = [ssl.DER_cert_to_PEM_cert(cert)
             for cert, encoding, trust in ssl.enum_certificates('ROOT')
             if encoding == 'x509_asn' and (trust is True or ssl.Purpose.SERVER_AUTH.oid in trust)]
    if not roots:
        raise ssl.SSLError('Windows has no trusted TLS server root certificates')
    context = ssl.create_default_context(cadata='\n'.join(roots))
    context.set_default_verify_paths()
    return context


class Client:
    def __init__(self, url, token):
        self.url = url.rstrip("/")
        parsed = urlsplit(self.url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.query or parsed.fragment:
            raise ValueError("Use a valid http(s) hub URL without credentials, query, or fragment")
        self.token = token
        self._https_handler = None

    def request(self, path, data=None):
        headers = {"Content-Type": "application/json", "X-Relay-Client": "web"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        req = Request(self.url + path, data=json.dumps(data).encode() if data is not None else None,
                      headers=headers)
        try:
            handlers = [NoRedirect]
            if self.url.startswith('https://'):
                if self._https_handler is None:
                    self._https_handler = HTTPSHandler(context=tls_context())
                handlers.append(self._https_handler)
            with build_opener(*handlers).open(req, timeout=12) as response:
                return json.load(response)
        except HTTPError as exc:
            try:
                message = json.load(exc).get("error", f"Hub returned {exc.code}")
            except (ValueError, AttributeError):
                message = f"Hub returned {exc.code}"
            raise (HubUnavailable if exc.code >= 500 else ValueError)(message) from None
        except (URLError, TimeoutError, ConnectionError, ssl.SSLError) as exc:
            if isinstance(getattr(exc, 'reason', exc), ssl.SSLError):
                raise HubUnavailable('Workspace HTTPS verification failed. Check this computer\'s date/time, '
                                     'trusted certificates and the hub certificate. Do not disable TLS verification.') from None
            raise HubUnavailable("Hub unavailable. Check the URL and network; local work is unaffected.") from None

    def action(self, action, data):
        return self.request("/api/actions/" + action, data)


def git_info(repo):
    repo = Path(repo).resolve()
    def git(*args):
        result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10, **background_options())
        if result.returncode:
            raise ValueError("Repository must be an existing Git checkout with at least one commit")
        return result.stdout.strip()
    return {"commit_sha": git("rev-parse", "HEAD"), "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
            "dirty": bool(git("status", "--porcelain"))}


def load_config(path):
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    return config, Client(config["url"], config["token"])


def connect(args, token=None):
    token = token or os.environ.get("RELAY_TOKEN", "")
    if args.token_file:
        token = Path(args.token_file).read_text(encoding="utf-8").strip()
    if not token:
        import getpass
        token = getpass.getpass("Workspace access token: ")
    config_path = Path(args.config).resolve()
    if config_path.exists():
        raise ValueError("Config already exists. Choose another --config for a separate session.")
    client = Client(args.url, token)
    state = client.request("/api/state")
    project = next((p for p in state["projects"] if p["id"] == args.project or p["name"] == args.project), None)
    if not project:
        raise ValueError("Project not found. Create it in the browser first. Available: " + ", ".join(p["name"] for p in state["projects"]))
    repo = str(Path(args.repo).resolve())
    info = git_info(repo)
    live={}
    if getattr(args,'agent',None):
        if args.max_calls_per_hour < 0:
            raise ValueError('The hourly call limit cannot be negative')
        if not args.share_session:
            raise ValueError('Use --share-session to authorize ongoing sharing and automatic explanation forks for this selected session.')
        if not args.source_session:
            raise ValueError('--source-session is required')
        live=dict(provider=args.agent,source_id=args.source_session,share_session=True,
                  response_timeout=120,summary_interval=60,max_calls_per_hour=args.max_calls_per_hour)
        if args.agent=='claude':
            if not args.source_file:raise ValueError('Claude connections require --source-file for the selected transcript')
            live['source_file']=str(Path(args.source_file).resolve())
        from .adapters import adapter
        source=adapter(dict(repo=repo,**live))
        try:source.snapshot()  # Verify selected session identity and repository before sharing.
        finally:source.close()
    session = client.action("session", dict(project_id=project["id"], name=args.name,
                           machine=socket.gethostname(), **info))
    config = dict(url=client.url, token=token, session_id=session["id"], project_id=project["id"], repo=repo,**live)
    if live:
        client.action('bind',dict(session_id=session['id'],provider=live['provider'],source_id=live['source_id'],title=args.name))
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    config_path.chmod(0o600)
    if not getattr(args, 'quiet', False):
        print(f"Connected {args.name} to {project['name']}. Private connector config: {config_path}")
        print('Run python -m relay watch --config "'+str(config_path)+'" to start automatic capture and clarification.' if live else "Start the MCP connector from your agent client using the command in README.md.")
    return config_path


def sessions(args):
    """Discover only metadata under an explicitly selected repository."""
    print(json.dumps(discover_sessions(args.agent,args.repo),indent=2))


def discover_sessions(provider, repository):
    repo=str(Path(repository).resolve())
    if provider=='codex':
        from .adapters import CodexRPC
        rpc=CodexRPC(repo)
        try:
            result=rpc.request('thread/list',{'cwd':repo,'limit':50,'sortKey':'updated_at','sourceKinds':[]})
            return [{'id':t['id'],'name':t.get('name'),'updated':t.get('updatedAt')}
                    for t in result.get('data',[])]
        finally:rpc.close()
    else:
        from .discovery import claude_sessions
        return claude_sessions(repo)


def publish(args):
    config, client = load_config(args.config)
    data = json.loads(Path(args.file).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Checkpoint file must contain a JSON object")
    data.update(session_id=config["session_id"], **git_info(config["repo"]))
    # No transcript directories are scanned. Only this explicitly selected file is published.
    if not args.share:
        preview = {k: v for k, v in data.items() if k != "session_id"}
        print(json.dumps(preview, ensure_ascii=False, indent=2))
        print("\nPreview only. Review for secrets and private material, then repeat with --share.")
        return
    print(json.dumps(client.action("checkpoint", data), indent=2))
