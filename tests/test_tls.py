"""Trust selection regressions: never retry with disabled TLS verification."""
import ssl
import unittest
from unittest.mock import Mock, patch
from urllib.error import URLError

from relay.client import Client, HubUnavailable, NoRedirect, tls_context


class TLSClientTests(unittest.TestCase):
    def test_windows_loads_only_server_auth_root_anchors(self):
        entries = [(b'root', 'x509_asn', True),
                   (b'server', 'x509_asn', {ssl.Purpose.SERVER_AUTH.oid}),
                   (b'client', 'x509_asn', {ssl.Purpose.CLIENT_AUTH.oid}),
                   (b'container', 'pkcs_7_asn', True)]
        context = Mock()
        with patch('relay.client.os.name', 'nt'), \
             patch('relay.client.ssl.enum_certificates', return_value=entries, create=True) as enum, \
             patch('relay.client.ssl.DER_cert_to_PEM_cert', side_effect=lambda b: b.decode()) as pem, \
             patch('relay.client.ssl.create_default_context', return_value=context) as create:
            self.assertIs(tls_context(), context)
        enum.assert_called_once_with('ROOT')
        self.assertEqual(pem.call_count, 2)
        create.assert_called_once_with(cadata='root\nserver')
        context.set_default_verify_paths.assert_called_once_with()

    def test_missing_windows_roots_fails_closed(self):
        with patch('relay.client.os.name', 'nt'), \
             patch('relay.client.ssl.enum_certificates', return_value=[], create=True), \
             patch('relay.client.ssl.create_default_context') as create:
            with self.assertRaises(ssl.SSLError):
                tls_context()
        create.assert_not_called()

    def test_other_platforms_keep_standard_context(self):
        with patch('relay.client.os.name', 'posix'), \
             patch('relay.client.ssl.create_default_context') as create:
            self.assertIs(tls_context(), create.return_value)
        create.assert_called_once_with()

    def test_context_requires_certificates_and_hostnames(self):
        context = tls_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)

    def test_https_reuses_context_but_keeps_no_redirect_handler(self):
        client = Client('https://example.invalid', '')
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'{"ok":true}'
        with patch('relay.client.tls_context') as context, \
             patch('relay.client.HTTPSHandler') as handler, \
             patch('relay.client.build_opener') as opener:
            opener.return_value.open.return_value = response
            client.request('/health'); client.request('/health')
        context.assert_called_once_with()
        handler.assert_called_once_with(context=context.return_value)
        for call in opener.call_args_list:
            self.assertEqual(call.args, (NoRedirect, handler.return_value))

    def test_certificate_errors_are_actionable_and_never_retried(self):
        for error in (ssl.SSLCertVerificationError('expired'),
                      ssl.SSLCertVerificationError('hostname mismatch')):
            with self.subTest(error=str(error)), \
                 patch('relay.client.tls_context'), patch('relay.client.HTTPSHandler'), \
                 patch('relay.client.build_opener') as opener:
                opener.return_value.open.side_effect = URLError(error)
                with self.assertRaisesRegex(HubUnavailable, 'HTTPS verification failed'):
                    Client('https://example.invalid', '').request('/health')
                self.assertEqual(opener.return_value.open.call_count, 1)
