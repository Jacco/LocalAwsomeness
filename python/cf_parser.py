"""CloudFormation template parsing.

`TemplateParser` is the intrinsic-function resolver from the project README ("This is for emulating CloudFormation").
`CloudFormationTemplate` wraps it: loads and validates the body, evaluates parameters and conditions, extracts the
resources with their dependencies and a deployment order. Properties are resolved per resource at deploy time, because
Ref/Fn::GetAtt on another resource need that resource to exist first.
"""
import base64
import copy
import ipaddress
import itertools
import json
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Optional

from cf_types import SUPPORTED_RESOURCE_TYPES, Resource, TemplateError

# (logical_id, attribute) -> value; attribute 'Ref' is the resource's Ref value.
GetAttribute = Callable[[str, str], Any]

PSEUDO_PARAMETERS = {
    'AWS::StackId', 'AWS::StackName', 'AWS::Region', 'AWS::Partition', 'AWS::AccountId', 'AWS::URLSuffix',
    'AWS::NoValue', 'AWS::NotificationARNs',
}


def is_condition(v: Any) -> bool:
    return isinstance(v, dict) and list(v.keys()) == ['Condition']


def is_ref(v: Any) -> bool:
    return isinstance(v, dict) and list(v.keys()) == ['Ref']


def is_intrinsic(v: Any) -> bool:
    return isinstance(v, dict) and len(v) == 1 and next(iter(v)).startswith('Fn::')


@dataclass
class TemplateContext:
    account: str
    region: str
    stack_name: str
    stack_id: Optional[str] = None
    parameters: dict = field(default_factory=dict)
    ssm_parameters: dict = field(default_factory=dict)
    exports: dict = field(default_factory=dict)
    partition: str = 'aws'
    url_suffix: str = 'amazonaws.com'


def _no_attributes(logical_id: str, attribute: str) -> Any:
    raise TemplateError(f'Cannot resolve {logical_id}.{attribute}: resource attributes are not available yet')


