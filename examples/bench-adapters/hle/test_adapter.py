"""Explicit fixtures for HLE isolation and policy enforcement; no model is mocked as real."""
import asyncio
import hashlib
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import adapter
from filtering import Blocked, Policy, public_addresses
from gateway import Gateway
import runtime

RULES = {'domains': ['answers.example'], 'url_prefixes': ['papers.example/restricted'],
         'serp_url_patterns': [r'^bing\.com/search'], 'url_patterns': [r'cais/hle'],
         'patterns_case_sensitive': [r'\bHLE\b.*answer'],
         'answer_title_patterns': [r'quiz answers$'], 'answer_title_allow_hosts': ['trusted.example']}


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = Policy(RULES, 'This deliberately synthetic question contains eight consecutive unique tokens for testing.')

    def test_domains_and_nested_encoded_archive_urls(self):
        for url in ['https://sub.answers.example/page',
                    'https://archive.example/?url=https%253A%252F%252Fanswers.example%252Fitem',
                    'https://archive.example/web/2026/bing.com/search?q=x',
                    'https://archive.example/?url=https%3A%2F%2Fpapers.example%2Frestricted%2Fpage']:
            with self.subTest(url=url), self.assertRaises(Blocked):
                self.policy.url(url)
        self.policy.url('https://notanswers.example/page')

    def test_query_content_and_question_copy_filter(self):
        for value in ['site:sub.answers.example chemistry', 'cais/hle answers',
                      'This deliberately synthetic question contains eight consecutive unique tokens', 'HLE answer']:
            with self.subTest(value=value), self.assertRaises(Blocked): self.policy.query(value)
        self.policy.query('chemistry hydrogen spectrum')

    def test_title_exemptions_do_not_bypass_other_filters(self):
        with self.assertRaises(Blocked):
            self.policy.result('https://ordinary.example/a', 'Quiz answers | Site', '')
        self.policy.result('https://trusted.example/a', 'Quiz answers | Site', '')
        with self.assertRaises(Blocked):
            self.policy.result('https://trusted.example/a', 'Quiz answers', 'cais/hle')

    def test_nonpublic_dns_and_schemes(self):
        for url in ['file:///etc/passwd', 'http://user:password@example.com', 'https://example.com:9000/']:
            with self.assertRaises(Blocked): self.policy.url(url)
        addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 80))]
        with patch('filtering.socket.getaddrinfo', return_value=addresses), self.assertRaises(Blocked):
            public_addresses('http://public-looking.example/')

    def test_cached_fetch_is_rechecked_before_truncation(self):
        gateway = Gateway.__new__(Gateway)
        gateway.policy = self.policy
        gateway.cache = {'https://ordinary.example/': {'url': 'https://ordinary.example/',
                         'title': '', 'markdown': 'a' * 65000 + ' cais/hle'}}
        with self.assertRaises(Blocked): gateway.fetch('https://ordinary.example/')
        gateway.cache['https://ordinary.example/']['markdown'] = 'a' * 65000
        result = gateway.fetch('https://ordinary.example/')
        self.assertEqual(len(result['markdown']), 60000)
        self.assertTrue(result['truncated'])

    def test_fetch_title_uses_content_rules_not_search_only_rules(self):
        gateway = Gateway.__new__(Gateway)
        gateway.policy = self.policy
        gateway.cache = {'https://ordinary.example/': {'url': 'https://ordinary.example/',
                         'title': 'Quiz answers | Site', 'markdown': 'No keyword in body'}}
        self.assertEqual(gateway.fetch('https://ordinary.example/')['title'], 'Quiz answers | Site')
        gateway.cache['https://ordinary.example/']['title'] = 'cais/hle'
        with self.assertRaises(Blocked): gateway.fetch('https://ordinary.example/')

    def test_unknown_policy_fields_fail_closed(self):
        with self.assertRaises(ValueError): Policy({**RULES, 'new_rules': []}, '')


