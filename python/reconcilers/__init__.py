"""Per-resource-type reconcilers: how one CloudFormation resource type is created, updated and deleted.

Changes are decided like CloudFormation does: from the previous and the new template properties, not by inspecting the
live resource. A replacement creates the new resource first and returns the old physical id, so the orchestrator can
delete it in the cleanup phase after the rest of the stack has been updated.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from api_client import ApiClient, ApiError


class ResourceError(Exception):
    """A resource operation failed; the message is what CloudFormation shows as the resource's status reason."""


@dataclass
class ResourceResult:
    physical_id: str
    # Values for Ref (key 'Ref') and Fn::GetAtt of the resource.
    attributes: dict[str, Any] = field(default_factory=dict)


@dataclass
class Change:
    action: Literal['None', 'Modify', 'Replace']
    # Properties whose value changed; for Replace, which ones require it.
    properties: list[str] = field(default_factory=list)


@dataclass
class UpdateResult:
    result: ResourceResult
    # The physical id of the replaced resource, to delete during cleanup; None for an in-place update.
    replaced: Optional[str] = None


class Reconciler(ABC):
    resource_type: str
    # Properties whose change makes CloudFormation replace the resource.
    replacement_properties: frozenset[str] = frozenset()

    def __init__(self, api: ApiClient, stack_name: str):
        self.api = api
        self.stack_name = stack_name

    @abstractmethod
    def create(self, logical_id: str, properties: dict[str, Any]) -> ResourceResult: ...

    @abstractmethod
    def update(self, logical_id: str, physical_id: str, old: dict[str, Any], new: dict[str, Any]) -> UpdateResult: ...

    @abstractmethod
    def delete(self, physical_id: str, properties: dict[str, Any]) -> None: ...

    def diff(self, old: dict[str, Any], new: dict[str, Any]) -> Change:
        changed = sorted(k for k in set(old) | set(new) if old.get(k) != new.get(k))
        if not changed:
            return Change('None')
        replacing = [k for k in changed if k in self.replacement_properties]
        return Change('Replace', replacing) if replacing else Change('Modify', changed)

    def call(self, service: str, operation: str, **params: Any) -> dict[str, Any]:
        """An API call whose failure becomes a ResourceError carrying the service's message."""
        try:
            return self.api.call(service, operation, **params)
        except ApiError as e:
            raise ResourceError(handler_message(e)) from e


def handler_message(e: ApiError) -> str:
    return (f'Resource handler returned message: "{e.message}" (Service: {e.service}, Operation: {e.operation}, '
            f'Error Code: {e.code})')
