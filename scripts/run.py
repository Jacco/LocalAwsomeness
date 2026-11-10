#!/usr/bin/env python3
"""Run a Python script as if it were in a subnet of the simulated network, and show what the network did to it.

    scripts/run.py --subnet skeleton-private --sg skeleton-fn --role orders-fn-role scripts/scenario/call_sts.py

The script runs behind the network shim (src/app/api/runtime/netshim.py): every connection is decided by the network model
from the state of the dev server, and the script gets the credentials of the role like a Lambda function does. Prints the
script's output, then each connection with its trace. Subnets and security groups are given by id or Name tag (see
scripts/reach.py, which takes the same options). The role must trust lambda.amazonaws.com.
Exit status: the script's, or 3 when the request was refused.
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request


def main():
    configured = subprocess.run(['aws', 'configure', 'get', 'region'], capture_output=True, text=True).stdout.strip()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('script', help='the Python script to run')
    parser.add_argument('--eni')
    parser.add_argument('--subnet')
    parser.add_argument('--sg', action='append', default=[])
    parser.add_argument('--ip')
    parser.add_argument('--public-ip')
    parser.add_argument('--role', help='execution role name; without it the script has no credentials')
    parser.add_argument('--session-name', default='run')
    parser.add_argument('--timeout', type=int, default=30, help='wall-clock limit in seconds')
    parser.add_argument('--account', default=os.environ.get('AWS_ACCOUNT_ID'))
    parser.add_argument('--region', default=os.environ.get('AWS_REGION') or os.environ.get('AWS_DEFAULT_REGION') or configured or 'eu-west-1')
    parser.add_argument('--server', default=os.environ.get('SIMULATOR_URL', 'http://localhost:3000'))
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    account = args.account or subprocess.run(
        ['aws', 'sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], capture_output=True, text=True).stdout.strip()
    with open(args.script) as handle:
        code = handle.read()
    body = {
        'account': account, 'region': args.region, 'code': code, 'timeoutSeconds': args.timeout,
        'from': {k: v for k, v in {
            'networkInterfaceId': args.eni, 'subnet': args.subnet, 'securityGroups': args.sg or None,
            'privateIp': args.ip, 'publicIp': args.public_ip,
        }.items() if v},
    }
    if args.role:
        body.update(role=args.role, sessionName=args.session_name)
    request = urllib.request.Request(args.server + '/api/runtime/run', json.dumps(body).encode(), {'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=args.timeout + 30) as response:
            answer = json.load(response)
    except urllib.error.HTTPError as error:
        print('Refused:', json.loads(error.read()).get('error', error.reason), file=sys.stderr)
        sys.exit(3)
    except urllib.error.URLError as error:
        sys.exit(f'Cannot reach the simulator at {args.server}: {error.reason}')

    if args.json:
        print(json.dumps(answer, indent=2))
    else:
        for line in answer['assumptions']:
            print('Assumed:', line)
        print('--- output ---')
        sys.stdout.write(answer['stdout'])
        if answer['stderr']:
            print('--- errors ---')
            sys.stdout.write(answer['stderr'])
        print('--- network ---')
        print(answer['text'])
    sys.exit(answer['exitCode'] if answer['exitCode'] is not None else 124)


if __name__ == '__main__':
    main()
