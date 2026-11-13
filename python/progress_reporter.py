"""Progress events as JSON lines on stdout, one event per line, read by the Node.js deploy route.

Anything that is not an event (logging, tracebacks) must go to stderr so stdout stays parseable.
"""
import json
import sys
import time
from typing import Any, Optional, TextIO

from cf_types import Stage


class ProgressReporter:
    def __init__(self, stream: Optional[TextIO] = None):
        self.stream = stream or sys.stdout
        self.started = time.monotonic()
        self._stage_started: dict[str, float] = {}

    def report(self, stage: Stage, message: Optional[str] = None, **fields: Any) -> dict[str, Any]:
        event: dict[str, Any] = {'stage': stage.value, 'timestamp': time.time()}
        if message is not None:
            event['message'] = message
        event.update({k: v for k, v in fields.items() if v is not None})
        self.stream.write(json.dumps(event, default=str) + '\n')
        self.stream.flush()
        return event

    def begin(self, stage: Stage, message: Optional[str] = None, **fields: Any) -> dict[str, Any]:
        self._stage_started[stage.value] = time.monotonic()
        return self.report(stage, message, **fields)

    def complete(self, stage: Stage, begun: Stage, message: Optional[str] = None, **fields: Any) -> dict[str, Any]:
        """Report `stage` with the duration since `begin(begun)`."""
        start = self._stage_started.pop(begun.value, None)
        duration = round(time.monotonic() - start, 3) if start is not None else None
        return self.report(stage, message, duration=duration, **fields)

    def resource(self, stage: Stage, logical_id: str, status: str, **fields: Any) -> dict[str, Any]:
        return self.report(stage, resource=logical_id, status=status, **fields)

    def success(self, message: str, **fields: Any) -> dict[str, Any]:
        return self.report(Stage.SUCCESS, message, totalDuration=self.total_duration(), **fields)

    def error(self, message: str, **fields: Any) -> dict[str, Any]:
        return self.report(Stage.ERROR, message, totalDuration=self.total_duration(), **fields)

    def total_duration(self) -> float:
        return round(time.monotonic() - self.started, 3)
