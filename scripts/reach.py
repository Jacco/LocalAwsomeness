#!/usr/bin/env python3
"""Ask the simulator whether a connection from somewhere in a VPC to a public AWS service would work, and why (not).

    scripts/reach.py --subnet private-a --sg fn sts.eu-west-1.amazonaws.com
    scripts/reach.py --eni eni-0123456789abcdef0 s3.eu-west-1.amazonaws.com --port 443
    scripts/reach.py --subnet public-a --public-ip 203.0.113.9 --json sts.eu-west-1.amazonaws.com

Subnets and security groups are given by id or Name tag. What is left out is filled in and listed. The account comes from
--account, AWS_ACCOUNT_ID or the caller identity of the AWS CLI (which the simulator answers); the server from --server.
The region comes from --region, AWS_REGION, AWS_DEFAULT_REGION or the AWS CLI configuration.
Exit status: 0 reached, 1 failed, 2 not modelled, 3 the request was refused.
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

EXIT = {'reached': 0, 'failed': 1, 'unknown': 2}


def account_from_cli():
    out = subprocess.run(['aws', 'sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit('Cannot find the account: pass --account or set AWS_ACCOUNT_ID.\n' + out.stderr.strip())
    return out.stdout.strip()


def main():
    configured = subprocess.run(['aws', 'configure', 'get', 'region'], capture_output=True, text=True).stdout.strip()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('host', help='the public service host name or IPv4 address')
    parser.add_argument('--port', type=int, default=443)
    parser.add_argument('--eni', help='start at an existing network interface')
    parser.add_argument('--subnet', help='start in this subnet (id or Name tag)')
    parser.add_argument('--sg', action='append', default=[], help='security group (id, group name or Name tag); repeatable')
    parser.add_argument('--ip', help='private address (default: the next free one)')
    parser.add_argument('--public-ip', help='public address of the source, if it has one')
    parser.add_argument('--source-port', type=int)
    parser.add_argument('--account', default=os.environ.get('AWS_ACCOUNT_ID'))
    parser.add_argument('--region', default=os.environ.get('AWS_REGION') or os.environ.get('AWS_DEFAULT_REGION') or configured or 'eu-west-1')
    parser.add_argument('--server', default=os.environ.get('SIMULATOR_URL', 'http://localhost:3000'))
    parser.add_argument('--json', action='store_true', help='print the whole answer as JSON')
    args = parser.parse_args()

    body = {
        'account': args.account or account_from_cli(),
        'region': args.region,
        'from': {k: v for k, v in {
            'networkInterfaceId': args.eni, 'subnet': args.subnet, 'securityGroups': args.sg or None,
            'privateIp': args.ip, 'publicIp': args.public_ip,
        }.items() if v},
        'to': {'host': args.host, 'port': args.port},
    }
    if args.source_port:
        body['sourcePort'] = args.source_port
    request = urllib.request.Request(args.server + '/api/network/inspect', json.dumps(body).encode(), {'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request) as response:
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
        print(answer['text'])
    sys.exit(EXIT.get(answer['trace']['outcome'], 2))


if __name__ == '__main__':
    main()
