# Created once by AID Framework "@aid/generator-py-fastapi" v0.1.0. Edit freely.
# The generator never overwrites this file: it is yours. See aid.manifest.json.

"""The `issue_refund` tool. The generator wrote this file once and never rewrites it: fill in the
body, and regenerate freely.
"""

from __future__ import annotations

from ...generated.contracts import ToolContext
from ...generated.contracts.issue_refund import IssueRefundTool
from ...generated.schemas import Refund, RefundReceipt


class IssueRefund(IssueRefundTool):
    """The business implementation of `issue_refund`.

    Idempotent on `subject`: the agent prompt asks for at most one refund per ticket, and the
    ledger here is what makes a second attempt a no-op rather than a second payout.
    """

    def __init__(self) -> None:
        self._refunds: dict[str, RefundReceipt] = {}

    async def __call__(self, ctx: ToolContext, req: Refund) -> RefundReceipt:
        """The validated arguments are in `req`; `ctx` carries the wire name and the raw arguments
        the model passed.
        """

        existing = self._refunds.get(req.subject)
        if existing is not None:
            return existing
        receipt = RefundReceipt(refund_id=f"re_{len(self._refunds) + 1:06d}", status="issued")
        self._refunds[req.subject] = receipt
        return receipt
