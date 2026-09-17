import hashlib
import unittest

import test_relay
import test_coordination


class LiveCoordinationTests(unittest.TestCase):
    setUp = test_relay.RelayIntegrationTests.setUp
    tearDown = test_relay.RelayIntegrationTests.tearDown
    plan = test_coordination.CoordinationTests.plan
    update = test_coordination.CoordinationTests.update
    review = test_coordination.CoordinationTests.review

    def live(self, client, sid, action, **data):
        return client.action('live-' + action, dict(session_id=sid, instance=sid, **data))

    def join(self, client, sid, key='same repo'):
        return self.live(client, sid, 'join', repository_key=hashlib.sha256(key.encode()).hexdigest())

    def drain(self, client, sid):
        messages = self.live(client, sid, 'poll')['messages']
        for m in messages:
            self.live(client, sid, 'delivered', message_id=m['message_id'])
            self.live(client, sid, 'ack', message_id=m['message_id'], note='Considered this event against my plan')
        return messages

    def prepare(self):
        self.join(self.alice, self.a_session)
        self.join(self.bob, self.b_session)
        a = self.plan(self.alice, self.a_session, ['src/auth'])
        b = self.plan(self.bob, self.b_session, ['src/billing'])
        self.review(self.alice, self.a_session, b, a)
        self.review(self.bob, self.b_session, a, b)
        self.drain(self.alice, self.a_session)
        self.drain(self.bob, self.b_session)
        self.assertTrue(self.update(self.alice, self.a_session, a, 'start')['proceed'])
        self.drain(self.bob, self.b_session)
        self.assertTrue(self.update(self.bob, self.b_session, b, 'start')['proceed'])
        self.drain(self.alice, self.a_session)
        return a, b

    def test_delivery_is_not_acknowledgement_and_ack_is_not_review(self):
        self.join(self.alice, self.a_session)
        self.join(self.bob, self.b_session)
        a = self.plan(self.alice, self.a_session)
        b = self.plan(self.bob, self.b_session, ['other'])
        before = self.live(self.alice, self.a_session, 'poll')['messages']
        m = before[0]
        with self.assertRaisesRegex(ValueError, 'not been delivered'):
            self.live(self.alice, self.a_session, 'ack', message_id=m['message_id'], note='Ack')
        self.live(self.alice, self.a_session, 'delivered', message_id=m['message_id'])
        self.assertEqual(len(self.live(self.alice, self.a_session, 'poll')['messages']), len(before))
        self.drain(self.alice, self.a_session)
        result = self.update(self.alice, self.a_session, a, 'start')
        self.assertFalse(result['proceed'])
        self.assertIn('needs_peer_review', [b['kind'] for b in result['blockers']])

    def test_parallel_work_pauses_on_new_message_and_recovers_after_explicit_ack(self):
        a, b = self.prepare()
        self.assertTrue(self.update(self.alice, self.a_session, a, 'check')['proceed'])
        self.bob.action('work-message', dict(session_id=self.b_session, work_id=a['id'], note='API shape needs clarification'))
        self.assertFalse(self.update(self.alice, self.a_session, a, 'check')['proceed'])
        self.drain(self.alice, self.a_session)
        self.assertTrue(self.update(self.alice, self.a_session, a, 'check')['proceed'])

    def test_queue_survives_restart_and_more_than_ui_history_limit(self):
        a, b = self.prepare()
        bob = self.store.authenticate(self.bob_token)
        for i in range(205):
            self.store.mutate('work-message', dict(session_id=self.b_session, work_id=a['id'], note=f'Event {i}'), bob)
        from relay.store import Store
        Store(self.directory / 'hub')
        total = []
        for _ in range(3):
            total.extend(self.drain(self.alice, self.a_session))
        self.assertEqual(len(total), 205)
        self.assertEqual(len({m['message_id'] for m in total}), 205)

    def test_offline_paused_and_unplanned_peers_block_work(self):
        self.join(self.alice, self.a_session)
        self.join(self.bob, self.b_session)
        a = self.plan(self.alice, self.a_session)
        self.assertIn('peer_needs_plan', [b['kind'] for b in self.update(self.alice, self.a_session, a, 'start')['blockers']])
        self.live(self.bob, self.b_session, 'pause')
        self.assertFalse(self.update(self.alice, self.a_session, a, 'start')['proceed'])
        self.join(self.bob, self.b_session)
        with self.store.connect() as db:
            db.execute('UPDATE live_runtimes SET seen=0 WHERE session_id=?', (self.b_session,))
        self.assertIn('peer_unavailable', [b['kind'] for b in self.update(self.alice, self.a_session, a, 'start')['blockers']])

    def test_wrong_repo_controller_and_forged_delivery_rejected(self):
        self.join(self.alice, self.a_session)
        with self.assertRaisesRegex(ValueError, 'different repository'):
            self.join(self.bob, self.b_session, 'other repo')
        with self.assertRaisesRegex(ValueError, 'already has a live controller'):
            self.alice.action('live-join', dict(session_id=self.a_session, instance='another', repository_key=hashlib.sha256(b'same repo').hexdigest()))
        with self.assertRaisesRegex(ValueError, 'Only this session'):
            self.live(self.bob, self.a_session, 'poll')
        with self.assertRaisesRegex(ValueError, 'not addressed'):
            self.live(self.alice, self.a_session, 'delivered', message_id=100)

    def test_leaving_never_releases_reservations(self):
        a, b = self.prepare()
        self.live(self.alice, self.a_session, 'leave')
        state = self.bob.request('/api/state')['coordination']
        self.assertEqual(next(w for w in state['plans'] if w['id'] == a['id'])['status'], 'working')
        with self.assertRaisesRegex(ValueError, 'paused or stopped'):
            self.live(self.alice, self.a_session, 'poll')

    def test_pause_replan_retains_scope_and_invalidates_reviews(self):
        a, b = self.prepare()
        self.update(self.alice, self.a_session, a, 'pause', note='Need to adjust API')
        self.assertFalse(self.update(self.alice, self.a_session, a, 'check')['proceed'])
        with self.assertRaisesRegex(ValueError, 'retain reserved'):
            self.plan(self.alice, self.a_session, ['new-file'], revision=1)
        changed = self.plan(self.alice, self.a_session, ['src/auth', 'new-file'], revision=1)
        self.assertEqual(changed['status'], 'paused')
        self.assertEqual(changed['revision'], 2)
        self.drain(self.alice, self.a_session)
        result = self.update(self.alice, self.a_session, changed, 'start')
        self.assertFalse(result['proceed'])
        self.assertIn('needs_peer_review', [x['kind'] for x in result['blockers']])

    def test_mcp_ack_is_bound_to_the_opted_in_session(self):
        from relay.mcp import Connector
        self.join(self.alice, self.a_session)
        self.join(self.bob, self.b_session)
        self.plan(self.bob, self.b_session)
        config = dict(session_id=self.a_session, project_id=self.project, repo=str(self.directory))
        ordinary = Connector(config, self.alice)
        with self.assertRaisesRegex(ValueError, 'not an opted-in'):
            ordinary.call('relay_live_inbox', {})
        live = Connector(dict(config, live_instance=self.a_session), self.alice)
        messages = live.call('relay_live_inbox', {})['messages']
        for message in messages:
            live.call('relay_live_ack', dict(message_id=message['message_id'], note='Need my own plan before agreement'))
        self.assertEqual(live.call('relay_live_inbox', {})['messages'], [])
        with self.assertRaisesRegex(ValueError, 'Unexpected tool argument'):
            live.call('relay_live_ack', dict(message_id=1, note='spoof', session_id=self.b_session))

    def test_late_join_delivers_open_work_and_reconnect_does_not_erase_ack(self):
        self.plan(self.alice, self.a_session)
        self.join(self.bob, self.b_session)
        messages = self.drain(self.bob, self.b_session)
        self.assertEqual(len(messages), 1)
        self.live(self.bob, self.b_session, 'pause')
        self.join(self.bob, self.b_session)
        self.assertEqual(self.live(self.bob, self.b_session, 'poll')['messages'], [])

    def test_stale_controller_can_be_replaced_but_not_used_again(self):
        self.join(self.alice, self.a_session)
        with self.store.connect() as db:
            db.execute('UPDATE live_runtimes SET seen=0 WHERE session_id=?', (self.a_session,))
        self.alice.action('live-join', dict(session_id=self.a_session, instance='replacement', repository_key=hashlib.sha256(b'same repo').hexdigest()))
        with self.assertRaisesRegex(ValueError, 'not current'):
            self.live(self.alice, self.a_session, 'poll')

    def test_acknowledgement_is_idempotent_and_revoked_peer_stays_blocking(self):
        a, b = self.prepare()
        self.bob.action('work-message', dict(session_id=self.b_session, work_id=a['id'], note='Review the latest contract'))
        message = self.drain(self.alice, self.a_session)[0]
        self.live(self.alice, self.a_session, 'ack', message_id=message['message_id'], note='Retry')
        with self.store.connect() as db:
            row = db.execute('SELECT note FROM live_deliveries WHERE message_id=? AND session_id=?',
                             (message['message_id'], self.a_session)).fetchone()
            self.assertEqual(row['note'], 'Considered this event against my plan')
            db.execute('UPDATE members SET revoked=1 WHERE id=?', (self.bob_id,))
        result = self.update(self.alice, self.a_session, a, 'check')
        self.assertFalse(result['proceed'])
        self.assertIn('peer_unavailable', [x['kind'] for x in result['blockers']])
