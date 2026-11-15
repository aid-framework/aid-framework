"""Tests for `aid_runtime.identity`.

The verifier is the check that turns `identity` in the spec from a reference into an
enforced control, so the tests are aimed at the ways that check can be wrong rather than at
the happy path: a token from the wrong audience, a token whose signature does not cover its
claims, an algorithm the verifier must never accept no matter what the token says, and the
key cache behaving under rotation without becoming an amplification vector.

Keys are generated per test and tokens are signed for real, so a verifier that skipped the
signature would fail here rather than in a deployment.
"""

from __future__ import annotations

import json

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.asymmetric.ec import EllipticCurvePrivateKey
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey

from aid_runtime.identity import (
    OIDC_ALGORITHMS,
    JwksVerifier,
    TokenRefusedError,
    bearer_token,
)

# The private-key shapes the fixtures sign with. Naming the union rather than `object`
# keeps mypy strict on what PyJWT will actually accept, so a fixture cannot drift into
# passing a key type the runtime would reject.
SigningKey = RSAPrivateKey | EllipticCurvePrivateKey

ISSUER = "https://login.example.com"
AUDIENCE = "aid-claims"
JWKS_URI = "https://login.example.com/.well-known/jwks.json"
KID = "key-1"


def _rsa_pair() -> tuple[SigningKey, dict[str, object]]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    jwk["kid"] = KID
    jwk["use"] = "sig"
    assert public  # the PEM form is what an app hands to PyJWT; the JWK is what JWKS holds
    return key, jwk


def _ec_pair() -> tuple[SigningKey, dict[str, object]]:
    key = ec.generate_private_key(ec.SECP256R1())
    jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(key.public_key()))
    jwk["kid"] = KID
    jwk["use"] = "sig"
    return key, jwk


