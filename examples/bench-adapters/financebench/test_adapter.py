"""Synthetic human-review fixtures, not new human judgments or model evaluation."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import adapter
import runtime


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.req = {"benchmark": {"path": str(self.root), "config": {"variant": "oracle-context", "image": "python:fixture"}},
                    "trial": {"task": "a", "staging": str(self.root / "stage"), "method": {"agent": "codex"}}}
        fixture = {"financebench_id": "a", "question": "Question", "question_type": "metrics-generated",
                   "evidence": [{"evidence_text": "Evidence"}], "answer": "Secret reference", "doc_name": "doc"}
        for target,value in [("rows", [fixture]), ("labels", [{"answer": "Human reviewed", "score": 1, "provenance": "fixture"}])]:
            mock=patch.object(adapter,target,return_value=value);mock.start();self.addCleanup(mock.stop)

    def test_reference_and_reviews_hidden(self):
        adapter.solve(self.req)
        text = (self.root / "stage/solve/task.json").read_text()
        self.assertIn("Evidence",text)
        self.assertNotIn("Human reviewed",text)
        self.assertNotIn("Secret reference",text)
        self.assertEqual(len(adapter.tasks(self.req)["tasks"]),1)

    def test_new_answer_requires_exact_human_review(self):
        src=self.root/'input';src.mkdir();out=self.root/'output';out.mkdir();solve=self.root/'solve';solve.mkdir()
        item=adapter.problem(self.req)
        (src/'task.json').write_text(json.dumps(item))
        for answer,expected in [('Human reviewed',1),('Human reviewed changed',None),('',0)]:
            (solve/'answers.json').write_text(json.dumps({'0':answer}))
            runtime.run('verify',src,solve,out)
            result=json.loads((out/'result.json').read_text())
            self.assertEqual(result.get('score'),expected)
        item['reviews']=[{'answerSha256':hashlib.sha256(b'New').hexdigest(),'score':0,'provenance':'human:fixture'}]
        (src/'task.json').write_text(json.dumps(item));(solve/'answers.json').write_text('{"0":"New"}')
        runtime.run('verify',src,solve,out)
        self.assertEqual(json.loads((out/'result.json').read_text())['score'],0)

    def test_conflicting_judgments_are_invalid(self):
        src=self.root/'input';src.mkdir();out=self.root/'output';out.mkdir();solve=self.root/'solve';solve.mkdir()
        item=adapter.problem(self.req);item['reviews'].append({'answer':'Human reviewed','score':0,'provenance':'conflict'})
        (src/'task.json').write_text(json.dumps(item));(solve/'answers.json').write_text('{"0":"Human reviewed"}')
        runtime.run('verify',src,solve,out)
        self.assertEqual(json.loads((out/'result.json').read_text())['failure'],'judge_unavailable')


if __name__=='__main__':unittest.main()
