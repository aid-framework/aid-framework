# Created once by AID Framework "@aid-framework/generator-py-fastapi" v0.1.0. Edit freely.
# The generator never overwrites this file: it is yours. See aid.manifest.json.

"""The `notify_dealer` tool. The generator wrote this file once and never rewrites it: fill in the
body, and regenerate freely.
"""

from __future__ import annotations

from ...generated.contracts import ToolContext
from ...generated.contracts.notify_dealer import NotifyDealerTool
from ...generated.schemas import NoticeReceipt, NoticeRequest


class NotifyDealer(NotifyDealerTool):
    """The business implementation of `notify_dealer`."""

    async def __call__(self, ctx: ToolContext, req: NoticeRequest) -> NoticeReceipt:
        """The validated arguments are in `req`; `ctx` carries the wire name and the raw arguments
        the model passed.
        """

        raise NotImplementedError(
            "implement notify_dealer in tools/notify_dealer.py",
        )
