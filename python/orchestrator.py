"""Deploys a parsed template against the previous state of the stack, the way CloudFormation does.

CREATE/UPDATE: resources go in dependency order. A new resource is created; an existing one is updated, which compares
the *resolved* properties, so a resource whose Ref points at a replaced resource is updated too. Ref and Fn::GetAtt
resolve from the resources processed so far. After everything succeeded, replaced resources and resources removed
from the template are deleted (cleanup), newest first; DeletionPolicy Retain leaves them in place. When a resource
fails, what this run did is undone in reverse order (rollback), unless rollback is disabled.

DELETE: every resource is deleted in reverse deployment order.
"""
from dataclasses import dataclass
from typing import Any, Callable, Optional

from api_client import ApiClient
from cf_parser import CloudFormationTemplate
from cf_types import ResourceState, Stage, TemplateError
from progress_reporter import ProgressReporter
from reconcilers import Reconciler, ResourceError
from reconcilers.ssm import SsmParameterReconciler

RECONCILERS: dict[str, Callable[[ApiClient, str], Reconciler]] = {
    'AWS::SSM::Parameter': SsmParameterReconciler,
}


class DeploymentFailed(Exception):
    def __init__(self, message: str, stack_status: str, resources: dict[str, ResourceState]):
        super().__init__(message)
        self.stack_status = stack_status
        self.resources = resources


@dataclass
class _Done:
    """One step of this run, kept to undo it on rollback."""
    action: str  # 'create' | 'update' | 'replace'
    new: ResourceState
    old: Optional[ResourceState] = None


