import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from relay.adapters import CodexRPC, CodexRequestError
from relay.managed_providers import CodexWorking, TurnEndedBeforeDelivery


class TurnTransitionTests(unittest.TestCase):
    def agent(self):
        agent = CodexWorking.__new__(CodexWorking)
        agent.source_id, agent.turn, agent.closed = 'owned-thread', 'old-turn', False
        agent.rpc = SimpleNamespace(owned_turn='old-turn', backlog=[],
            receive=Mock(side_effect=TimeoutError), request=Mock(), close=Mock())
        return agent

    def completed(self, turn='old-turn', thread='owned-thread'):
        return {'method': 'turn/completed', 'params': {'threadId': thread, 'turn': {'id': turn, 'status': 'completed'}}}

    def test_explicit_rpc_rejection_is_distinct_from_transport_error(self):
        rpc = CodexRPC.__new__(CodexRPC)
        rpc.next_id = 0
        rpc.send = Mock()
        rpc.receive = Mock(return_value={'id': 1, 'error': {'code': -32600, 'message': 'no active turn to steer'}})
        with self.assertRaises(CodexRequestError) as caught:
            rpc.request('turn/steer', {})
        self.assertEqual(caught.exception.method, 'turn/steer')
        self.assertEqual(caught.exception.message, 'no active turn to steer')

    def test_completion_is_drained_behind_deltas_before_next_offer(self):
        agent = self.agent()
        agent.rpc.backlog = [{'method': 'item/agentMessage/delta', 'params': {'threadId': 'owned-thread'}}] * 40
        agent.rpc.backlog += [self.completed()]
        self.assertEqual(agent.poll(), [{'completed': True}])
        self.assertFalse(agent.busy)
        agent.rpc.request.return_value = {'turn': {'id': 'new-turn'}}
        self.assertEqual(agent.offer('peer update', 'receipt'), ['receipt'])
        self.assertEqual(agent.rpc.request.call_args.args[0], 'turn/start')

    def test_rejected_steer_clears_stale_turn_without_delivering(self):
        agent = self.agent()
        agent.rpc.request.side_effect = CodexRequestError('turn/steer', {'message': 'no active turn to steer'})
        with self.assertRaises(TurnEndedBeforeDelivery):
            agent.offer('peer update', 'receipt')
        self.assertFalse(agent.busy)
        self.assertIsNone(agent.rpc.owned_turn)
        agent.rpc.request.assert_called_once()
        agent.rpc.close.assert_not_called()

    def test_unknown_or_ambiguous_failure_never_triggers_new_turn(self):
        for error in [TimeoutError('uncertain delivery'), OSError('pipe lost'),
                      ValueError('Codex: no active turn to steer'),
                      CodexRequestError('turn/steer', {'message': 'expected turn ID mismatch'})]:
            with self.subTest(error=str(error)):
                agent = self.agent()
                agent.rpc.request.side_effect = error
                with self.assertRaises(type(error)) as caught:
                    agent.offer('peer update', 'receipt')
                self.assertNotIsInstance(caught.exception, TurnEndedBeforeDelivery)
                agent.rpc.request.assert_called_once()
                self.assertEqual(agent.turn, 'old-turn')

    def test_late_completion_cannot_clear_new_turn_or_its_guard(self):
        agent = self.agent()
        agent.turn = agent.rpc.owned_turn = 'new-turn'
        agent.rpc.backlog = [self.completed(), self.completed('new-turn', 'another-thread')]
        self.assertEqual(agent.poll(), [])
        self.assertEqual(agent.turn, 'new-turn')
        self.assertEqual(agent.rpc.owned_turn, 'new-turn')

    def test_pause_after_completion_does_not_kill_healthy_provider(self):
        agent = self.agent()
        agent.rpc.request.side_effect = CodexRequestError('turn/interrupt', {'message': 'no active turn to interrupt'})
        agent.interrupt()
        self.assertFalse(agent.busy)
        self.assertIsNone(agent.rpc.owned_turn)
        agent.rpc.close.assert_not_called()

    def test_closed_provider_cannot_claim_resume_is_available(self):
        agent = self.agent()
        agent.close()
        with self.assertRaisesRegex(ValueError, 'Use /quit'):
            agent.ensure_available()
        agent.rpc.request.assert_not_called()