class TemplateParser:
    def __init__(self, context: TemplateContext, json_template: dict, get_attribute: GetAttribute = _no_attributes,
                 use_parameter_defaults: bool = False):
        self.data = json_template
        self.get_attribute = get_attribute
        self.use_parameter_defaults = use_parameter_defaults
        self.context = context
        self.mappings = {}
        self.parameters = {}
        self.conditions = {}
        self.resources = {}
        self.refs = {}
        self.refs['AWS::StackId'] = context.stack_id or \
            f'arn:aws:cloudformation:{context.region}:{context.account}:stack/{context.stack_name}/{uuid.uuid4()}'
        self.refs['AWS::StackName'] = context.stack_name
        self.refs['AWS::Region'] = context.region
        self.refs['AWS::Partition'] = context.partition
        self.refs['AWS::AccountId'] = context.account
        self.refs['AWS::URLSuffix'] = context.url_suffix
        self.refs['AWS::NotificationARNs'] = []

    def get_conditions(self):
        for k in list(self.data.get('Conditions', {}).keys()):
            self.json_extract(self.data['Conditions'][k], self.data['Conditions'], k)
            self.conditions[k] = self.data['Conditions'][k]

    def get_parameters(self):
        self.parameters = self.context.parameters.copy()
        if self.use_parameter_defaults:
            for k, v in self.data.get('Parameters', {}).items():
                if k not in self.parameters and 'Default' in v:
                    if v['Type'].startswith('AWS::SSM::Parameter::Value'):
                        values = self.context.ssm_parameters[v['Default']]
                        self.parameters[k] = values[list(values.keys())[-1]]
                    elif v['Type'] == 'CommaDelimitedList':
                        self.parameters[k] = v['Default'].split(',')
                    else:
                        self.parameters[k] = v['Default']

    def get_resources(self):
        self.data['Resources'] = {
            k: v for k, v in self.data.get('Resources', {}).items()
            if 'Condition' not in v or self.get_condition_by_name(v['Condition'])
        }
        self.resources = {k: {'json': v, 'type': v['Type']} for k, v in self.data.get('Resources', {}).items()}

    def get_condition_by_name(self, name):
        if name in self.conditions:
            return self.conditions[name]
        raise TemplateError(f'Condition "{name}" not found')

    def get_condition(self, obj):
        return self.get_condition_by_name(obj['Condition'] if is_condition(obj) else '')

    def get_ssm_parameter(self, name: str, version: str) -> Any:
        return self.context.ssm_parameters[name][version]

    def clean_template(self):
        [self.data.pop(k, None) for k in ['Conditions', 'Mappings', 'Parameters', 'Rules']]
        for k in self.data.get('Resources', {}).keys():
            self.data['Resources'][k].pop('Condition', None)
            self.data['Resources'][k].pop('DependsOn', None)

    def get_att(self, logical_id, attribute_name):
        return self.get_attribute(logical_id, attribute_name)

    def patterns(self, obj):
        for x in re.finditer(r'\$\{(?P<ref>[^\}]+)\}', obj):
            yield x.groupdict().get('ref'), x.group()

    def fn_sub(self, obj, root):
        self.json_extract(obj, root, 'Fn::Sub')
        match root['Fn::Sub']:
            case str(s):
                for ref, repl in self.patterns(s):
                    match ref:
                        case 'AWS::NoValue': s = s.replace(repl, '')
                        case ref if ref.startswith('!'): s = s.replace(repl, '${' + ref[1:] + '}')
                        case ref if '.' in ref: s = s.replace(repl, str(self.get_att(*ref.split('.', 1))))
                        case _ as ref: s = s.replace(repl, str(self.resolve_ref(ref)))
                return s
            case list(l):
                self.json_extract(l[1], l, 1)
                for ref, repl in self.patterns(l[0]):
                    l[0] = l[0].replace(repl, str(l[1][ref] if ref in l[1] else self.resolve_ref(ref)))
                return l[0]
        raise TemplateError('Fn::Sub needs a string or a list of a string and a mapping')

    def fn_get_att(self, obj, root):
        return self.get_att(*(obj.split('.', 1) if isinstance(obj, str) else obj))

    def fn_or(self, obj, root):
        self.json_extract(obj)
        return any(self.get_condition(v) if is_condition(v) else v for v in obj)

    def fn_equals(self, obj, root):
        self.json_extract(obj)
        if not isinstance(obj, list) or len(obj) != 2:
            raise TemplateError('Fn::Equals needs a list with two items as input')
        left, right = obj
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
            obj[2] = ''
            self.json_extract(obj[1], obj, 1)
            return obj[1]
        else:
            obj[1] = ''
            self.json_extract(obj[2], obj, 2)
            return obj[2]

    def fn_join(self, obj, root):
        self.json_extract(obj)
        return obj[0].join(str(v) for v in obj[1])

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
        return [f'{region}a', f'{region}b', f'{region}c']

    def fn_find_in_map(self, obj, root):
        self.json_extract(obj)
        if obj[0] in self.mappings:
            return self.mappings[obj[0]][obj[1]][obj[2]]
        raise TemplateError(f'Mapping {obj[0]} not found')

    def fn_cidr(self, obj, root):
        self.json_extract(obj)
        net = ipaddress.ip_network(obj[0], strict=False)
        subnets = net.subnets(new_prefix=net.max_prefixlen - int(obj[2]))
        return [str(subnet) for subnet in itertools.islice(subnets, int(obj[1]))]

    def fn_length(self, obj, root):
        self.json_extract(obj, root, 'Fn::Length')
        return len(root['Fn::Length'])

    def fn_base64(self, obj, root):
        self.json_extract(obj, root, 'Fn::Base64')
        return base64.b64encode(root['Fn::Base64'].encode()).decode()

    def fn_import_value(self, obj, root):
        self.json_extract(obj, root, 'Fn::ImportValue')
        name = root['Fn::ImportValue']
        if name not in self.context.exports:
            raise TemplateError(f'No export named {name} found')
        return self.context.exports[name]

    def intrinsic(self, contents):
        match contents:
            case {'Fn::Sub': value}: return self.fn_sub(value, contents)
            case {'Fn::GetAtt': value}: return self.fn_get_att(value, contents)
            case {'Fn::ImportValue': value}: return self.fn_import_value(value, contents)
            case {'Fn::Or': value}: return self.fn_or(value, contents)
            case {'Fn::Equals': value}: return self.fn_equals(value, contents)
            case {'Fn::Not': value}: return self.fn_not(value, contents)
            case {'Fn::Contains': value}: return self.fn_contains(value, contents)
            case {'Fn::Base64': value}: return self.fn_base64(value, contents)
            case {'Fn::If': value}: return self.fn_if(value, contents)
            case {'Fn::Join': value}: return self.fn_join(value, contents)
            case {'Fn::Select': value}: return self.fn_select(value, contents)
            case {'Fn::Split': value}: return self.fn_split(value, contents)
            case {'Fn::And': value}: return self.fn_and(value, contents)
            case {'Fn::GetAZs': value}: return self.fn_get_azs(value, contents)
            case {'Fn::FindInMap': value}: return self.fn_find_in_map(value, contents)
            case {'Fn::Cidr': value}: return self.fn_cidr(value, contents)
            case {'Fn::Length': value}: return self.fn_length(value, contents)
            case _: raise TemplateError(f'Unknown intrinsic {list(contents.keys())[0]}')

    def resolve_ref(self, ref):
        match ref:
            case r if r in self.refs: return self.refs[r]
            case r if r in self.parameters: return self.parameters[r]
            case r if r in self.resources: return self.get_att(ref, 'Ref')
            case _: raise TemplateError(
                f"Reference '{ref}' not found. A reference should be either a parameter, a pseudo parameter "
                'or the logical name of a resource')

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
                                del obj[k]
                            else:
                                obj[k] = self.resolve_ref(v['Ref'])
                        elif isinstance(v, (dict, list, str)):
                            extract(v, obj, k)
            elif isinstance(obj, list):
                to_remove = []
                for idx, item in enumerate(obj):
                    if is_ref(item):
                        if item['Ref'] != 'AWS::NoValue':
                            obj[idx] = self.resolve_ref(item['Ref'])
                        else:
                            to_remove.append(idx)
                    elif is_intrinsic(item):
                        obj[idx] = self.intrinsic(item)
                    else:
                        extract(item, obj, idx)
                for idx in reversed(to_remove):
                    del obj[idx]
            elif isinstance(obj, str) and obj.startswith('{{resolve:'):
                parts = obj.strip('{}').split(':')
                if len(parts) > 3 and parts[1] == 'ssm':
                    root[key] = self.get_ssm_parameter(parts[2], parts[3])
                else:
                    raise TemplateError(f'Dynamic parameter error {obj}')

        extract(obj, root or obj, key)

    def resolve(self):
        self.mappings = self.data.get('Mappings', {})
        self.get_parameters()
        self.get_conditions()
        self.get_resources()
        self.json_extract(self.data)
        self.clean_template()


