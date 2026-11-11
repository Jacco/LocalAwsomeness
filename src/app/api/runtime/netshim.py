"""The network shim: runs a Python script as if it were somewhere in the simulated network.

    python3 netshim.py script.py

Started by run.ts (see "Step 3b as built" in docs/walking-skeleton.md), never by hand. Before the script starts it
  - replaces the connect of http.client and urllib3 connections (so urllib, requests, urllib3 and botocore are covered):
    the shim asks the runner whether the connection works from where the script runs; if so the connection is made to
    the simulator instead (plain TCP, the Host header stays the original name), if not it fails the way a dropped packet
    does (a connect timeout);
  - refuses every other IP connection, because it cannot see where it would go (reported as "not modelled");
  - replaces time.sleep, time.time and time.monotonic by a virtual clock, so retries and back-off take no real time; when
    JPK_DEADLINE is set (a Lambda timeout) the code is stopped as soon as the virtual clock passes it.

The runner and the shim talk over file descriptor 3, one JSON object per line. The runner derives where the script runs
from its own state, never from anything the script sends.
"""
import errno
import http.client
import json
import os
import runpy
import socket
import sys
import time
import traceback

try:
    import urllib3.connection as _urllib3_connection
except ImportError:
    _urllib3_connection = None

SIMULATOR = (os.environ['JPK_SIM_HOST'], int(os.environ['JPK_SIM_PORT']))
# What a connect waits for when the code sets no timeout of its own.
DEFAULT_CONNECT_TIMEOUT = 60.0

_real_time = time.time
_real_monotonic = time.monotonic
_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex
_real_stdout_write = sys.stdout.write
_real_stderr_write = sys.stderr.write
_offset = 0.0
_deadline = float(os.environ['JPK_DEADLINE']) if 'JPK_DEADLINE' in os.environ else None
_delivering = False
_channel = None
_log_messages = []
_vpc_id = os.environ.get('JPK_VPC_ID')
_subnet_id = os.environ.get('JPK_SUBNET_ID')


def _advance(seconds):
    """Moves the virtual clock; past the deadline (a Lambda timeout) the code is stopped there, as AWS stops it."""
    global _offset
    _offset += seconds
    if _deadline is not None and _offset > _deadline:
        _offset = _deadline
        _send({'op': 'deadline'})
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(124)


def _sleep(seconds):
    if seconds and seconds > 0:
        _advance(seconds)


def _open_channel():
    global _channel
    if _channel is None:
        _channel = socket.socket(fileno=3).makefile('rw', buffering=1, encoding='utf-8')
    return _channel


def _send(message):
    message['at'] = _offset
    channel = _open_channel()
    channel.write(json.dumps(message) + '\n')
    channel.flush()


def _ask(message):
    try:
        _send(message)
        line = _open_channel().readline()
        if not line:
            # EOF reached - runner crashed or closed connection
            sys.stderr.write(f"netshim: EOF from runner while asking about {message.get('op', '?')}\n")
            sys.stderr.flush()
            sys.exit(1)
        return json.loads(line)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"netshim: malformed response from runner: {e}\n")
        sys.stderr.flush()
        sys.exit(1)
    except Exception as e:
        sys.stderr.write(f"netshim: error communicating with runner: {type(e).__name__}: {e}\n")
        sys.stderr.flush()
        sys.exit(1)


