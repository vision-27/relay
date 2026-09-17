"""One-use invitations and short-lived browser approval for local companions."""
import secrets
import threading
import time

from .store import Problem, digest, field, identity


def migrate(db):
    db.execute('''CREATE TABLE IF NOT EXISTS invitations (
        secret_hash TEXT PRIMARY KEY, name TEXT NOT NULL, expires REAL NOT NULL,
        used INTEGER NOT NULL DEFAULT 0)''')


def invite(store, member, data):
    if member['role'] != 'owner':
        raise Problem('Only the workspace owner can invite teammates.', 403)
    name = field(data, 'name', 100)
    secret = secrets.token_urlsafe(32)
    with store.connect() as db:
        db.execute('INSERT INTO invitations VALUES (?, ?, ?, 0)',
                   (digest(secret), name, time.time() + 86400))
    return {'secret': secret, 'expires_in': 86400}


def invitation(store, data, redeem=False):
    secret = field(data, 'secret', 200)
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT * FROM invitations WHERE secret_hash=? AND used=0 AND expires>?',
                         (digest(secret), time.time())).fetchone()
        if not row:
            raise Problem('This invite has expired or has already been used. Ask for a new invite.', 410)
        if not redeem:
            return {'name': row['name']}
        token = secrets.token_urlsafe(32)
        db.execute("INSERT INTO members VALUES (?, ?, ?, 'member', 0)",
                   (identity(), row['name'], digest(token)))
        db.execute('UPDATE invitations SET used=1 WHERE secret_hash=?', (digest(secret),))
    return token


class Pairings:
    """Credentials exist only until delivery or expiry; never in hub state or logs."""
    def __init__(self):
        self.lock = threading.Lock()
        self.pending = {}

    def run(self, action, data, store, token=''):
        with self.lock:
            now = time.monotonic()
            self.pending = {k: v for k, v in self.pending.items() if v['expires'] > now}
            if action == 'start':
                name = field(data, 'machine', 100)
                if len(self.pending) >= 32:
                    raise Problem('Too many pending connections. Try again in five minutes.', 429)
                secret = secrets.token_urlsafe(32)
                code = secrets.token_hex(4).upper()
                while any(p['code'] == code for p in self.pending.values()):
                    code = secrets.token_hex(4).upper()
                self.pending[digest(secret)] = dict(machine=name, code=code, expires=now+300)
                return {'device_secret': secret, 'code': code}
            if action == 'poll':
                key = digest(field(data, 'device_secret', 200))
                pending = self.pending.get(key)
                if not pending:
                    raise Problem('Connection approval expired. Click Connect workspace again.', 410)
                if 'token' not in pending:
                    return {'status': 'pending'}
                store.authenticate(pending['token'])
                del self.pending[key]
                return {'status': 'approved', 'token': pending['token']}
            store.authenticate(token)
            code = field(data, 'code', 20)
            pending = next((p for p in self.pending.values() if p['code'] == code), None)
            if not pending:
                raise Problem('Connection request expired. Try again from the Relay app.', 410)
            if action == 'preview':
                return {'machine': pending['machine'], 'code': code}
            if action != 'approve':
                raise Problem('Not found', 404)
            if 'token' in pending:
                raise Problem('This connection has already been approved.', 409)
            pending['token'] = token
            return {'ok': True}
