# Created once by AID Framework "@aid-framework/generator-py-fastapi" v0.1.0. Edit freely.
# The generator never overwrites this file: it is yours. See aid.manifest.json.

"""The `lookup_customer` tool: resolve the account a ticket came from.

The example stands in for a CRM, so it resolves against a fixed table keyed by
account name. A real implementation would query one; the generated wiring cares
only that the signature is honoured -- a validated `Ticket` in, a `Customer` out,
and any exception failing the pipeline step.
"""

from __future__ import annotations

from ...generated.contracts import ToolContext
from ...generated.contracts.lookup_customer import LookupCustomerTool
from ...generated.schemas import Customer, Ticket

_ACCOUNTS: tuple[tuple[str, Customer], ...] = (
    ("acme", Customer(id="acct_acme", name="Acme Corp", open_tickets=2, plan="enterprise")),
    ("globex", Customer(id="acct_globex", name="Globex", open_tickets=0, plan="pro")),
    ("initech", Customer(id="acct_initech", name="Initech", open_tickets=5, plan="free")),
)
"""The accounts this example knows about, in a fixed order so lookups are deterministic."""

_UNKNOWN = Customer(id="acct_unknown", name="Unknown account", open_tickets=0, plan="free")


class LookupCustomer(LookupCustomerTool):
    """The business implementation of `lookup_customer`."""

    async def __call__(self, ctx: ToolContext, req: Ticket) -> Customer:
        """Match an account name anywhere in the ticket, else return an unknown account.

        `req` is the validated `Ticket` the generated adapter produced; `ctx`
        carries the wire name and the raw arguments the model passed.
        """

        haystack = f"{req.subject}\n{req.body}".lower()
        for account, customer in _ACCOUNTS:
            if account in haystack:
                return customer.model_copy()
        return _UNKNOWN.model_copy()
