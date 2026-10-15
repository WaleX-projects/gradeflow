import json
from types import SimpleNamespace

import pytest

from app.services import vision


def test_duplicate_question_grades_fail_before_proposals_are_returned(monkeypatch):
    duplicate = {
        "grades": [
            {
                "question_number": "Q1",
                "score": 4,
                "explanation": "Supported reasoning.",
                "evidence": "The answer gives a relevant fact.",
                "confidence": 0.8,
                "warning": None,
            },
            {
                "question_number": "Q1",
                "score": 5,
                "explanation": "A second proposal.",
                "evidence": "Duplicate question entry.",
                "confidence": 0.9,
                "warning": None,
            },
        ],
        "warnings": [],
    }
    response = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(duplicate)))]
    )
    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(create=lambda **kwargs: response)
        )
    )
    monkeypatch.setattr(vision, "_client", lambda: fake_client)

    with pytest.raises(ValueError, match="duplicate"):
        vision.propose_grades(
            [{"question_number": "Q1", "answer_text": "Answer", "page_number": 1}],
            [{"question_number": "Q1", "max_marks": 10}],
        )