def _connect(self):
    """Replaces HTTPConnection.connect and HTTPSConnection.connect."""
    global _delivering
    timeout = self.timeout if isinstance(self.timeout, (int, float)) and self.timeout > 0 else None
    message = {
        'op': 'connect',
        'host': self.host,
        'port': self.port,
        'scheme': 'https' if 'HTTPS' in type(self).__name__ else 'http',
    }
    # Include VPC endpoint context if Lambda runs in a VPC
    if _vpc_id and _subnet_id:
        # Determine service name from host
        service_name = None
        if 'logs.' in self.host and 'amazonaws.com' in self.host:
            # Extract region from host like "logs.us-east-1.amazonaws.com"
            parts = self.host.split('.')
            if len(parts) >= 3:
                region = parts[1]
                service_name = f"com.amazonaws.{region}.logs"
        elif 's3' in self.host and 'amazonaws.com' in self.host:
            parts = self.host.split('.')
            if len(parts) >= 3:
                region = parts[1] if 's3.' in self.host else 'us-east-1'
                service_name = f"com.amazonaws.{region}.s3"
        elif 'dynamodb' in self.host and 'amazonaws.com' in self.host:
            parts = self.host.split('.')
            if len(parts) >= 3:
                region = parts[1]
                service_name = f"com.amazonaws.{region}.dynamodb"
        
        if service_name:
            message['vpcEndpointRequest'] = {
                'serviceName': service_name,
                'vpcId': _vpc_id,
                'subnetId': _subnet_id,
            }
    
    try:
        answer = _ask(message)
    except SystemExit:
        raise
    except Exception as e:
        sys.stderr.write(f"netshim: error asking runner about connect to {self.host}:{self.port}: {type(e).__name__}: {e}\n")
        sys.stderr.flush()
        raise OSError(errno.ENETUNREACH, f"internal error: {e}")
    
    if answer['verdict'] == 'allow':
        _delivering = True
        try:
            self.sock = socket.create_connection(SIMULATOR, timeout=timeout or 30)
        finally:
            _delivering = False
        if hasattr(self, 'is_verified'):
            # TLS is not modelled; without this urllib3 warns about an unverified HTTPS request, which real code never sees
            self.is_verified = True
        return
    message = f"simulated: {answer['message']}"
    if answer['verdict'] == 'unknown':
        raise OSError(errno.ENETUNREACH, message)
    # a dropped packet (verdict='deny') gets no answer: the code waits for its connect timeout
    # Use the caller's timeout if specified, otherwise use a short simulated timeout (not the default 60s)
    effective_timeout = timeout if timeout and timeout > 0 else 1.0
    _advance(effective_timeout)
    if _urllib3_connection is not None and isinstance(self, _urllib3_connection.HTTPConnection):
        raise _urllib3_connection.ConnectTimeoutError(self, message)
    raise socket.timeout(message)


def _refuse(address):
    host, port = address[0], address[1]
    _send({'op': 'unmodelled', 'host': str(host), 'port': port})
    return OSError(errno.ENETUNREACH, f'simulated: the code opened a connection to {host}:{port} that the shim cannot see; not modelled')


def _guarded_connect(self, address):
    if _delivering or self.family not in (socket.AF_INET, socket.AF_INET6):
        return _real_connect(self, address)
    raise _refuse(address)


def _guarded_connect_ex(self, address):
    if _delivering or self.family not in (socket.AF_INET, socket.AF_INET6):
        return _real_connect_ex(self, address)
    return _refuse(address).errno


def _write_stdout(message: str) -> int:
    """Intercepts sys.stdout.write() to capture log messages."""
    global _log_messages
    _log_messages.append(('stdout', message))
    return _real_stdout_write(message)


def _write_stderr(message: str) -> int:
    """Intercepts sys.stderr.write() to capture log messages."""
    global _log_messages
    _log_messages.append(('stderr', message))
    return _real_stderr_write(message)


def install():
    time.sleep = _sleep
    time.time = lambda: _real_time() + _offset
    time.monotonic = lambda: _real_monotonic() + _offset
    http.client.HTTPConnection.connect = _connect
    http.client.HTTPSConnection.connect = _connect
    if _urllib3_connection is not None:
        _urllib3_connection.HTTPConnection.connect = _connect
        _urllib3_connection.HTTPSConnection.connect = _connect
    socket.socket.connect = _guarded_connect
    socket.socket.connect_ex = _guarded_connect_ex
    sys.stdout.write = _write_stdout
    sys.stderr.write = _write_stderr


def main():
    script = sys.argv[1]
    sys.argv = sys.argv[1:]
    sys.path.insert(0, os.path.dirname(os.path.abspath(script)))
    _open_channel()
    install()
    code = 0
    try:
        runpy.run_path(script, run_name='__main__')
    except SystemExit as exit_:
        if isinstance(exit_.code, int):
            code = exit_.code
        elif exit_.code is not None:
            print(exit_.code, file=sys.stderr)
            code = 1
    except BaseException:
        traceback.print_exc()
        code = 1
    sys.stdout.flush()
    sys.stderr.flush()
    if _log_messages:
        _send({'op': 'log_write', 'messages': _log_messages})
    _send({'op': 'done', 'exitCode': code})
    os._exit(code)


if __name__ == '__main__':
    main()
