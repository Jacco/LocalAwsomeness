"""Clients for the local AWS simulator.

Every request goes through the SigV4 check in src/proxy.ts, so this wraps boto3 (which signs) rather than raw HTTP.
"""
import os
from typing import Any, Optional

import boto3
from botocore import xform_name
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

DEFAULT_ENDPOINT = 'http://localhost:3000'


class ApiError(Exception):
    def __init__(self, service: str, operation: str, code: str, message: str):
        super().__init__(f'{service}:{operation} failed: {code}: {message}')
        self.service = service
        self.operation = operation
        self.code = code
        self.message = message


class ApiClient:
    def __init__(
        self,
        region: str,
        endpoint_url: Optional[str] = None,
        credentials: Optional[dict[str, str]] = None,
    ):
        self.region = region
        self.endpoint_url = endpoint_url or os.environ.get('AWS_ENDPOINT_URL') or DEFAULT_ENDPOINT
        if credentials:
            self.session = boto3.Session(
                aws_access_key_id=credentials['accessKeyId'],
                aws_secret_access_key=credentials['secretAccessKey'],
                aws_session_token=credentials.get('sessionToken'),
                region_name=region,
            )
        else:
            self.session = boto3.Session(region_name=region)
        # The simulator answers immediately or not at all: fail fast instead of boto3's default retries.
        self._config = Config(retries={'max_attempts': 2, 'mode': 'standard'}, connect_timeout=5, read_timeout=30)
        self._clients: dict[str, Any] = {}

    def client(self, service: str) -> Any:
        if service not in self._clients:
            self._clients[service] = self.session.client(
                service, endpoint_url=self.endpoint_url, region_name=self.region, config=self._config
            )
        return self._clients[service]

    def call(self, service: str, operation: str, **params: Any) -> dict[str, Any]:
        """Invoke a boto3 operation by its API name (e.g. 'GetParameter'), normalizing errors to ApiError."""
        client = self.client(service)
        method = getattr(client, xform_name(operation))
        try:
            return method(**params)
        except ClientError as e:
            error = e.response.get('Error', {})
            raise ApiError(service, operation, error.get('Code', 'Unknown'), error.get('Message', str(e))) from e
        except BotoCoreError as e:
            raise ApiError(service, operation, type(e).__name__, str(e)) from e

    def caller_identity(self) -> dict[str, Any]:
        return self.call('sts', 'GetCallerIdentity')

