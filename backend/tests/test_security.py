import hmac

from app.core.security import hash_password, hash_session_token, new_session_token, verify_password


def test_argon2_password_hash_and_opaque_session_token():
    raw = "a long school password for testing"
    encoded = hash_password(raw)
    assert encoded.startswith("$argon2id$")
    assert verify_password(raw, encoded)
    assert not verify_password("not the same password", encoded)

    token = new_session_token()
    digest = hash_session_token(token)
    assert token not in digest
    assert hmac.compare_digest(digest, hash_session_token(token))
