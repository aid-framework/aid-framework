# Created once by AID Framework "@aid-framework/generator-py-fastapi" v0.1.0. Edit freely.
# The generator never overwrites this file: it is yours. See aid.manifest.json.

"""The implementation of every tool the spec declares, keyed by tool id. The generated executor
reads this mapping, so adding a tool means adding it here too.
"""

from __future__ import annotations

from typing import Any

from .issue_refund import IssueRefund
from .lookup_customer import LookupCustomer

IMPLEMENTATIONS: dict[str, Any] = {
    "issue_refund": IssueRefund(),
    "lookup_customer": LookupCustomer(),
}
