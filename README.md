This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

Roadmap

- move account-info to account db
- OrganizationAccessRole / Organization resource policy
- make simple UI
- support Marker / MaxItems for list operations
- ssm / secretsmanager implementation
- create vpc / subnet
- simple CloudFormation emulator
- implement sts AssumeRole

In the end I want to:

1. being able to check wether from an compute environment (lambda/ec2/stepfunctions etc) it is possible to perform a certain action
    - check (assumed) role
    - policy
    - boundary
    - scps
    - resource policies
    - additional iam keys
2. being able to check wheter from an compute environment I am able to reach another resources over the network
    - network interface
    - security group
    - dns find target
    - security group
    - resource
    - NACLs
    - firewalls?
3. kms key correctly configured
4. service quota

Working backward
================

lambda.assertBasicNeeds
lambda.canReach(resource.dataplane)
lambda.canPerform(action, onresource)

This is for emulating CloudFormation

#!/usr/bin/python

from collections.abc import Callable
from dataclasses import field, dataclass
from netaddr import IPNetwork
import itertools
import sys
import re
import logging
import base64
import uuid

log = logging.getLogger('resolve')
log.setLevel(logging.DEBUG)
ch = logging.StreamHandler(stream=sys.stderr)
ch.setLevel(logging.DEBUG)
ch.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
log.addHandler(ch)

def is_condition(v: any) -> bool: 
    return isinstance(v, dict) and list(v.keys()) == ['Condition']

def is_ref(v: any) -> bool:
    return isinstance(v, dict) and list(v.keys()) == ['Ref']

def is_intrinsic(v: any) -> bool:
    return isinstance(v, dict) and len(v) == 1 and next(iter(v)).startswith('Fn::')

@dataclass
class TemplateContext:
    account: str
    region: str
    stack_name: str
    parameters: dict = field(default_factory=dict)
    ssm_parameters: dict = field(default_factory=dict)
    exports: dict = field(default_factory=dict)
    partition: str = 'aws'
    url_suffix: str = "amazonaws.com"

