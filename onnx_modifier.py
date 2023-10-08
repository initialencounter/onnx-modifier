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

import os
import copy
import logging
import struct
import warnings
import numpy as np
import onnx
from onnx import numpy_helper
from onnx import helper
from utils import make_new_node, make_attr_changed_node
from utils import parse_str2np, np2onnxdtype


class OnnxModifier:

    def __init__(self, model_name, model_proto):
        self.model_name = model_name
        self.model_proto_backup = model_proto
        self.node_name2module = dict()
        self.graph_input_names = []
        self.graph_output_names = []
        self.initializer_name2module = []
        self.graph_output_names = []
        self.graph_input_names = []
        self.reload(self.model_proto_backup)

    def reload(self, model_proto=None):
        if model_proto is None:
            self.model_proto = copy.deepcopy(self.model_proto_backup)
        else:
            self.model_proto_backup = model_proto
            self.model_proto = copy.deepcopy(model_proto)
        self.graph = self.model_proto.graph
        self.initializer = self.model_proto.graph.initializer

        self.gen_name2module_map()
        return self

    def gen_name2module_map(self):
        # node name => node
        self.node_name2module = dict()
        node_idx = 0
        for node in self.graph.node:
            if node.name == '':
                node.name = str(node.op_type) + str(node_idx)
            node_idx += 1
            self.node_name2module[node.name] = node

        for inp in self.graph.input:
            self.node_name2module[inp.name] = inp
        self.graph_input_names = [inp.name for inp in self.graph.input]

        for out in self.graph.output:
            # add `out_` in case the output has the same name with the last node
            self.node_name2module["out_" + out.name] = out
        self.graph_output_names = ["out_" + out.name for out in self.graph.output]

        # initializer name => initializer
        self.initializer_name2module = dict()
        for initializer in self.initializer:
            self.initializer_name2module[initializer.name] = initializer
    
    def change_batch_size(self, rebatch_info):
        if not (rebatch_info): 
            return
        rebatch_type = rebatch_info['type']
        rebatch_value = rebatch_info['value']
        if rebatch_type == 'fixed':
            rebatch_value = int(rebatch_value)

        # Change batch size in input, output and value_info
        for tensor in list(self.graph.input) + list(self.graph.value_info) + list(self.graph.output):
            if type(rebatch_value) == str:
                tensor.type.tensor_type.shape.dim[0].dim_param = rebatch_value
            elif type(rebatch_value) == int:
                tensor.type.tensor_type.shape.dim[0].dim_value = rebatch_value
            else:
                warnings.warn(
                    'Unknown type {} for batch size. Fallback to dynamic batch size.'.format(type(rebatch_value)))
                tensor.type.tensor_type.shape.dim[0].dim_param = str(rebatch_value)

        # handle reshapes
        for node in self.graph.node:
            if node.op_type != 'Reshape':
                continue
            for init in self.graph.initializer:
                # node.input[1] is expected to be a reshape
                if init.name != node.input[1]:
                    continue

                v = rebatch_value if rebatch_type == 'fixed' else -1
                # Shape is stored as a list of ints
                if len(init.int64_data) > 0:
                    # This overwrites bias nodes' reshape shape but should be fine
                    init.int64_data[0] = v
                # Shape is stored as bytes
                elif len(init.raw_data) > 0:
                    shape = bytearray(init.raw_data)
                    struct.pack_into('q', shape, 0, v)
                    init.raw_data = bytes(shape)
    
    
    def change_input_size(self, input_size_info):
        for tensor in self.graph.input:
            if tensor.name not in input_size_info:
                continue
            tensor.type.CopyFrom(helper.make_tensor_type_proto(onnx.TensorProto.FLOAT, input_size_info[tensor.name]))

    def remove_node_by_node_states(self, node_states):
        # remove node from graph
        for node_name, node_state in node_states.items():
            if not (node_name in self.node_name2module):
                # for custom added node here
                continue
            if node_state == 'Deleted':
                if node_name in self.graph_output_names:
                    self.graph.output.remove(self.node_name2module.get(node_name, None))
                    self.graph_output_names = [n for n in self.graph_output_names if n != node_name]
                elif node_name in self.graph_input_names:
                    self.graph.input.remove(self.node_name2module.get(node_name, None))
                    self.graph_input_names = [n for n in self.graph_input_names if n != node_name]
                else:
                    self.graph.node.remove(self.node_name2module.get(node_name, None))
                self.node_name2module.pop(node_name, None)

        remained_inputs = []
        for remained_node in self.graph.node:
            remained_inputs += remained_node.input
        
        # remove node initializers (parameters), aka, keep and only keep the initializers of remained nodes
        for init_name in self.initializer_name2module.keys():
            if init_name not in remained_inputs:
                self.initializer.remove(self.initializer_name2module.get(init_name, None))

        # remove the (model) inputs related to deleted nodes 
        for input_name in self.graph_input_names:
            if input_name not in remained_inputs:
                input_to_remove = self.node_name2module.get(input_name, None)
                if input_to_remove is not None and input_name == input_to_remove.name:
                    self.graph.input.remove(self.node_name2module.get(input_name, None))

    def modify_node_io_name(self, node_renamed_io):
        for node_name in node_renamed_io.keys():
            if node_name not in self.node_name2module.keys():
                # custom added nodes or custom added model outputs, or the deleted nodes
                continue
            renamed_ios = node_renamed_io[node_name]
            for src_name, dst_name in renamed_ios.items():
                node = self.node_name2module.get(node_name, None)
                if node is None:
                    raise ValueError("node cannot found")
                if node_name in self.graph_input_names:
                    node.name = dst_name
                elif node_name in self.graph_output_names:
                    node.name = dst_name
                else:
                    for i in range(len(node.input)):
                        if node.input[i] == src_name:
                            node.input[i] = dst_name
                    for i in range(len(node.output)):
                        if node.output[i] == src_name:
                            node.output[i] = dst_name

                    # rename the corresponding initializer and update initializer_name2module
                    if src_name in self.initializer_name2module.keys():
                        init = self.initializer_name2module.get(src_name, None)
                        if init is None:
                            raise ValueError("cannot get initializer by name")
                        init.name = dst_name
                        self.initializer_name2module[dst_name] = init
                        del self.initializer_name2module[src_name]

    def modify_node_attr(self, node_changed_attr):
        # we achieve it by deleting the original node and make a (copied) new node
        for node_name in node_changed_attr.keys():
            orig_node = self.node_name2module.get(node_name, None)
            if orig_node is None:
                raise ValueError("cannot found node by name")
            attr_changed_node = make_attr_changed_node(orig_node, node_changed_attr[node_name])
            self.graph.node.remove(self.node_name2module[node_name]) 
            self.graph.node.append(attr_changed_node)

            # update the node_name2module
            if node_name in self.node_name2module:
                del self.node_name2module[node_name]
            self.node_name2module[node_name] = attr_changed_node
    
    def modify_model_props(self, model_properties):
        for key, value in model_properties.items():
            if key == "domain" and len(value) > 0:
                self.model_proto.domain = value
            elif key == "imports" and len(value) > 0:
                opset_import_modify_info = value
                opset_import_modified_info = []
                for index, opset_import_info in enumerate(self.model_proto.opset_import):
                    if index >= len(opset_import_modify_info) or opset_import_modify_info[index] is None:
                        opset_import_modified_info.append(opset_import_info)
                        continue
                    if len(opset_import_modify_info[index]) == 0:
                        continue
                    elif len(opset_import_modify_info[index]) == 1:
                        domain, version = [opset_import_modify_info[index], 0]
                    else:
                        domain, version = opset_import_modify_info[index][:2]
                    
                    opset_import_modified_info.append(helper.make_operatorsetid(domain=domain, version=version))

                while (len(self.model_proto.opset_import) > 0):
                    self.model_proto.opset_import.pop()
                
                for opset_info in opset_import_modified_info:
                    self.model_proto.opset_import.append(opset_info)

    def add_nodes(self, nodes_info, node_states):
        for node_info in nodes_info.values():
            if node_states[node_info['properties']['name']] == "Deleted":
                continue
            node = make_new_node(node_info)

            self.graph.node.append(node)

            # update the node_name2module
            self.node_name2module[node.name] = node

    def add_outputs(self, added_outputs):
        added_output_names = added_outputs.values()
        if len(added_output_names) == 0:
            return
        added_output_protoes = []
        shape_info = onnx.shape_inference.infer_shapes(self.model_proto)
        for value_info in shape_info.graph.value_info:
            if value_info.name in added_output_names:
                added_output_protoes.append(value_info)
                added_output_names = [name for name in added_output_names if name != value_info.name]
        if len(added_output_names) > 0:
            logging.info("[Warning]: Fail to add the following outputs due to an incomplete shape_inference()")
            for n in added_output_names:
                logging.info(n)
            return

        for output in added_output_protoes:
            self.graph.output.append(output)
            self.graph_output_names.append("out_" + output.name)
            self.node_name2module["out_" + output.name] = output
                
    def add_inputs(self, added_inputs):
        added_input_infos = added_inputs.values()
        if len(added_input_infos) == 0:
            return
        added_input_protoes = []
        
        for value_info in added_input_infos:
            if isinstance(value_info, str):
                value_name, value_dims = value_info, None
            elif isinstance(value_info, (list, tuple)):
                value_name, value_dims = value_info
            
            added_input_protoes.append(helper.make_tensor_value_info(value_name, onnx.TensorProto.FLOAT, value_dims))

        for input_info in added_input_protoes:
            self.graph.input.append(input_info)
            self.graph_input_names.append(input_info.name)
            self.node_name2module[input_info.name] = input_info 

    def modify_initializer(self, changed_initializer):
        for init_name, meta in changed_initializer.items():
            init_type, init_val_str = meta
            if init_val_str == "":
                continue # in case we clear the input
            init_val = parse_str2np(init_val_str, init_type)
            # for primary initilizers
            if init_name in self.initializer_name2module:
                tensor = numpy_helper.from_array(init_val, init_name)
                self.initializer_name2module[init_name].CopyFrom(tensor)
            # for custom added initilizers
            else:
                # more details about why the .flatten() is needed can be found 
                init_val_flat = init_val
                if len(init_val.shape) > 1:
                    init_val_flat = init_val.flatten()
                initializer_tensor = onnx.helper.make_tensor(
                    name=init_name,
                    data_type=np2onnxdtype(init_val.dtype),
                    dims=init_val.shape,
                    vals=init_val_flat)
                self.initializer.append(initializer_tensor)
                self.initializer_name2module[init_name] = initializer_tensor

    def post_process(self, kwargs):
        
        def get_tail_outputs():
            def collect_backtrack(input_name):
                if input_name not in input2nodes: # if the node has no child node
                    tail_outputs.add(input_name)
                    return
                
                node = input2nodes.get(input_name, None)
                if node in traversed_nodes:
                    return  # if the node has been traversed
                traversed_nodes.append(node)
                
                for node in input2nodes.get(input_name, []):
                    for output in node.output:
                        collect_backtrack(output)
            
            input2nodes = dict()
            for node in self.graph.node:
                for input_name in node.input:
                    if input_name not in input2nodes:
                        input2nodes[input_name] = []
                    input2nodes.get(input_name, []).append(node)        
                    
            tail_outputs = set()
            traversed_nodes = []
            for inp in self.graph.input:
                collect_backtrack(inp.name)
            return tail_outputs
            
        def remove_isolated_nodes():
            def collect_reverse_backtrack(output):
                if output not in output2node:
                    return # if the node has no parent node
                node = output2node.get(output, None)
                if node in connected_nodes:
                    return # if the node has been traversed
                connected_nodes.append(node)
                
                for input_name in node.input:
                    collect_reverse_backtrack(input_name)
                
            output2node = dict()
            for node in self.graph.node:
                for output in node.output:
                    output2node[output] = node
            
            connected_nodes = []
            model_tail_outputs = get_tail_outputs()
            for output in model_tail_outputs:
                collect_reverse_backtrack(output)
                   
            graph_connected_nodes = []
            graph_connected_initializers = []
            for node in self.graph.node:
                if node in connected_nodes:
                    if node.name not in self.node_name2module:
                        raise ValueError("cannot found node by name")
                    graph_connected_nodes.append(copy.deepcopy(self.node_name2module[node.name]))
                    for inp in node.input:
                        if inp in self.initializer_name2module:
                            graph_connected_initializers.append(copy.deepcopy(self.initializer_name2module[inp]))
            del self.graph.node[:]
            del self.initializer[:]
            self.graph.node.extend(graph_connected_nodes)
            self.initializer.extend(graph_connected_initializers)
            
        def shape_inference():
            # [Shape inference is not guaranteed to be complete]
            # clear the existed value_info and replace them with newly inferred one
            del self.graph.value_info[:]
            # clear output, otherwise infer_shapes() could fail due to shape inconsistency
            graph_output_bk = copy.deepcopy(self.graph.output)
            del self.graph.output[:]
            inferred_shape_info = onnx.shape_inference.infer_shapes(self.model_proto)
            for value_info in inferred_shape_info.graph.value_info:
                self.graph.value_info.append(value_info)

            # update output
            inferred_output = []
            for value_info in inferred_shape_info.graph.value_info:
                if "out_" + value_info.name in self.graph_output_names:
                    inferred_output.append(value_info)
                    graph_output_bk = [out for out in graph_output_bk if out.name != value_info.name]
            self.graph.output.extend(inferred_output)
            # when infer_shapes() is not complete, some output would lost
            # this is a workround. Note that the outputs which are not infered will stay UNCHANGED
            self.graph.output.extend(graph_output_bk)

        use_shape_inference = kwargs.pop("shapeInf", False)
        use_clean_up = kwargs.pop("cleanUp", False)
        
        if use_shape_inference:
            logging.info("[EXPERIMENTAL] Do shape inference automatically...")
            shape_inference()
        if use_clean_up:
            logging.info("[EXPERIMENTAL] Remove idle nodes...")
            remove_isolated_nodes()

    def modify(self, modify_info):
        '''
        1. Some functions, such as modify_initializer(), should be placed 
        before modify_node_io_name(), to avoid name mismatch error.
        2. add_nodes() should be placed at the first place, otherwise
        remove_node_by_node_states() will delete the initializer of 
        newly added nodes by mistake.
        '''

        self.add_nodes(modify_info['added_node_info'], modify_info['node_states'])
        self.modify_initializer(modify_info['changed_initializer'])
        self.change_batch_size(modify_info['rebatch_info'])
        self.add_inputs(modify_info['added_inputs'])
        self.change_input_size(modify_info['input_size_info'])
        self.add_outputs(modify_info['added_outputs'])
        self.modify_node_io_name(modify_info['node_renamed_io'])
        self.remove_node_by_node_states(modify_info['node_states'])
        self.modify_node_attr(modify_info['node_changed_attr'])
        self.modify_model_props(modify_info['model_properties'])

        self.post_process(modify_info['postprocess_args'])

        self.sort_nodes()

    def sort_nodes(self):
        nodes = self.graph.node
        if len(nodes) == 0:
            return 
        dict_output_to_node = dict()
        for node in nodes:
            for output in node.output:
                dict_output_to_node[output] = node

        inputs_before_this_index_node = set()
        index = 0
        while index < len(nodes):
            node = nodes[index]
            # check if inputs before this node 
            for input_name in node.input:
                if input_name in inputs_before_this_index_node:
                    continue
                node_prev = dict_output_to_node.get(input_name)
                if node_prev is None:
                    continue

                nodes.remove(node_prev)
                nodes.insert(index, node_prev)
                break
            else:
                # all input is before this node，good and go on
                for output_name in node.output:
                    inputs_before_this_index_node.add(output_name)
                index += 1

    def check_and_save_model(self, save_file):
        save_path = save_file.name
        # adding new node like self.add_nodes() and self.modify_node_attr() can not 
        # guarantee the nodes are topologically sorted
        # so `onnx.onnx_cpp2py_export.checker.ValidationError: Nodes in a graph 
        # must be topologically sorted` will be invoked
        # I turn off the onnx checker as a workaround.
        onnx.save(self.model_proto, save_file)
        logging.info("model saved in %s !", save_path)
        return save_path

    def inference(self, input_shape=None, x=None, output_names=None):
        if input_shape is None:
            input_shape = [1, 3, 224, 224]
        import onnxruntime as rt
        import io
        model_proto_bytes = io.BytesIO()
        onnx.save_model(self.model_proto, model_proto_bytes)
        inference_session = rt.InferenceSession(model_proto_bytes.getvalue())

        if not x:
            np.random.seed(0)
            x = np.random.randn(*input_shape).astype(np.float32)
        if not output_names:
            output_name = self.graph.node[-1].output[0]
            output_value_info = onnx.helper.make_tensor_value_info(output_name, onnx.TensorProto.FLOAT, shape=[])
            self.graph.output.append(output_value_info)
            output_names = [inference_session.get_outputs()[0].name]

        input_name = inference_session.get_inputs()[0].name
        out = inference_session.run(output_names, {input_name: x})[0]
        logging.info(out.shape, out.dtype)
