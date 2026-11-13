"""Who the caller is, for the one `auth` policy this example declares.

This file is hand-written and yours: `aid gen` does not create it, overwrite it, or delete
it, and `aid eject` leaves it where it is. It sits beside `main.py` rather than under
`app/business/` because that tree mirrors what the spec declares -- a module per tool, per
prompt -- and token verification corresponds to no declaration. AID generates **no** token
verification at all: the signing keys belong to the customer's identity provider, so the
check that turns a token into a `Principal` is application code.

In a real deployment this function fetches the issuer's JWKS, verifies the signature, checks
`iss`, `aud` and expiry against the `identity:` block of the deployment, and maps the role and
scope claims onto the `Principal`. That is the component `deployments.<id>.identity.verifiedBy`
names, and `profile: enterprise` refuses a document that does not name one from spec 0.33.

Here it reads a subject header and believes it, because this is a demo with no identity
provider. That is the whole difference, and it is why the generated default is
`Principal.unauthenticated()` rather than something that looks verified.
"""

from __future__ import annotations

from aid_runtime import Principal
from fastapi import Request

#: The header this demo trusts. A real app trusts a signature, not a header.
SUBJECT_HEADER = "x-demo-subject"


def current_principal(request: Request) -> Principal:
    """The caller, as this demo app identifies them: present header means authenticated.

    Returns `Principal.unauthenticated()` when the header is absent, which is what makes a
    tool whose policy is `isAuthenticated()` refuse the call rather than admitting the
    caller -- the same answer the generated default gives, arrived at deliberately.
    """

    subject = request.headers.get(SUBJECT_HEADER, "").strip()
    if not subject:
        return Principal.unauthenticated()
    return Principal(
        roles=frozenset({"support"}),
        scopes=frozenset({"tickets:write"}),
        authenticated=True,
    )