def load_template(body: Any) -> dict:
    """Template body (JSON text or already-parsed dict) -> dict."""
    if isinstance(body, dict):
        return copy.deepcopy(body)
    if not isinstance(body, str) or not body.strip():
        raise TemplateError('Template body cannot be empty')
    try:
        template = json.loads(body)
    except json.JSONDecodeError as e:
        if not body.lstrip().startswith('{'):
            raise TemplateError('Template format error: only JSON templates are supported') from e
        raise TemplateError(f'Template format error: JSON not well-formed. (line {e.lineno}, column {e.colno})') from e
    if not isinstance(template, dict):
        raise TemplateError('Template format error: the template must be a JSON object')
    return template


def references(value: Any) -> set[str]:
    """Names referenced by Ref, Fn::GetAtt and Fn::Sub anywhere in `value` (parameters and resources alike)."""
    found: set[str] = set()

    def sub_refs(s: str) -> None:
        for m in re.finditer(r'\$\{([^}!][^}]*)\}', s):
            found.add(m.group(1).split('.', 1)[0])

    def walk(v: Any) -> None:
        if isinstance(v, dict):
            if is_ref(v) and isinstance(v['Ref'], str):
                found.add(v['Ref'])
                return
            if len(v) == 1 and 'Fn::GetAtt' in v:
                att = v['Fn::GetAtt']
                if isinstance(att, str):
                    found.add(att.split('.', 1)[0])
                elif isinstance(att, list) and att and isinstance(att[0], str):
                    found.add(att[0])
                return
            if len(v) == 1 and 'Fn::Sub' in v:
                sub = v['Fn::Sub']
                if isinstance(sub, str):
                    sub_refs(sub)
                elif isinstance(sub, list) and sub:
                    variables = sub[1] if len(sub) > 1 and isinstance(sub[1], dict) else {}
                    if isinstance(sub[0], str):
                        inner: set[str] = set()
                        for m in re.finditer(r'\$\{([^}!][^}]*)\}', sub[0]):
                            inner.add(m.group(1).split('.', 1)[0])
                        found.update(inner - set(variables))
                    walk(variables)
                return
            for item in v.values():
                walk(item)
        elif isinstance(v, list):
            for item in v:
                walk(item)

    walk(value)
    return found


