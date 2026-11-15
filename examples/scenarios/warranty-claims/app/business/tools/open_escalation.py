# Created once by AID Framework "@aid-framework/generator-py-fastapi" v0.1.0. Edit freely.
# The generator never overwrites this file: it is yours. See aid.manifest.json.

"""The `open_escalation` tool. The generator wrote this file once and never rewrites it: fill in the
body, and regenerate freely.
"""

from __future__ import annotations

from ...generated.contracts import ToolContext
from ...generated.contracts.open_escalation import OpenEscalationTool
from ...generated.schemas import EscalationRequest, EscalationTicket


class OpenEscalation(OpenEscalationTool):
    """The business implementation of `open_escalation`."""

    async def __call__(self, ctx: ToolContext, req: EscalationRequest) -> EscalationTicket:
        """The validated arguments are in `req`; `ctx` carries the wire name and the raw arguments
        the model passed.
        """

        raise NotImplementedError(
            "implement open_escalation in tools/open_escalation.py",
        )