class TemplateParser:
    def __init__(self, context: TemplateContext, json_template, get_attribute=Callable[[str, str], any], use_parameter_defaults: bool=False):
        self.data = json_template
        self.get_attribute=get_attribute
        self.use_parameter_defaults=use_parameter_defaults
        self.context = context
        self.mappings = {}
        self.parameters = {}
        self.conditions = {}
        self.conditions = {}
        self.resources = {}
        self.refs = {}
        self.refs['AWS::StackId'] = f"arn:aws:cloudformation:{context.region}:{context.account}:stack/{context.stack_name}/{uuid.uuid4()}"
        self.refs['AWS::StackName'] = context.stack_name
        self.refs["AWS::Region"] = context.region
        self.refs["AWS::Partition"] = context.partition
        self.refs["AWS::AccountId"] = context.account
        self.refs["AWS::URLSuffix"] = context.url_suffix
        # TODO AWS::NotificationARNs

    def get_conditions(self):
        for k in list(self.data.get("Conditions", {}).keys()):
            self.json_extract(self.data["Conditions"][k], self.data["Conditions"], k)
            self.conditions[k] = self.data["Conditions"][k]

    def get_parameters(self):
        self.parameters = self.context.parameters.copy()
        if self.use_parameter_defaults:
            for k, v in self.data.get('Parameters', {}).items():
                if k not in self.parameters and 'Default' in v:
                    if v['Type'].startswith('AWS::SSM::Parameter::Value'):
                        values = self.context.ssm_parameters[v['Default']]
                        self.parameters[k] = values[list(values.keys())[-1]]
                    else:
                        if v['Type'] == "CommaDelimitedList":
                            self.parameters[k] = v['Default'].split(",")
                        else:
                            self.parameters[k] = v['Default']

    def get_resources(self):
        self.data["Resources"] = { 
            k: v for k, v in self.data.get("Resources", {}).items() 
            if not "Condition" in v or self.get_condition_by_name(v["Condition"]) 
        }
        self.resources = { k: { "json": v, "type": v["Type"] } for k, v in self.data.get("Resources", {}).items() }

    def get_condition_by_name(self, name):
        match name:
            case name if name in self.conditions: return self.conditions[name]
        raise Exception(f'Condition "{name}" not found')

    def get_condition(self, obj):
        return self.get_condition_by_name(obj['Condition'] if is_condition(obj) else "")

    def get_ssm_parameter(self, name: str, version: str) -> any:
        return self.context.ssm_parameters[name][version]

    def clean_template(self):
        [self.data.pop(k, None) for k in ["Conditions", "Mappings", "Parameters", "Rules"]]
        for k in self.data.get("Resources", {}).keys():
            self.data["Resources"][k].pop("Condition", None)
            self.data["Resources"][k].pop("DependsOn", None)

    def get_att(self, logical_id, attribute_name):
        return self.get_attribute(logical_id, attribute_name, self)

    def patterns(self, obj):
        for x in re.finditer(r'\$\{(?P<ref>[^\}]+)\}', obj):
            yield x.groupdict().get('ref'), x.group()

    def fn_sub(self, obj, root):
        self.json_extract(obj, root, 'Fn::Sub')
        match root['Fn::Sub']:
            case str(s):
                for ref, repl in self.patterns(s):
                    match ref:
                        case 'AWS::NoValue': s = s.replace(repl, "")
                        case ref if "." in ref: s = s.replace(repl, self.get_att(*ref.split(".")))
                        case _ as ref: s = s.replace(repl, self.resolve_ref(ref)) 
                return s
            case list(l):
                self.json_extract(l[1], l, 1)
                for ref, repl in self.patterns(l[0]):
                    l[0] = l[0].replace(repl, l[1][ref] if ref in l[1] else self.resolve_ref(ref))
                return l[0]
        raise Exception("Wrong list parameters")

    def fn_get_att(self, obj, root):
        return self.get_att(*(obj.split(".") if isinstance(obj, str) else obj))

    def fn_or(self, obj, root):
        self.json_extract(obj)
        return any(obj)

    def fn_equals(self, obj, root):
        self.json_extract(obj)
        if not isinstance(obj, list) or len(obj) != 2:
            raise Exception("Fn::Equals needs a list with two items as input")
        left, right = obj
        if isinstance(left, object): self.json_extract(left)
        if isinstance(right, object): self.json_extract(right)
        return left == right

    def fn_not(self, obj, root):
        obj[0] = self.get_condition(obj[0]) if is_condition(obj[0]) else obj[0]
        self.json_extract(obj)
        return not obj[0]

    def fn_contains(self, obj, root):
        # can only be used in rules
        self.json_extract(obj)
        return obj[1] in obj[0]

    def fn_if(self, obj, root):
        if self.get_condition_by_name(obj[0]):
            obj[2] = ""
            self.json_extract(obj[1], obj, 1)
            return obj[1]
        else:
            obj[1] = ""
            self.json_extract(obj[2], obj, 2)
            return obj[2]

    def fn_join(self, obj, root):
        self.json_extract(obj)
        return obj[0].join(obj[1])

    def fn_select(self, obj, root):
        self.json_extract(obj)
        return obj[1][int(obj[0])]

    def fn_split(self, obj, root):
        self.json_extract(obj, root, 'Fn::Split')
        return obj[1].split(obj[0])

    def fn_and(self, obj, root):
        self.json_extract(obj)
        for idx, val in enumerate(obj):
            if is_condition(val):
                obj[idx] = self.get_condition(val)
        self.json_extract(obj)
        return all(obj)

    def fn_get_azs(self, obj, root):
        self.json_extract(obj, root, 'Fn::GetAZs')
        region = root['Fn::GetAZs'] or self.refs['AWS::Region']
        return [f"{region}a", f"{region}b", f"{region}c"]

    def fn_find_in_map(self, obj, root):
        self.json_extract(obj)
        if obj[0] in self.mappings:
            return self.mappings[obj[0]][obj[1]][obj[2]]
        else:
            raise Exception(f"Mapping {obj[0]} not found")

    def fn_cidr(self, obj, root):
        self.json_extract(obj)
        net = IPNetwork(obj[0])
        subnets = net.subnet((64 if ':' in net.ip.bits() else 32)-int(obj[2]))
        return [f'{subnet}' for subnet in itertools.islice(subnets, int(obj[1]))]

    def fn_length(self, obj, root):
        self.json_extract(obj, root, 'Fn::Length')
        return len(root['Fn::Length'])

    def fn_base64(self, obj, root):
        self.json_extract(obj, root, 'Fn::Base64')
        return base64.b64encode(root['Fn::Base64'].encode()).decode()

    def fn_import_value(self, obj, root):
        self.json_extract(obj, root, 'Fn::ImportValue')
        return self.context.exports[root['Fn::ImportValue']]

    def intrinsic(self, contents):
        match contents:
            case { "Fn::Sub":         value }: return self.fn_sub(value, contents)
            case { "Fn::GetAtt":      value  }: return self.fn_get_att(value, contents)
            case { "Fn::ImportValue": value  }: return self.fn_import_value(value, contents)
            case { "Fn::Or":          value  }: return self.fn_or(value, contents)
            case { "Fn::Equals":      value  }: return self.fn_equals(value, contents)
            case { "Fn::Not":         value  }: return self.fn_not(value, contents)
            case { "Fn::Contains":    value  }: return self.fn_contains(value, contents)
            case { "Fn::Base64":      value  }: return self.fn_base64(value, contents)
            case { "Fn::If":          value  }: return self.fn_if(value, contents)
            case { "Fn::Join":        value  }: return self.fn_join(value, contents)
            case { "Fn::Select":      value  }: return self.fn_select(value, contents)
            case { "Fn::Split":       value  }: return self.fn_split(value, contents)
            case { "Fn::And":         value  }: return self.fn_and(value, contents)
            case { "Fn::GetAZs":      value  }: return self.fn_get_azs(value, contents)
            case { "Fn::FindInMap":   value  }: return self.fn_find_in_map(value, contents)
            case { "Fn::Cidr":        value  }: return self.fn_cidr(value, contents)
            case { "Fn::Length":      value  }: return self.fn_length(value, contents)
            case _: raise Exception(f"Unknown intrinsic {list(contents.keys())[0]}")

    def resolve_ref(self, ref):
        match ref:
            case r if r in self.refs: return self.refs[r]
            case r if r in self.resources: return self.get_att(ref, 'Ref')
            case r if r in self.parameters: return self.parameters[r]
            case _: raise Exception(f"Reference '{ref}' not found. A reference should be either a parameter, a pseudo parameter or the logical name of a resource")

    def json_extract(self, obj, root=None, key=None):
    
        def extract(obj, root, key):
            if isinstance(obj, dict):
                if is_ref(obj):
                    root[key] = self.resolve_ref(obj['Ref'])
                elif is_intrinsic(obj):
                    root[key] = self.intrinsic(obj)
                else:
                    for k in list(obj.keys()):
                        v = obj[k]
                        if is_ref(v):
                            if v.get('Ref', None) == 'AWS::NoValue':
                                del root[key][k]
                            else:
                                root[key][k] = self.resolve_ref(v['Ref'])
                        elif isinstance(v, (dict, list)):
                            extract(v, obj, k)
                        elif isinstance(v, str):
                            extract(v, obj, k)
                        else:
                            pass
            elif isinstance(obj, list):
                to_remove = []
                for idx, item in enumerate(obj):
                    if is_ref(item):
                        if item['Ref'] != "AWS::NoValue":
                            obj[idx] = self.resolve_ref(item['Ref'])
                        else:
                            to_remove.append(idx)
                            obj[idx] = ""
                    elif is_intrinsic(item):
                        obj[idx] = self.intrinsic(item)
                    else:
                        extract(item, obj, idx)
                for idx in to_remove:
                    del obj[idx]
            else:
                if isinstance(obj, str) and obj.startswith("{{resolve:"):
                    parts = obj.strip('{}').split(':')
                    if len(parts) > 3 and parts[1] == 'ssm':
                        root[key] = self.get_ssm_parameter(parts[2], parts[3])
                    else:
                        raise Exception(f"Dynamic parameter error {obj}")
    
        extract(obj, root or obj, key)

    def resolve(self):
        self.mappings = self.data.get("Mappings", {})
        self.get_parameters()
        self.get_conditions()
        self.get_resources()
        self.json_extract(self.data)
        self.clean_template()