def deployment_order(resources: dict[str, Resource]) -> list[str]:
    """Topological order (dependencies first); ties keep template order. Raises on cycles, as CloudFormation does."""
    remaining = {k: set(r.depends_on) for k, r in resources.items()}
    order: list[str] = []
    while remaining:
        ready = [k for k, deps in remaining.items() if not deps]
        if not ready:
            raise TemplateError(f'Circular dependency between resources: {sorted(remaining)}')
        for k in ready:
            order.append(k)
            del remaining[k]
        for deps in remaining.values():
            deps.difference_update(ready)
    return order


class CloudFormationTemplate:
    def __init__(self, body: Any, context: TemplateContext):
        self.raw = load_template(body)
        self.context = context
        self.description: str = self.raw.get('Description', '')
        self.resources: dict[str, Resource] = {}
        self.order: list[str] = []
        self.skipped: list[str] = []
        self._parser: Optional[TemplateParser] = None

    def parse(self) -> list[Resource]:
        """Validate, evaluate parameters and conditions, return resources in deployment order."""
        self._validate_structure()
        parser = TemplateParser(self.context, copy.deepcopy(self.raw), use_parameter_defaults=True)
        parser.mappings = parser.data.get('Mappings', {})
        parser.get_parameters()
        self._check_parameters(parser)
        parser.get_conditions()
        parser.get_resources()
        self._parser = parser

        declared = self.raw['Resources']
        self.skipped = [k for k in declared if k not in parser.resources]
        for logical_id in parser.resources:
            definition = declared[logical_id]
            depends_on = definition.get('DependsOn', [])
            if isinstance(depends_on, str):
                depends_on = [depends_on]
            refs = references(definition.get('Properties', {})) - PSEUDO_PARAMETERS
            for name in [*depends_on, *refs]:
                if name not in declared and name not in parser.parameters:
                    kind = 'DependsOn' if name in depends_on else 'reference'
                    raise TemplateError(f'Template format error: Unresolved resource dependencies [{name}] '
                                        f'in the Resources block of the template ({kind} of {logical_id})')
                if name in self.skipped:
                    raise TemplateError(f'Resource {logical_id} depends on {name}, which is excluded by its Condition')
            self.resources[logical_id] = Resource(
                logical_id=logical_id,
                type=definition['Type'],
                properties=definition.get('Properties', {}),
                depends_on={n for n in [*depends_on, *refs] if n in parser.resources and n != logical_id},
                condition=definition.get('Condition'),
                deletion_policy=definition.get('DeletionPolicy', 'Delete'),
            )
            if logical_id in refs:
                raise TemplateError(f'Circular dependency between resources: [{logical_id}]')
        self.order = deployment_order(self.resources)
        return [self.resources[k] for k in self.order]

    def resolve_properties(self, logical_id: str, get_attribute: GetAttribute = _no_attributes) -> dict[str, Any]:
        """Resolve intrinsics in one resource's Properties; `get_attribute` supplies Ref/GetAtt of other resources."""
        if self._parser is None:
            raise RuntimeError('parse() must be called first')
        self._parser.get_attribute = get_attribute
        wrapper = {'Properties': copy.deepcopy(self.resources[logical_id].properties)}
        self._parser.json_extract(wrapper)
        return wrapper['Properties']

    def _validate_structure(self) -> None:
        resources = self.raw.get('Resources')
        if not isinstance(resources, dict) or not resources:
            raise TemplateError('Template format error: At least one Resources member must be defined.')
        unsupported: list[str] = []
        for logical_id, definition in resources.items():
            if not re.fullmatch(r'[A-Za-z0-9]+', logical_id):
                raise TemplateError(f'Template format error: Resource name {logical_id} is non alphanumeric.')
            if not isinstance(definition, dict) or not isinstance(definition.get('Type'), str):
                raise TemplateError(f'Template format error: [/Resources/{logical_id}] Every Resources object '
                                    'must contain a Type member.')
            if definition['Type'] not in SUPPORTED_RESOURCE_TYPES:
                unsupported.append(definition['Type'])
        if unsupported:
            raise TemplateError(f'Template format error: Unrecognized resource types: [{", ".join(sorted(set(unsupported)))}]'
                                f' (supported: {", ".join(SUPPORTED_RESOURCE_TYPES)})')

    def _check_parameters(self, parser: TemplateParser) -> None:
        declared = self.raw.get('Parameters', {})
        missing = [k for k in declared if k not in parser.parameters]
        if missing:
            raise TemplateError(f'Parameters: [{", ".join(missing)}] must have values')
        unknown = [k for k in self.context.parameters if k not in declared]
        if unknown:
            raise TemplateError(f'Parameters: [{", ".join(unknown)}] do not exist in the template')
