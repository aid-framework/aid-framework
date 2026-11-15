# Created once by AID Framework "@aid-framework/generator-py-fastapi" v0.1.0. Edit freely.
# The generator never overwrites this file: it is yours. See aid.manifest.json.

"""The implementation of every tool the spec declares, keyed by tool id. The generated executor
reads this mapping, so adding a tool means adding it here too.
"""

from __future__ import annotations

from typing import Any

from .issue_credit import IssueCredit
from .lookup_vehicle import LookupVehicle
from .notify_dealer import NotifyDealer
from .open_escalation import OpenEscalation
from .order_part import OrderPart
from .score_risk import ScoreRisk

IMPLEMENTATIONS: dict[str, Any] = {
    "issue_credit": IssueCredit(),
    "lookup_vehicle": LookupVehicle(),
    "notify_dealer": NotifyDealer(),
    "open_escalation": OpenEscalation(),
    "order_part": OrderPart(),
    "score_risk": ScoreRisk(),
}
