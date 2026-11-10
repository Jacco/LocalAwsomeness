"""What the Lambda Python runtime does around a handler, for functions run by the simulator (src/app/api/lambda/invoke.ts).

Runs inside the network shim (src/app/api/runtime/netshim.py) as its script. Copies the code of the function (the files in
JPK_CODE_DIR) to the task root, calls the handler with the event.json of the working directory and a context object, and
writes outcome.json (the response is not written to standard output, so the function's own output stays the log). The
Lambda service adds the START, END and REPORT lines and the timeout.
"""
import importlib
import json
import logging
import os
import shutil
import sys
import time
import traceback

REQUEST_ID = os.environ["JPK_REQUEST_ID"]
TIMEOUT_MS = int(os.environ['JPK_TIMEOUT_MS'])
ROOT = os.path.join(os.getcwd(), 'task')
os.environ['LAMBDA_TASK_ROOT'] = ROOT
START = time.monotonic()


class LambdaContext:
    def __init__(self):
        self.aws_request_id = REQUEST_ID
        self.function_name = os.environ['AWS_LAMBDA_FUNCTION_NAME']
        self.function_version = os.environ['AWS_LAMBDA_FUNCTION_VERSION']
        self.invoked_function_arn = os.environ['JPK_FUNCTION_ARN']
        self.memory_limit_in_mb = os.environ['AWS_LAMBDA_FUNCTION_MEMORY_SIZE']
        self.log_group_name = os.environ['AWS_LAMBDA_LOG_GROUP_NAME']
        self.log_stream_name = os.environ['AWS_LAMBDA_LOG_STREAM_NAME']
        self.identity = None
        self.client_context = None

    # The virtual clock of the shim counts: sleeping and waiting for a connect timeout use up the time left.
    def get_remaining_time_in_millis(self):
        return max(0, int(TIMEOUT_MS - (time.monotonic() - START) * 1000))


def configure_logging():
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter('[%(levelname)s]\t%(asctime)s.%(msecs)dZ\t%(aws_request_id)s\t%(message)s\n', '%Y-%m-%dT%H:%M:%S'))
    factory = logging.getLogRecordFactory()

    def record_factory(*args, **kwargs):
        record = factory(*args, **kwargs)
        record.aws_request_id = REQUEST_ID
        return record

    logging.setLogRecordFactory(record_factory)
    logging.getLogger().addHandler(handler)


def failure(error_type, message, exc=None):
    body = {'errorMessage': message, 'errorType': error_type}
    if exc is not None:
        body['requestId'] = REQUEST_ID
        body['stackTrace'] = traceback.format_exception(exc)[1:]
    return body


def finish(payload=None, error=None):
    with open('outcome.json', 'w') as handle:
        json.dump({'payload': payload, 'error': error, 'durationSeconds': time.monotonic() - START}, handle)


def main():
    module_name, _, function_name = os.environ['_HANDLER'].rpartition('.')
    code_dir = os.environ['JPK_CODE_DIR']
    if not os.path.isdir(code_dir):
        return finish(error=failure('Runtime.ImportModuleError', f"Unable to import module '{module_name}': the code of the function is missing ({code_dir})"))
    # the function gets its own copy of the code, so what it writes next to it never changes the stored code
    shutil.copytree(code_dir, ROOT)
    sys.path.insert(0, ROOT)
    configure_logging()
    try:
        module = importlib.import_module(module_name)
    except ImportError as exc:
        return finish(error=failure('Runtime.ImportModuleError', f"Unable to import module '{module_name}': {exc}"))
    except Exception as exc:
        return finish(error=failure(type(exc).__name__, str(exc), exc))
    handler = getattr(module, function_name, None)
    if handler is None:
        return finish(error=failure('Runtime.HandlerNotFound', f"Handler '{function_name}' missing on module '{module_name}'"))
    with open('event.json') as handle:
        event = json.load(handle)
    try:
        result = handler(event, LambdaContext())
    except Exception as exc:
        return finish(error=failure(type(exc).__name__, str(exc), exc))
    try:
        payload = json.dumps(result)
    except (TypeError, ValueError) as exc:
        return finish(error=failure('Runtime.MarshalError', f'Unable to marshal response: {exc}'))
    return finish(payload=payload)


main()
