# Created once by AID Framework "@aid-framework/generator-py-fastapi" v0.1.0. Edit freely.
# The generator never overwrites this file: it is yours. See aid.manifest.json.

"""The `lookup_vehicle` tool. The generator wrote this file once and never rewrites it: fill in the
body, and regenerate freely.
"""

from __future__ import annotations

from ...generated.contracts import ToolContext
from ...generated.contracts.lookup_vehicle import LookupVehicleTool
from ...generated.schemas import VehicleLookup, VehicleRecord


class LookupVehicle(LookupVehicleTool):
    """The business implementation of `lookup_vehicle`."""

    async def __call__(self, ctx: ToolContext, req: VehicleLookup) -> VehicleRecord:
        """The validated arguments are in `req`; `ctx` carries the wire name and the raw arguments
        the model passed.
        """

        raise NotImplementedError(
            "implement lookup_vehicle in tools/lookup_vehicle.py",
        )
