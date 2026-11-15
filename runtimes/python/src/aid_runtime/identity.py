"""Token verification for a deployment that declares an identity provider.

A deployment's ``identity`` block names an issuer and an audience. Until spec 0.35 that was
a *reference* and nothing more: the generated app seeded :meth:`Principal.unauthenticated`
and the application was expected to override the ``current_principal`` dependency with its
own verifier. That is a correct seam and a poor default -- a spec that declared an identity
provider read as though the generated service trusted it, while the service in fact trusted
everybody.

This module is the check that closes that gap, and it is deliberately narrow:

* **One token type.** A signed JWT. A SAML assertion is XML with a different trust model,
  and the IR gate refuses a deployment that asks for one rather than emitting a verifier
  that will never match it (``ir/identity-kind``).
* **No symmetric algorithm, ever.** :data:`OIDC_ALGORITHMS` holds the asymmetric families
  only, and the token header's ``alg`` is selected from that set by exact match before any
  signature work happens. There is therefore no key-confusion class to get wrong: a public
  key can never be presented as an HMAC secret, and ``alg: none`` is not a member.
* **Nothing is trusted before it is verified.** The header is decoded to find ``kid`` and
  ``alg`` -- both are peer-supplied -- and both are used only to *choose* a key and an
  algorithm from allow-lists. Every claim check the caller depends on (``iss``, ``aud``,
  ``exp``, and the subject claim) is enforced by the signature-covered decode.
* **A refusal says nothing.** :class:`TokenRefusedError` carries a ``reason`` for the log and
  the generated route answers one opaque ``401``, following the checkpoint route's
  discipline: a caller holding a bad token learns that it is bad, not which check failed.

Keys come from the issuer's JWKS document, cached until its TTL expires and re-fetched
early -- rate-limited -- when a token names a ``kid`` the cache does not hold, so a key
rotation does not need a restart and an attacker cannot use unknown ``kid`` values to drive
unbounded fetches at the identity provider.

The verifier is *configuration-complete*: it takes everything it needs at construction and
reads no environment variable. The generated module supplies the values from the spec, which
is what keeps the trust decision reviewable in a diff rather than in a deployment's settings.
"""

from __future__ import annotations

import base64
import binascii
import json
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from aid_runtime.agents.policy import Principal

try:  # pragma: no cover - the import is the one thing an absent extra changes
    import jwt
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "token verification needs PyJWT, which is the `identity` extra: "
        "pip install 'aid-runtime-python[identity]'. The generated verifier names it in "
        "its module docstring too, so the fix is next to the code that needs it."
    ) from exc

__all__ = [
    "DEFAULT_ROLES_CLAIM",
    "DEFAULT_SCOPES_CLAIM",
    "DEFAULT_SUBJECT_CLAIM",
    "OIDC_ALGORITHMS",
    "JwksVerifier",
    "TokenRefusedError",
    "bearer_token",
]

#: The asymmetric JWS families an OIDC provider issues in practice. Deliberately a closed
#: set: selection is by exact membership, so an algorithm outside it is refused before a
#: key is looked up. ``none`` and the ``HS*`` family are absent by design, not by omission.
OIDC_ALGORITHMS: tuple[str, ...] = (
    "RS256",
    "RS384",
    "RS512",
    "PS256",
    "PS384",
    "PS512",
    "ES256",
    "ES384",
    "ES512",
)

DEFAULT_SUBJECT_CLAIM = "sub"
DEFAULT_ROLES_CLAIM = "roles"
#: `scp` is what OIDC providers issue; the OAuth2 spelling `scope` is one space-delimited
#: string, which :func:`_as_claim_set` splits, so both shapes are accepted once named.
DEFAULT_SCOPES_CLAIM = "scp"