class Orchestrator:
    def __init__(self, api: ApiClient, reporter: ProgressReporter, stack_name: str, disable_rollback: bool = False,
                 reconcilers: Optional[dict[str, Callable[[ApiClient, str], Reconciler]]] = None):
        self.api = api
        self.reporter = reporter
        self.stack_name = stack_name
        self.disable_rollback = disable_rollback
        self._factories = reconcilers or RECONCILERS
        self._reconcilers: dict[str, Reconciler] = {}

    def reconciler(self, resource_type: str) -> Reconciler:
        if resource_type not in self._reconcilers:
            if resource_type not in self._factories:
                raise TemplateError(f'Resource type {resource_type} is not supported by the deployment engine yet '
                                    f'(supported: {", ".join(self._factories)})')
            self._reconcilers[resource_type] = self._factories[resource_type](self.api, self.stack_name)
        return self._reconcilers[resource_type]

    # ---- CREATE / UPDATE ----------------------------------------------------------------------------------------

    def deploy(self, template: CloudFormationTemplate, previous: dict[str, ResourceState],
               operation: str = 'CREATE') -> dict[str, ResourceState]:
        resources = [template.resources[logical_id] for logical_id in template.order]
        for resource in resources:
            self.reconciler(resource.type)
        removed = [state for logical_id, state in previous.items() if logical_id not in template.resources]
        self.reporter.report(Stage.COMPARE, f'{len(resources)} resources in the template, {len(previous)} deployed',
                             add=[r.logical_id for r in resources if r.logical_id not in previous] or None,
                             existing=[r.logical_id for r in resources if r.logical_id in previous] or None,
                             remove=[s.logical_id for s in removed] or None)

        current: dict[str, ResourceState] = {}
        done: list[_Done] = []
        cleanup: list[ResourceState] = []

        def get_attribute(logical_id: str, attribute: str) -> Any:
            state = current.get(logical_id)
            if state is None:
                raise TemplateError(f'Resource {logical_id} is referenced before it was deployed')
            if attribute not in state.attributes:
                raise TemplateError(f'Template error: resource {logical_id} does not support attribute type '
                                    f'{attribute} in Fn::GetAtt')
            return state.attributes[attribute]

        self.reporter.begin(Stage.EXECUTE, 'Creating and updating resources...')
        for resource in resources:
            logical_id, reconciler = resource.logical_id, self.reconciler(resource.type)
            old = previous.get(logical_id)
            verb = 'UPDATE' if old else 'CREATE'
            try:
                properties = template.resolve_properties(logical_id, get_attribute)
                if old and old.type == resource.type:
                    change = reconciler.diff(old.properties, properties)
                    if change.action == 'None':
                        current[logical_id] = ResourceState(logical_id, old.type, old.physical_id, old.properties,
                                                            old.attributes, resource.deletion_policy)
                        self._event(Stage.EXECUTE, current[logical_id], 'UPDATE_COMPLETE', reason='No changes')
                        continue
                    self._event(Stage.EXECUTE, old, 'UPDATE_IN_PROGRESS', properties=change.properties,
                                requiresReplacement=change.action == 'Replace')
                    update = reconciler.update(logical_id, old.physical_id, old.properties, properties)
                    new = self._state(resource, update.result, properties)
                    if update.replaced:
                        done.append(_Done('replace', new, old))
                        cleanup.append(old)
                    else:
                        done.append(_Done('update', new, old))
                else:
                    if old:  # the type changed: a new resource replaces the old one
                        cleanup.append(old)
                        verb = 'CREATE'
                    self._event(Stage.EXECUTE, None, 'CREATE_IN_PROGRESS', logical_id=logical_id, resource_type=resource.type)
                    new = self._state(resource, reconciler.create(logical_id, properties), properties)
                    done.append(_Done('create', new))
                current[logical_id] = new
                self._event(Stage.EXECUTE, new, f'{verb}_COMPLETE')
            except (ResourceError, TemplateError) as e:
                self._event(Stage.EXECUTE, old, f'{verb}_FAILED', logical_id=logical_id, resource_type=resource.type,
                            reason=str(e))
                failed_status = 'CREATE_FAILED' if operation == 'CREATE' else 'UPDATE_FAILED'
                if self.disable_rollback:
                    self.reporter.complete(Stage.EXECUTE_COMPLETE, Stage.EXECUTE, 'Rollback is disabled')
                    raise DeploymentFailed(f'{logical_id}: {e}', failed_status, {**previous, **current}) from e
                self.reporter.complete(Stage.EXECUTE_COMPLETE, Stage.EXECUTE, f'{logical_id} failed, rolling back')
                rolled_back = self._rollback(done)
                status = ('ROLLBACK_COMPLETE' if operation == 'CREATE' else 'UPDATE_ROLLBACK_COMPLETE') if rolled_back \
                    else ('ROLLBACK_FAILED' if operation == 'CREATE' else 'UPDATE_ROLLBACK_FAILED')
                raise DeploymentFailed(f'{logical_id}: {e}', status, {} if operation == 'CREATE' else previous) from e
        self.reporter.complete(Stage.EXECUTE_COMPLETE, Stage.EXECUTE, f'{len(resources)} resources deployed')

        self._cleanup(cleanup + list(reversed(removed)))
        return current

    def _rollback(self, done: list[_Done]) -> bool:
        self.reporter.begin(Stage.ROLLBACK, f'Undoing {len(done)} changes...')
        ok = True
        for step in reversed(done):
            reconciler = self.reconciler(step.new.type)
            try:
                if step.action in ('create', 'replace'):
                    self._event(Stage.ROLLBACK, step.new, 'DELETE_IN_PROGRESS')
                    reconciler.delete(step.new.physical_id, step.new.properties)
                    self._event(Stage.ROLLBACK, step.new, 'DELETE_COMPLETE')
                else:
                    self._event(Stage.ROLLBACK, step.old, 'UPDATE_IN_PROGRESS')
                    reconciler.update(step.new.logical_id, step.new.physical_id, step.new.properties, step.old.properties)
                    self._event(Stage.ROLLBACK, step.old, 'UPDATE_COMPLETE')
            except ResourceError as e:
                ok = False
                self._event(Stage.ROLLBACK, step.new, 'DELETE_FAILED' if step.action != 'update' else 'UPDATE_FAILED',
                            reason=str(e))
        self.reporter.complete(Stage.ROLLBACK_COMPLETE, Stage.ROLLBACK, 'Rollback complete' if ok else 'Rollback failed')
        return ok

    def _cleanup(self, states: list[ResourceState]) -> None:
        if not states:
            return
        self.reporter.begin(Stage.CLEANUP, f'Deleting {len(states)} replaced or removed resources...')
        for state in states:
            self._delete(Stage.CLEANUP, state)  # a failed cleanup does not fail the deployment, as in CloudFormation
        self.reporter.complete(Stage.CLEANUP_COMPLETE, Stage.CLEANUP)

    # ---- DELETE -------------------------------------------------------------------------------------------------

    def delete(self, previous: dict[str, ResourceState]) -> dict[str, ResourceState]:
        """Deletes the stack's resources; returns those that could not be deleted."""
        for state in previous.values():
            self.reconciler(state.type)
        self.reporter.begin(Stage.EXECUTE, f'Deleting {len(previous)} resources...')
        remaining = {s.logical_id: s for s in reversed(list(previous.values())) if not self._delete(Stage.EXECUTE, s)}
        self.reporter.complete(Stage.EXECUTE_COMPLETE, Stage.EXECUTE)
        if remaining:
            raise DeploymentFailed(f'Failed to delete resources: {", ".join(remaining)}', 'DELETE_FAILED', remaining)
        return remaining

    def _delete(self, stage: Stage, state: ResourceState) -> bool:
        if state.deletion_policy == 'Retain':
            self._event(stage, state, 'DELETE_SKIPPED', reason='DeletionPolicy is Retain')
            return True
        self._event(stage, state, 'DELETE_IN_PROGRESS')
        try:
            self.reconciler(state.type).delete(state.physical_id, state.properties)
        except ResourceError as e:
            self._event(stage, state, 'DELETE_FAILED', reason=str(e))
            return False
        self._event(stage, state, 'DELETE_COMPLETE')
        return True

    # ---- helpers ------------------------------------------------------------------------------------------------

    @staticmethod
    def _state(resource, result, properties) -> ResourceState:
        return ResourceState(resource.logical_id, resource.type, result.physical_id, properties, result.attributes,
                             resource.deletion_policy)

    def _event(self, stage: Stage, state: Optional[ResourceState], status: str, logical_id: Optional[str] = None,
               resource_type: Optional[str] = None, **fields: Any) -> None:
        self.reporter.resource(stage, logical_id or state.logical_id, status,
                               resourceType=resource_type or state.type,
                               physicalId=state.physical_id if state else None, **fields)
