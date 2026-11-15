# Created once by AID Framework "@aid-framework/generator-py-fastapi" v0.1.0. Edit freely.
# The generator never overwrites this file: it is yours. See aid.manifest.json.

"""The `issue_credit` tool. The generator wrote this file once and never rewrites it: fill in the
body, and regenerate freely.
"""

from __future__ import annotations

from ...generated.contracts import ToolContext
from ...generated.contracts.issue_credit import IssueCreditTool
from ...generated.schemas import CreditReceipt, CreditRequest


class IssueCredit(IssueCreditTool):
    """The business implementation of `issue_credit`."""

    async def __call__(self, ctx: ToolContext, req: CreditRequest) -> CreditReceipt:
        """The validated arguments are in `req`; `ctx` carries the wire name and the raw arguments
        the model passed.
        """

        raise NotImplementedError(
            "implement issue_credit in tools/issue_credit.py",
        )