class TokenRefusedError(Exception):
    """A token the verifier would not turn into a principal.

    ``reason`` is for the log. It names which check failed in the vocabulary an operator
    debugs in -- and it must not reach the caller, who learns only that the token is not
    acceptable.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _b64url_decode(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def _as_claim_set(value: Any) -> frozenset[str]:
    """A claim as a set of strings, from either shape a provider uses.

    A list is the common OIDC shape for roles. A single space-delimited string is the
    OAuth2 shape for scopes. Anything else contributes nothing rather than raising: a
    claim of the wrong type is a malformed token, and the caller is refused by the checks
    that matter (signature, issuer, audience, expiry) rather than by a ``TypeError`` here.
    """

    if isinstance(value, str):
        return frozenset(part for part in value.split() if part)
    if isinstance(value, Sequence):
        return frozenset(str(part) for part in value if isinstance(part, (str, int)))
    return frozenset()


async def _fetch_json(url: str, timeout_seconds: float) -> Any:
    """The default JWKS fetch. Kept module-level so tests can substitute the seam."""

    import httpx

    async with httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=False) as client:
        response = await client.get(url, headers={"accept": "application/json"})
        response.raise_for_status()
        return response.json()


def bearer_token(authorization: str | None) -> str:
    """The token from an ``Authorization`` header, or a refusal.

    The scheme is compared case-insensitively because RFC 7235 makes it case-insensitive
    and providers do vary it. Every other shape -- no header, a different scheme, an empty
    credential -- is refused rather than treated as anonymous: an anonymous fallback on a
    deployment that declared an identity provider would turn a missing header into a
    weaker caller than the spec asks for.
    """

    if not authorization:
        raise TokenRefusedError("no authorization header")
    scheme, _, credential = authorization.partition(" ")
    if scheme.lower() != "bearer":
        raise TokenRefusedError(f"unsupported authorization scheme {scheme!r}")
    token = credential.strip()
    if not token:
        raise TokenRefusedError("empty bearer credential")
    return token


class JwksVerifier:
    """Verifies a JWKS-signed JWT and projects it onto a runtime :class:`Principal`.

    Construction is the whole trust decision: the issuer, audience, key source, claim
    names and accepted algorithms all arrive as arguments and none of them is read from
    the environment. The generated module is the only caller, and it passes the spec's
    values, so reviewing a diff shows what the service will trust.
    """

    def __init__(
        self,
        *,
        issuer: str,
        audience: str,
        jwks_uri: str,
        subject_claim: str = DEFAULT_SUBJECT_CLAIM,
        roles_claim: str = DEFAULT_ROLES_CLAIM,
        scopes_claim: str = DEFAULT_SCOPES_CLAIM,
        algorithms: Sequence[str] = OIDC_ALGORITHMS,
        cache_ttl_seconds: float = 300.0,
        refresh_cooldown_seconds: float = 30.0,
        leeway_seconds: float = 30.0,
        timeout_seconds: float = 5.0,
        fetch: Callable[[str], Awaitable[Any]] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        accepted = tuple(algorithms)
        outside = [algorithm for algorithm in accepted if algorithm not in OIDC_ALGORITHMS]
        if outside:
            raise ValueError(
                f"refusing to accept {outside!r}: not in the asymmetric families this "
                f"verifier implements ({', '.join(OIDC_ALGORITHMS)})"
            )
        if not accepted:
            raise ValueError("refusing to construct a verifier that accepts no algorithm")
        if leeway_seconds < 0:
            raise ValueError("leeway_seconds must not be negative")
        self._issuer = issuer
        self._audience = audience
        self._jwks_uri = jwks_uri
        self._subject_claim = subject_claim
        self._roles_claim = roles_claim
        self._scopes_claim = scopes_claim
        self._algorithms = accepted
        self._ttl = cache_ttl_seconds
        self._cooldown = refresh_cooldown_seconds
        self._leeway = leeway_seconds
        self._timeout = timeout_seconds
        self._fetch = fetch if fetch is not None else self._default_fetch
        self._clock = clock
        self._keys: dict[str, Any] | None = None
        self._fetched_at = 0.0

    async def _default_fetch(self, url: str) -> Any:
        return await _fetch_json(url, self._timeout)

    # -- keys ---------------------------------------------------------------------

    async def _refresh(self, now: float) -> None:
        document = await self._fetch(self._jwks_uri)
        if not isinstance(document, Mapping):
            raise TokenRefusedError("jwks document is not an object")
        keys = document.get("keys")
        if not isinstance(keys, Sequence) or isinstance(keys, (str, bytes)):
            raise TokenRefusedError("jwks document has no keys array")
        by_kid: dict[str, Any] = {}
        sole: Any = None
        for jwk in keys:
            if not isinstance(jwk, Mapping):
                continue
            # `use` is optional; when present and not `sig` the key is for encryption and
            # must not be used to accept a token.
            if jwk.get("use") not in (None, "sig"):
                continue
            sole = jwk
            kid = jwk.get("kid")
            if isinstance(kid, str) and kid:
                by_kid[kid] = jwk
        if len(by_kid) == 1:
            # A single key needs no `kid` in the token; give it the one key's name so a
            # token that omits `kid` still resolves.
            (only_kid,) = by_kid
            by_kid[""] = by_kid[only_kid]
        elif not by_kid and sole is not None:
            by_kid[""] = sole
        self._keys = by_kid
        self._fetched_at = now

    async def _key_for(self, kid: str | None, algorithm: str) -> Any:
        now = self._clock()
        stale = self._keys is None or (now - self._fetched_at) >= self._ttl
        if stale:
            await self._refresh(now)
        keys = self._keys or {}
        key_id = kid or ""
        if key_id not in keys:
            # A token naming a key we do not hold is either a rotation we have not seen or
            # a probe. Re-fetch at most once per cooldown, so the first cannot need a
            # restart and the second cannot be used to hammer the identity provider.
            if now - self._fetched_at < self._cooldown:
                raise TokenRefusedError(f"unknown key id {key_id!r} (refresh suppressed)")
            await self._refresh(now)
            keys = self._keys or {}
            if key_id not in keys:
                raise TokenRefusedError(f"unknown key id {key_id!r}")
        jwk = dict(keys[key_id])
        try:
            return jwt.PyJWK(jwk, algorithm=algorithm).key
        except jwt.PyJWTError as exc:
            raise TokenRefusedError(f"unusable key {key_id!r}: {type(exc).__name__}") from None

    # -- verification -------------------------------------------------------------

    @staticmethod
    def _header(token: str) -> Mapping[str, Any]:
        """The JOSE header, unverified. Used only to select from allow-lists."""

        segment = token.split(".", 1)[0]
        try:
            raw = _b64url_decode(segment)
            header = json.loads(raw)
        except (binascii.Error, ValueError, UnicodeDecodeError):
            raise TokenRefusedError("malformed token header") from None
        if not isinstance(header, Mapping):
            raise TokenRefusedError("malformed token header")
        return header

    async def principal(self, token: str) -> Principal:
        """The principal a token names, or :class:`TokenRefusedError`."""

        header = self._header(token)
        algorithm = header.get("alg")
        if not isinstance(algorithm, str) or algorithm not in self._algorithms:
            raise TokenRefusedError(f"algorithm {algorithm!r} not accepted")
        kid = header.get("kid")
        if kid is not None and not isinstance(kid, str):
            raise TokenRefusedError("malformed key id")
        key = await self._key_for(kid, algorithm)
        try:
            claims = jwt.decode(
                token,
                key=key,
                algorithms=[algorithm],
                audience=self._audience,
                issuer=self._issuer,
                leeway=self._leeway,
                options={"require": ["exp", "iss", "aud", self._subject_claim]},
            )
        except jwt.InvalidTokenError as exc:
            # The class name is the vocabulary: ExpiredSignatureError, InvalidAudienceError,
            # InvalidIssuerError, InvalidSignatureError, MissingRequiredClaimError.
            raise TokenRefusedError(type(exc).__name__) from None
        subject = claims.get(self._subject_claim)
        if not isinstance(subject, str) or not subject:
            raise TokenRefusedError(f"subject claim {self._subject_claim!r} is not a string")
        return Principal(
            roles=_as_claim_set(claims.get(self._roles_claim)),
            scopes=_as_claim_set(claims.get(self._scopes_claim)),
            authenticated=True,
            subject=subject,
        )

    async def principal_from_authorization(self, authorization: str | None) -> Principal:
        """The principal an ``Authorization`` header names, or :class:`TokenRefusedError`."""

        return await self.principal(bearer_token(authorization))