class JudgeTransportTests(unittest.TestCase):
    def test_json_mode_keeps_prompt_and_validates_schema(self):
        captured = {}
        async def create(**kwargs):
            captured.update(kwargs)
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{}'))])
        class Schema:
            @staticmethod
            def model_json_schema(): return {'required': ['correct', 'strict']}
            @staticmethod
            def model_validate_json(value): raise ValueError('Explicit malformed judge fixture')
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        parse = runtime.json_object_transport(client)
        with self.assertRaisesRegex(ValueError, 'malformed judge'):
            asyncio.run(parse(response_format=Schema, messages=[{'role': 'user', 'content': 'original prompt'}], model='fixture'))
        self.assertEqual(captured['messages'][1], {'role': 'user', 'content': 'original prompt'})
        self.assertEqual(captured['response_format'], {'type': 'json_object'})
        self.assertIn('strict', captured['messages'][0]['content'])


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.patch = patch.object(adapter, 'PINS', {})
        self.patch.start()
        self.addCleanup(self.patch.stop)
        folder = self.root / 'questions/fixture'
        adapter.write(folder / 'question.json', {'id': 'fixture', 'question': 'Explicit fixture: compute 2+2.', 'image': None})
        adapter.write(self.root / 'answers.json', {'fixture': {'id': 'fixture', 'question': 'Explicit fixture: compute 2+2.', 'answer': '4'}})
        catalog = {'revision': adapter.DATASET_REVISION, 'parquetSha256': adapter.PARQUET_SHA256,
                   'answersSha256': adapter.sha(self.root / 'answers.json'), 'tasks': [{
                   'id': 'fixture', 'title': 'Explicit synthetic fixture', 'category': 'math', 'image': False,
                   'files': {'question.json': adapter.sha(folder / 'question.json')}}]}
        adapter.write(self.root / 'catalog.json', catalog)
        cfg = {'image': 'sha256:' + 'a' * 64, 'gatewayImage': 'sha256:' + 'b' * 64,
               'source': str(self.root), 'catalogSha256': adapter.sha(self.root / 'catalog.json'),
               'judgeKeyFile': str(self.root / 'private-key'), 'judgeBaseUrl': 'https://judge.example/v1',
               'judgeModel': 'judge-fixture', 'modelBaseUrl': 'https://model.example'}
        self.req = {'benchmark': {'config': cfg, 'path': str(self.root)},
                    'trial': {'task': 'fixture', 'staging': str(self.root / 'staging'),
                              'method': {'agent': 'claude-code', 'model': 'model-fixture', 'auth': 'relay-fixture'}},
                    'solve': {'output': str(self.root / 'solve-output')},
                    'verify': {'output': str(self.root / 'verify-output')}}

    def test_solver_has_no_answers_credentials_or_network(self):
        spec = adapter.plan(self.req, 'solve')['spec']
        self.assertFalse(spec['network'])
        self.assertEqual(spec['runNetworks'], [])
        plan = json.loads((self.root / 'staging/solve-plan.json').read_text())
        self.assertNotIn('answer', plan)
        self.assertFalse(any('answers.json' in m['source'] or 'private-key' in m['source'] for m in spec['mounts']))
        self.assertEqual(spec['volumeMounts'][0]['mode'], 'ro')
        self.assertEqual(spec['services'][0]['networks'], ['web'])
        self.assertEqual(len(spec['agentTask']['tools']), 1)

    def test_verify_gets_only_its_original_question_and_answer(self):
        spec = adapter.plan(self.req, 'verify')['spec']
        plan = json.loads((self.root / 'staging/verify-plan.json').read_text())
        self.assertEqual(plan['answer'], '4')
        self.assertTrue(any(m['target'] == '/credentials/judge-key' for m in spec['mounts']))
        self.assertNotIn('agentTask', spec)

    def test_mutated_answers_and_assets_are_rejected(self):
        (self.root / 'answers.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'answer index'): adapter.tasks(self.req)

    def test_malformed_submission_is_valid_zero_without_a_judge_call(self):
        plan = {'task': 'fixture', 'catalogSha256': 'fixture', 'judgeModel': 'fixture'}
        with patch.object(Path, 'exists', return_value=True), patch.object(Path, 'read_bytes', return_value=b'{broken'), patch.object(runtime, 'write') as output:
            asyncio.run(runtime.verify(plan, self.root))
        verdict = output.call_args.args[1]
        self.assertFalse(verdict['invalid'])
        self.assertEqual(verdict['judge']['correct'], 'no')
        self.assertIn('response_error', verdict)

    def test_unlisted_or_linked_question_assets_are_rejected(self):
        folder = self.root / 'questions/fixture'
        extra = folder / 'extra-answer.txt'
        extra.write_text('Explicit forbidden fixture')
        with self.assertRaisesRegex(ValueError, 'Unexpected question assets'):
            adapter.plan(self.req, 'solve')
        extra.unlink()
        data = (folder / 'question.json').read_bytes()
        (folder / 'question.json').unlink()
        (self.root / 'same-question.json').write_bytes(data)
        (folder / 'question.json').symlink_to(self.root / 'same-question.json')
        with self.assertRaisesRegex(ValueError, 'Unexpected question assets'):
            adapter.plan(self.req, 'solve')

    def test_native_judge_error_is_invalid(self):
        adapter.write(self.root / 'verify-output/verdict.json', {'invalid': True, 'error': 'Explicit fixture error'})
        self.assertTrue(adapter.score(self.req)['invalid'])

    def test_empty_is_calibration_and_mutated_response_is_invalid(self):
        self.req['trial']['method'] = {'agent': 'empty'}
        self.assertNotIn('services', adapter.plan(self.req, 'solve')['spec'])
        response = self.root / 'solve-output/answer.json'
        adapter.write(response, {'answer': '', 'confidence': 0})
        adapter.write(self.root / 'verify-output/verdict.json', {
            'task': 'fixture', 'catalogSha256': self.req['benchmark']['config']['catalogSha256'],
            'responseSha256': adapter.sha(response), 'judgeModel': 'judge-fixture',
            'judge': {'correct': 'no'}, 'invalid': False})
        self.assertEqual(adapter.score(self.req)['score'], 0)
        response.write_text('{}')
        self.assertTrue(adapter.score(self.req)['invalid'])


if __name__ == '__main__':
    unittest.main()