class Clock:
    """A monotonic clock the test moves, so cache behaviour needs no sleeping."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class Jwks:
    """A JWKS endpoint that counts fetches and can be rotated mid-test."""

    def __init__(self, *keys: dict[str, object]) -> None:
        self.keys = list(keys)
        self.fetches = 0

    def rotate(self, key: dict[str, object]) -> None:
        self.keys = [key]

    async def __call__(self, url: str) -> object:
        assert url == JWKS_URI
        self.fetches += 1
        return {"keys": list(self.keys)}


def _verifier(clock: Clock, jwks: Jwks, **kwargs: object) -> JwksVerifier:
    return JwksVerifier(
        issuer=ISSUER,
        audience=AUDIENCE,
        jwks_uri=JWKS_URI,
        fetch=jwks,
        clock=clock,
        **kwargs,  # type: ignore[arg-type]
    )


def _claims(**overrides: object) -> dict[str, object]:
    claims: dict[str, object] = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "sub": "user-42",
        # 2100-01-01. A fixed far-future epoch keeps the fixture independent of the
        # wall clock; `leeway` is judged against real time, not the fake cache clock.
        "exp": 4102444800,
        "roles": ["approver", "reader"],
        "scp": "claims.write claims.read",
    }
    claims.update(overrides)
    return claims


# -- the happy path ----------------------------------------------------------------


async def test_rs256_token_becomes_an_authenticated_principal() -> None:
    key, jwk = _rsa_pair()
    verifier = _verifier(Clock(), Jwks(jwk))
    token = jwt.encode(_claims(), key, algorithm="RS256", headers={"kid": KID})

    principal = await verifier.principal(token)

    assert principal.authenticated is True
    assert principal.subject == "user-42"
    assert principal.roles == frozenset({"approver", "reader"})
    assert principal.scopes == frozenset({"claims.write", "claims.read"})


async def test_es256_token_verifies_through_the_elliptic_curve_path() -> None:
    key, jwk = _ec_pair()
    verifier = _verifier(Clock(), Jwks(jwk))
    token = jwt.encode(_claims(), key, algorithm="ES256", headers={"kid": KID})

    principal = await verifier.principal(token)

    assert principal.subject == "user-42"


async def test_claim_names_are_configurable_and_default_to_the_oidc_spelling() -> None:
    key, jwk = _rsa_pair()
    verifier = _verifier(Clock(), Jwks(jwk), subject_claim="oid", roles_claim="group")
    token = jwt.encode(
        _claims(oid="user-7", group=["ops"]), key, algorithm="RS256", headers={"kid": KID}
    )

    principal = await verifier.principal(token)

    assert principal.subject == "user-7"
    assert principal.roles == frozenset({"ops"})
    # `scp` was not renamed, so it is still read under its default name.
    assert principal.scopes == frozenset({"claims.write", "claims.read"})


async def test_principal_is_fail_closed_when_a_deployment_verifies_nothing() -> None:
    # The default the generated route must keep when the spec declares no identity: a
    # verifier existing must not make an unauthenticated caller look authenticated.
    from aid_runtime.agents.policy import Principal

    anonymous = Principal.unauthenticated()

    assert anonymous.authenticated is False
    assert anonymous.subject is None


# -- claims that must be refused ---------------------------------------------------


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"aud": "some-other-service"}, "InvalidAudienceError"),
        ({"iss": "https://evil.example.com"}, "InvalidIssuerError"),
        ({"exp": 1}, "ExpiredSignatureError"),
    ],
    ids=["wrong-audience", "wrong-issuer", "expired"],
)
async def test_a_claim_mismatch_is_refused(overrides: dict[str, object], reason: str) -> None:
    key, jwk = _rsa_pair()
    verifier = _verifier(Clock(), Jwks(jwk))
    token = jwt.encode(_claims(**overrides), key, algorithm="RS256", headers={"kid": KID})

    with pytest.raises(TokenRefusedError) as refused:
        await verifier.principal(token)

    assert refused.value.reason == reason


@pytest.mark.parametrize("claim", ["exp", "iss", "aud", "sub"])
async def test_a_required_claim_that_is_absent_is_refused(claim: str) -> None:
    key, jwk = _rsa_pair()
    verifier = _verifier(Clock(), Jwks(jwk))
    claims = _claims()
    del claims[claim]
    token = jwt.encode(claims, key, algorithm="RS256", headers={"kid": KID})

    with pytest.raises(TokenRefusedError):
        await verifier.principal(token)


async def test_a_subject_that_is_not_a_string_is_refused() -> None:
    key, jwk = _rsa_pair()
    verifier = _verifier(Clock(), Jwks(jwk))
    token = jwt.encode(_claims(sub=42), key, algorithm="RS256", headers={"kid": KID})

    with pytest.raises(TokenRefusedError):
        await verifier.principal(token)


async def test_a_tampered_payload_does_not_verify() -> None:
    key, jwk = _rsa_pair()
    verifier = _verifier(Clock(), Jwks(jwk))
    token = jwt.encode(_claims(), key, algorithm="RS256", headers={"kid": KID})
    header, _, signature = token.split(".")
    forged_payload = jwt.utils.base64url_encode(
        json.dumps(_claims(sub="admin")).encode("utf-8")
    ).decode("utf-8")

    with pytest.raises(TokenRefusedError) as refused:
        await verifier.principal(f"{header}.{forged_payload}.{signature}")

    assert refused.value.reason == "InvalidSignatureError"


# -- algorithms --------------------------------------------------------------------


async def test_an_unsigned_token_is_refused() -> None:
    _key, jwk = _rsa_pair()
    verifier = _verifier(Clock(), Jwks(jwk))
    token = jwt.encode(
        _claims(),
        key=None,  # type: ignore[arg-type]  # `alg: none` carries no key, which is the point
        algorithm="none",
        headers={"kid": KID},
    )

    with pytest.raises(TokenRefusedError) as refused:
        await verifier.principal(token)

    assert "not accepted" in refused.value.reason


async def test_a_symmetric_token_cannot_borrow_the_public_key() -> None:
    # The key-confusion attack: sign HS256 using the JWKS public key as the shared secret.
    # The verifier rejects the algorithm before it looks at any key, so there is no path
    # by which a public value can be used as a secret. The token is assembled by hand
    # because PyJWT refuses to *encode* HS256 with a DER-shaped secret -- which is the
    # same defence, applied at the other end.
    import hashlib
    import hmac

    _key, jwk = _rsa_pair()
    verifier = _verifier(Clock(), Jwks(jwk))
    # The secret an attacker would use: a value the server publishes anyway.
    secret = json.dumps(jwk).encode("utf-8")

    def _segment(raw: bytes) -> str:
        return jwt.utils.base64url_encode(raw).decode("utf-8")

    header = _segment(b'{"alg":"HS256","kid":"key-1","typ":"JWT"}')
    payload = _segment(json.dumps(_claims()).encode("utf-8"))
    signing_input = f"{header}.{payload}".encode()
    signature = hmac.new(secret, signing_input, hashlib.sha256).digest()
    token = f"{header}.{payload}.{_segment(signature)}"

    # The token is a genuine HS256 token: its signature checks out against the published
    # key material. Only the algorithm allow-list stands between it and an accepted
    # principal, which is why the allow-list is an exact membership test and not a hint.
    assert hmac.compare_digest(signature, hmac.new(secret, signing_input, hashlib.sha256).digest())

    with pytest.raises(TokenRefusedError) as refused:
        await verifier.principal(token)

    assert "not accepted" in refused.value.reason


def test_construction_refuses_an_algorithm_outside_the_asymmetric_families() -> None:
    with pytest.raises(ValueError, match="refusing to accept"):
        JwksVerifier(
            issuer=ISSUER,
            audience=AUDIENCE,
            jwks_uri=JWKS_URI,
            algorithms=("HS256",),
        )


def test_construction_refuses_an_empty_algorithm_set() -> None:
    with pytest.raises(ValueError, match="no algorithm"):
        JwksVerifier(issuer=ISSUER, audience=AUDIENCE, jwks_uri=JWKS_URI, algorithms=())


def test_the_accepted_families_contain_no_symmetric_or_none_member() -> None:
    assert "none" not in OIDC_ALGORITHMS
    assert not [algorithm for algorithm in OIDC_ALGORITHMS if algorithm.startswith("HS")]


# -- key cache ---------------------------------------------------------------------


async def test_keys_are_fetched_once_and_reused_within_the_ttl() -> None:
    key, jwk = _rsa_pair()
    clock = Clock()
    jwks = Jwks(jwk)
    verifier = _verifier(clock, jwks)
    token = jwt.encode(_claims(), key, algorithm="RS256", headers={"kid": KID})

    await verifier.principal(token)
    await verifier.principal(token)
    clock.advance(10)

    await verifier.principal(token)

    assert jwks.fetches == 1


async def test_the_cache_expires_and_the_document_is_refetched() -> None:
    key, jwk = _rsa_pair()
    clock = Clock()
    jwks = Jwks(jwk)
    verifier = _verifier(clock, jwks)
    token = jwt.encode(_claims(), key, algorithm="RS256", headers={"kid": KID})

    await verifier.principal(token)
    clock.advance(301)
    await verifier.principal(token)

    assert jwks.fetches == 2


async def test_an_unknown_key_is_refused_without_hammering_the_identity_provider() -> None:
    key, jwk = _rsa_pair()
    clock = Clock()
    jwks = Jwks(jwk)
    verifier = _verifier(clock, jwks)
    await verifier.principal(jwt.encode(_claims(), key, algorithm="RS256", headers={"kid": KID}))
    assert jwks.fetches == 1

    # A token naming a key the cache does not hold: a rotation, or a probe. Straight after
    # a fetch it is neither -- the key was not there a moment ago -- so no refetch is made.
    other_key, _ = _rsa_pair()
    stranger = jwt.encode(_claims(), other_key, algorithm="RS256", headers={"kid": "nope"})
    with pytest.raises(TokenRefusedError):
        await verifier.principal(stranger)
    assert jwks.fetches == 1

    # Past the cooldown a rotation is given one chance to appear...
    clock.advance(60)
    with pytest.raises(TokenRefusedError):
        await verifier.principal(stranger)
    assert jwks.fetches == 2

    # ...and then the rate limit holds, so repeated unknown `kid` values cannot drive
    # fetches at the identity provider.
    clock.advance(1)
    with pytest.raises(TokenRefusedError):
        await verifier.principal(stranger)
    assert jwks.fetches == 2


async def test_a_rotated_key_is_accepted_after_the_cooldown() -> None:
    first_key, first_jwk = _rsa_pair()
    clock = Clock()
    jwks = Jwks(first_jwk)
    verifier = _verifier(clock, jwks)
    await verifier.principal(
        jwt.encode(_claims(), first_key, algorithm="RS256", headers={"kid": KID})
    )

    rotated_key, rotated_jwk = _rsa_pair()
    rotated_jwk["kid"] = "key-2"
    jwks.rotate(rotated_jwk)
    clock.advance(60)

    principal = await verifier.principal(
        jwt.encode(_claims(), rotated_key, algorithm="RS256", headers={"kid": "key-2"})
    )

    assert principal.subject == "user-42"


async def test_a_key_marked_for_encryption_is_not_used_to_accept_tokens() -> None:
    key, jwk = _rsa_pair()
    encryption_jwk = {**jwk, "use": "enc"}
    verifier = _verifier(Clock(), Jwks(encryption_jwk))
    token = jwt.encode(_claims(), key, algorithm="RS256", headers={"kid": KID})

    with pytest.raises(TokenRefusedError):
        await verifier.principal(token)


async def test_a_token_may_omit_kid_when_the_document_holds_one_key() -> None:
    key, jwk = _rsa_pair()
    verifier = _verifier(Clock(), Jwks(jwk))
    token = jwt.encode(_claims(), key, algorithm="RS256")

    assert (await verifier.principal(token)).subject == "user-42"


async def test_a_malformed_document_is_refused_rather_than_cached_empty() -> None:
    class Broken:
        async def __call__(self, url: str) -> object:
            return {"no-keys": []}

    verifier = JwksVerifier(
        issuer=ISSUER, audience=AUDIENCE, jwks_uri=JWKS_URI, fetch=Broken(), clock=Clock()
    )
    key, _ = _rsa_pair()

    with pytest.raises(TokenRefusedError):
        await verifier.principal(
            jwt.encode(_claims(), key, algorithm="RS256", headers={"kid": KID})
        )


# -- the Authorization header ------------------------------------------------------


def test_a_bearer_header_yields_its_credential() -> None:
    assert bearer_token("Bearer abc.def.ghi") == "abc.def.ghi"
    assert bearer_token("bearer abc.def.ghi") == "abc.def.ghi"
    assert bearer_token("BEARER   abc.def.ghi  ") == "abc.def.ghi"


@pytest.mark.parametrize(
    "header",
    [None, "", "Basic dXNlcjpwdw==", "Bearer", "Bearer   "],
    ids=["absent", "empty", "wrong-scheme", "no-credential", "blank-credential"],
)
def test_any_other_authorization_shape_is_refused(header: str | None) -> None:
    with pytest.raises(TokenRefusedError):
        bearer_token(header)


async def test_a_missing_header_never_becomes_an_anonymous_principal() -> None:
    # A deployment that declared an identity provider must not answer a header-less
    # request with the weaker caller `Principal.unauthenticated()` describes.
    _key, jwk = _rsa_pair()
    verifier = _verifier(Clock(), Jwks(jwk))

    with pytest.raises(TokenRefusedError):
        await verifier.principal_from_authorization(None)
