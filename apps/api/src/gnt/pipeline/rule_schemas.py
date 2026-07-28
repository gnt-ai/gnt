from typing import Literal

from pydantic import BaseModel


class RuleMergeVerdict(BaseModel):
    relation: Literal["duplicate", "refines", "contradicts", "distinct"]
    explanation: str
