# Copyright (c) 2023-2023 Huawei Technologies Co., Ltd.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import onnx
from onnx import AttributeProto
from utils.parse_tools import parse_str2val


def make_new_node(node_info):
    name = node_info['properties']['name']
    op_type = node_info['properties']['op_type']
    attributes = {}
    for attr_name, attr_meta in node_info['attributes'].items():
        attr_value, attr_type = attr_meta
        if attr_value == 'undefined' or len(attr_value.replace(' ', '')) == 0:
            continue
        attributes[attr_name] = parse_str2val(attr_value, attr_type)

    inputs = []
    for key in node_info['inputs'].keys():
        for inp in node_info['inputs'][key]:
            # filter out the un-filled io in list
            if not inp.startswith('list_custom'):
                inputs.append(inp)
    outputs = []
    for key in node_info['outputs'].keys():
        for out in node_info['outputs'][key]:
            # filter out the un-filled io in list
            if not out.startswith('list_custom'):
                outputs.append(out)

    node = onnx.helper.make_node(
        op_type=op_type,
        inputs=inputs,
        outputs=outputs,
        name=name,
        **attributes
    )

    return node


def make_attr_changed_node(node, attr_change_info):
    # convert the changed attribute value into the type that is consistent with the original attribute
    # because AttributeProto is constructed barely based on the input value
    def make_type_value(value, attribute_proto_type):
        attr_type = AttributeProto.AttributeType.Name(attribute_proto_type)
        if attr_type == "FLOAT":
            return float(value)
        elif attr_type == "INT":
            return int(value)
        elif attr_type == "STRING":
            return value
        elif attr_type == "FLOATS":
            return parse_str2val(value, "float[]")
        elif attr_type == "INTS":
            return parse_str2val(value, "int[]")
        elif attr_type == "STRINGS":
            return parse_str2val(value, "string[]")
        else:
            raise RuntimeError("type {} is not considered in current version. \
                               You can kindly report an issue for this problem. Thanks!".format(attr_type))

    new_attr = dict()
    for attr in node.attribute:
        if attr.name in attr_change_info.keys():
            new_attr[attr.name] = make_type_value(attr_change_info[attr.name][0], attr.type)
        else:
            new_attr[attr.name] = onnx.helper.get_attribute_value(attr)

    node = onnx.helper.make_node(
        op_type=node.op_type,
        inputs=node.input,
        outputs=node.output,
        name=node.name,
        **new_attr
    )

    return node