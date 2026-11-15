# Created once by AID Framework "@aid-framework/generator-py-fastapi" v0.1.0. Edit freely.
# The generator never overwrites this file: it is yours. See aid.manifest.json.

"""The `order_part` tool. The generator wrote this file once and never rewrites it: fill in the
body, and regenerate freely.
"""

from __future__ import annotations

from ...generated.contracts import ToolContext
from ...generated.contracts.order_part import OrderPartTool
from ...generated.schemas import OrderReceipt, PartOrder


class OrderPart(OrderPartTool):
    """The business implementation of `order_part`."""

    async def __call__(self, ctx: ToolContext, req: PartOrder) -> OrderReceipt:
        """The validated arguments are in `req`; `ctx` carries the wire name and the raw arguments
        the model passed.
        """

        raise NotImplementedError(
            "implement order_part in tools/order_part.py",
        )
