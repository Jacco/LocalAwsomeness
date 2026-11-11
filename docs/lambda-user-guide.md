# Lambda User Guide: Writing Code for the Simulator

This guide explains what code works in the simulator and what doesn't.

## Network Model: Everything Goes Through boto3

The simulator intercepts **HTTP library calls**, not socket-level operations. This means:

### ✅ Code That Works

```python
# Using boto3 (recommended)
import boto3
sts = boto3.client('sts')
identity = sts.get_caller_identity()
print(f"Running as: {identity['Arn']}")

# Using requests library
import requests
response = requests.get('https://httpbin.org/status/200')

# Using urllib
from urllib.request import urlopen
response = urlopen('https://example.com')
```

All of these use `http.client` or `urllib3` under the hood, which the netshim intercepts and routes through the network model.

### ❌ Code That Does NOT Work

```python
# ❌ Direct DNS resolution (socket-level)
import socket
ip = socket.gethostbyname('sts.eu-west-1.amazonaws.com')
print(ip)  # This uses the real system resolver, not the simulator

# ❌ Manual socket connections to resolved addresses
import socket
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.connect(('sts.eu-west-1.amazonaws.com', 443))  # Tries the real network

# ❌ Other low-level network operations
import socket
socket.gethostbyaddr('203.0.113.1')  # Real DNS
socket.getaddrinfo('example.com', 443)  # Real DNS resolution
```

These calls bypass the HTTP libraries and go straight to the OS socket layer. The simulator's network shim cannot intercept them, so they attempt to use the real system resolver.

### Why This Limitation Exists

The simulator uses a **network shim** (`netshim.py`) that:
1. Intercepts the `connect()` method of `http.client` and `urllib3` connections.
2. Asks the network model: "Can this connection happen from where I'm running?"
3. If yes, routes to the simulator (`localhost:3000`).
4. If no, raises a connection timeout (like a dropped packet).

The shim does **not** intercept system-level DNS queries, because those are outside the HTTP library boundary and would require process-wide state or OS-level hooks.

## Lambda Environment Variables

The following environment variables are set automatically by the simulator:

| Variable | Example | Notes |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | `AKIA...` | Temporary credentials of the execution role |
| `AWS_SECRET_ACCESS_KEY` | `...` | Temporary secret |
| `AWS_SESSION_TOKEN` | `...` | Session token for the execution role |
| `AWS_REGION` | `eu-west-1` | Region from the request |
| `AWS_DEFAULT_REGION` | `eu-west-1` | Same as `AWS_REGION` |
| `AWS_LAMBDA_FUNCTION_NAME` | `orders-fn` | Function name |
| `AWS_LAMBDA_FUNCTION_VERSION` | `$LATEST` | Always `$LATEST` |
| `AWS_LAMBDA_FUNCTION_MEMORY_SIZE` | `128` | From function configuration |
| `AWS_LAMBDA_LOG_GROUP_NAME` | `/aws/lambda/orders-fn` | CloudWatch Logs group |
| `AWS_LAMBDA_LOG_STREAM_NAME` | `2026/11/10/[$LATEST]0341cc...` | Log stream name |
| `AWS_EXECUTION_ENV` | `AWS_Lambda_python3.11` | Runtime environment |
| `LAMBDA_TASK_ROOT` | `/path/to/function` | Function code directory |
| `_HANDLER` | `index.handler` | Handler function |

## Logging

Lambda captures `print()` statements and logs to CloudWatch Logs automatically. For example:

```python
def handler(event, context):
    print(f"Event: {event}")
    print(f"Context: {context}")
    return {'statusCode': 200, 'body': 'OK'}
```

The output will appear in CloudWatch Logs at `/aws/lambda/<function-name>`.

**Important:** The execution role must have `logs:CreateLogGroup`, `logs:CreateLogStream`, and `logs:PutLogEvents` permissions. Without them, the log is silently not written (just as in AWS). You can check the invocation record to see why the log was not written.

## Permissions and Error Handling

The simulator enforces IAM permissions just like AWS. If your code tries to call an AWS API and the execution role doesn't have permission:

```python
import boto3

ec2 = boto3.client('ec2')
try:
    response = ec2.describe_vpcs()
except botocore.exceptions.ClientError as e:
    print(f"Error: {e.response['Error']['Code']}")  # 'UnauthorizedOperation'
    print(f"Message: {e.response['Error']['Message']}")
```

## Virtual Time

The simulator includes a **virtual clock** that advances when code sleeps or waits for network timeouts. This means:

```python
import time

# This completes instantly (virtual time, not real time)
start = time.time()
time.sleep(10)
end = time.time()
print(f"Slept for {end - start} seconds")  # Prints: 10.0

# Retries with backoff work instantly too
import boto3
from botocore.exceptions import ConnectionError

sts = boto3.client('sts')
# boto3 retries automatically with backoff; the virtual clock advances
response = sts.get_caller_identity()
```

This is useful for testing retry logic without waiting in real time.

## Network Traces

Every connection the code makes is recorded with a **trace** that explains why it succeeded or failed:

```
connection 1: https://sts.eu-west-1.amazonaws.com:443 (at 0.0 s)
  name: sts.eu-west-1.amazonaws.com
  port: 443
  outcome: reached
  context:
    path: vpc-nat
    sourceIp: 203.0.113.42
    sourceVpc: vpc-12345678
```

The trace includes:
- Whether the connection was allowed or denied.
- The route taken (direct, through NAT, through VPC endpoint, etc.).
- The security group and network ACL decisions.
- The source IP and VPC context.

This is helpful for debugging network connectivity issues.

## Common Errors

### "simulated: not modelled: ..."

This means the code tried to reach something the simulator doesn't model yet. For example:
- A VPC peering connection (not yet implemented).
- A Transit Gateway route (not yet implemented).
- IPv6 (not supported).

The connection is refused as if the packet was dropped.

### ConnectTimeoutError

This usually means a route doesn't exist or a security group blocks the traffic. Check the trace for the specific reason.

### UnauthorizedOperation

The execution role doesn't have permission. Check the invocation record or the function's role in IAM.

## Future Improvements

The following limitations are known and will be fixed:

- **DNS queries:** Currently, socket-level DNS resolution is not intercepted. A DNS server will be added later to support code that does manual DNS resolution or uses languages other than Python.
- **CloudTrail:** API calls are not logged for audit purposes yet. A simple audit log will be added.

## Questions?

See the simulator's documentation in `docs/` for more details on the network model, Lambda configuration, and architecture.
