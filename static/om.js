
// Experimental

var om = om || {};
var protobuf = protobuf || require('./protobuf');
var base = base || require('./base');


function formatEnumToString(i) {
    const FORMAT_LIST = ["NCHW", "NHWC", "ND", "NC1HWC0", "Fractal-Z", "NC1C0HW Pad", "NHWC1C0", "FSR_NCHW",
        "Fractal-Deconv", "C1HWNC0", "Fractal-Deconv-Transposed", "Fractal-Deconv-SP-Stride-Trans",
        "NC1HWC0(C04)", "Fractal-Z(C04)", "CHWN", "Fractal-Deconv-SP-Stride8-Trans", "HWCN",
        "NC1KHKWHWC0", "BN", "Filter HWCK"];
    return FORMAT_LIST[i];
}


function flopsToString(flops) {
    let result = new Number(flops / 1e6).toFixed(1) + "M";
    if (flops >= 1e12) {
        result = new Number(flops / 1e12).toFixed(1) + "T";
    } else if (flops >= 1e9) {
        result = new Number(flops / 1e9).toFixed(1) + "G";
    }
    return result + " (" + flops + ")";
}


function isNodeConst(op) {
    return op.type == "Const" || op.type == "QuantizedConst";
}


om.ModelFactory = class {

    match(context) {
        return om.Container.open(context);
    }

    open(context, match) {
        return om.Metadata.open(context).then((metadata) => {
            if (match === 'IMOD' || match === 'CUST') {
                var target = new om.Container(context, match);
                return context.require('./om-proto').then(() => {
                    try {
                        target._loadModel(context, false);
                    } catch (error) {
                        target._loadModel(context, true);
                    }
                    return new om.Model(metadata, [target.model], [target.weights], target.device);
                });
            } else {
                throw new om.Error('Unsupported DaVinci OM ' + this.match + ' signature.');
            }
        });
    }
};


om.Container = class {

    static open(context) {
        const stream = context.stream;
        if (stream && stream.length >= 256) {
            const buffer = stream.peek(4);
            const signature = Array.from(buffer).map((c) => String.fromCharCode(c)).join('');
            if (signature === 'IMOD' || signature === 'CUST') {
                return signature;
            }
        }
        return null;
    }

    constructor(context, signature) {
        this._context = context;
        this._signature = signature;
        this.device = new Map();
        if (signature == 'IMOD') {
            this._offset = 0;
        } else if (signature == 'CUST') {
            var reader = new base.BinaryReader(context.stream);
            this._offset = reader.view.getUint32(4, true) + 16;
        }
    }

    _loadModel(context, isHugeModel) {
        const MODEL_DEF = 0;
        const MODEL_WEIGHT = 1;
        const MODEL_TASK = 2;
        const MODEL_SIGNATURE = 3;
        const MODEL_UNKNOWN1 = 4;
        const MODEL_UNKNOWN2 = 8;
        const MODEL_UNKNOWN3 = 238;
        const DEVICE_CONFIG = 5;
        const HEADER_SIZE = 256;
        var TABLE_INDEX_SIZE;
        var MODEL_PARTITION_MEM_INFO_SIZE;
        if (isHugeModel) {
            TABLE_INDEX_SIZE = 8;
            MODEL_PARTITION_MEM_INFO_SIZE = 24;
        } else {
            TABLE_INDEX_SIZE = 4;
            MODEL_PARTITION_MEM_INFO_SIZE = 12;
        }
        const stream = context.stream;
        const reader = new base.BinaryReader(stream);
        reader.seek(0);
        reader.skip(HEADER_SIZE);
        var partitions;
        if (isHugeModel) {
            partitions = new Array(reader.uint64());
            for (let i = 0; i < partitions.length; i++) {
                partitions[i] = {
                    type: reader.uint64(),
                    offset: reader.uint64(),
                    size: reader.uint64()
                };
            }
        } else {
            partitions = new Array(reader.uint32());
            for (let i = 0; i < partitions.length; i++) {
                partitions[i] = {
                    type: reader.uint32(),
                    offset: reader.uint32(),
                    size: reader.uint32()
                };
            }
        }
        const offset = this._offset + HEADER_SIZE + TABLE_INDEX_SIZE +
            MODEL_PARTITION_MEM_INFO_SIZE * partitions.length;
        for (const partition of partitions) {
            reader.seek(offset + partition.offset);
            const buffer = reader.read(partition.size);
            switch (partition.type) {
                case MODEL_DEF: { // MODEL_DEF
                    this.model = buffer;
                    break;
                }
                case MODEL_WEIGHT: { // WEIGHTS_DATA
                    this.weights = buffer;
                    break;
                }
                case MODEL_TASK: {// TASK_INFO
                    break;
                }
                case MODEL_SIGNATURE: { // TBE_KERNELS
                    break;
                }
                case MODEL_UNKNOWN1: { // CUST_AICPU_KERNELS
                    break;
                }
                case MODEL_UNKNOWN2: {
                    break;
                }
                case MODEL_UNKNOWN3: {
                    break;
                }
                case DEVICE_CONFIG: { // DEVICE_CONFIG
                    let reader = new base.BinaryReader(this._context.stream);
                    let content = reader.view;
                    const decoder = new TextDecoder('ascii');
                    try {
                        let position = 4;
                        while (position < partition.size) {
                            let length = content.getUint32(offset - this._offset + position, true);
                            reader.seek(0);
                            reader.skip(position + 4);
                            let buffer = reader.read(length);
                            let name = decoder.decode(buffer);
                            let device = content.getUint32(offset - this._offset + position + 4 + length, true);
                            position += length + 8;
                            this.devices.set(name, device);
                        }
                    } catch {
                        // Ignore if failed to parse device config
                    }
                    break;
                }
                default: {
                    throw new om.Error("Unsupported partition type '" + partition.type + "'.");
                }
            }
        }
        if (!this.model.length) {
            throw new om.Error('File does not contain a model definition.');
        }
        try{
            om.proto = protobuf.get('om').om;
            const omReader = protobuf.BinaryReader.open(this.model);
            this.model = om.proto.ModelDef.decode(omReader);
        } catch (error) {
            const message = error && error.message ? error.message : error.toString();
            throw new om.Error('File format is not ge.proto.ModelDef (' + message.replace(/\.$/, '') + ').');
        }
    }
};


om.Metadata = class {
    static open(context) {
        om.Metadata.textDecoder = om.Metadata.textDecoder || new TextDecoder('utf-8');
        if (om.Metadata._metadata) {
            return Promise.resolve(om.Metadata._metadata);
        }
        return context.request('./om-metadata.json', 'utf-8', null).then((data) => {
            om.Metadata._metadata = new om.Metadata(data);
            return om.Metadata._metadata;
        }).catch(() => {
            om.Metadata._metadata = new om.Metadata(null);
            return om.Metadata._metadata;
        });
    }

    constructor(data) {
        this._map = {};
        this._attributeCache = {};
        if (data) {
            let items = JSON.parse(data);
            if (items) {
                for (let item of items) {
                    if (item.name && item.schema) {
                        this._map[item.name] = item.schema;
                        this._map[item.name].attributes.push({"name": "format", "type": "Format"});
                    }
                }
            }
        }
    }

    type(type) {
        var nodeType = this._map[type] || null;
        if (nodeType) {
            nodeType["name"] = type;
        }
        return nodeType;
    }

    attribute(type, name) {
        let map = this._attributeCache[type];
        if (!map) {
            map = {};
            const schema = this.type(type);
            if (schema && schema.attributes && schema.attributes.length > 0) {
                for (let attribute of schema.attributes) {
                    map[attribute.name] = attribute;
                }
            }
            this._attributeCache[type] = map;
        }
        return map[name] || null;
    }
};


om.Model = class {

    constructor(metadata, nets, weights, deviceConfigMap) {
        this._deviceConfigMap = deviceConfigMap;
        this._weights = weights;
        this._format = "DaVinci OM";
        this._flops = 0;
        this._npuFlops = 0;
        this._graphs = [];

        for (let i = 0; i < nets.length; ++i) {
            let index = nets.length == 1 ? undefined : i+1;
            let net = nets[i];
            let mainGraph = net.graph[0];
            let weight = this._weights[i];

            if (nets.length > 1) {
                this._modelType = "Multi-shape model";
            } else {
                if ("graph_infershaped_flag" in mainGraph.attr && mainGraph.attr["graph_infershaped_flag"].b) {
                    this._modelType = "Shape Infered By NPU IR Model";
                } else if ("ir_infershaped" in mainGraph.attr && mainGraph.attr["ir_infershaped"].b) {
                    this._modelType = "Shape Infered By DDK IR Model";
                } else if ("hiai_version" in mainGraph.attr) {
                    if (new TextDecoder("utf-8").decode(mainGraph.attr["hiai_version"].s) == "ir") {
                        this._modelType = "Shape Uninfered IR Model";
                    }
                } else if ("memory_size" in mainGraph.attr) {
                    this._modelType = `Compiled Model`;
                    this._description = `memory: ${mainGraph.attr["memory_size"].i}`;
                    if ("weight_size" in mainGraph.attr) {
                        this._description |= `, weight: ${mainGraph.attr["weight_size"].i}`;
                    }
                } else if ("memory_size" in net.attr) {
                    this._modelType = `Legacy Model`;
                    this._description = `memory: ${net.attr["memory_size"].i}, weight: ${net.attr["weight_size"].i}`;

                } else {
                    this._modelType = `Unknown format`;
                }
            }

            for (var j = 0; j < net.graph.length; ++j) {
                this._extractGraph(metadata, net.graph[j], net, this, weight, index, "");
            }
        }
    }

    _extractGraph(metadata, graph, net, model, weight, index, parentName) {
        for (let op of graph.op) {
            for (let item in op.attr) {
                if (Object.prototype.hasOwnProperty.call(op.attr[item], 'g')) {
                    let subgraph = op.attr[item].g;
                    if (index != undefined) {
                        subgraph.name = subgraph.name + "-shape: " + index;
                    }
                    this._extractGraph(metadata, subgraph, net, model, weight, index, subgraph.name);
                    delete op.attr[item];
                } else if (item == "subgraph" && Object.prototype.hasOwnProperty.call(op.attr[item], 'bt')) {
                    let sb = op.attr[item].bt;
                    let subgraph = om.proto.GraphDef.decode(sb);
                    subgraph.name = parentName + "/" + subgraph.name;
                    this._extractGraph(metadata, subgraph, net, model, weight, index, subgraph.name);
                    delete op.attr[item];
                }
            }

            if (this._deviceConfigMap.has(op.name)) {
                let config = this._deviceConfigMap.get(op.name);
                var candidate_devices = [];
                if (config & 0x1) {
                    candidate_devices.push("NPU");
                }
                if ((config >> 1) & 0x1) {
                    candidate_devices.push("CPU");
                }
                op.attr["device"] = candidate_devices.join(" && ");
            }
        }
        if (index != undefined) {
            graph.name = graph.name + "-shape: " + index;
        }
        this._graphs.unshift(new om.Graph(metadata, graph, weight, model));
    }

    get format() {
        return this._format || 'DaVinci OM';
    }

    get modelType() {
        return this._modelType || 'DaVinci OM';
    }

    get producer() {
        return this._producer || '';
    }

    set flops(v) {
        this._flops = v;
    }

    set npuFlops(v) {
        this._npuFlops = v;
    }

    get flops() {
        return this._flops;
    }

    get npuFlops() {
        return this._npuFlops;
    }

    get description() {
        if (!this._description) {
            return `FLOPs: ${flopsToString(this.flops)} NPU FLOPs: ${flopsToString(this.npuFlops)}`;
        }
        return `FLOPs: ${flopsToString(this.flops)} NPU FLOPs: ${flopsToString(this.npuFlops)}, ${this._description}`;
    }

    get source() {
        return this._source || '';
    }

    get graphs() {
        return this._graphs;
    }
};


om.Graph = class {

    constructor(metadata, graph, weight, model) {
        this._model = model;
        this._nodes = [];
        this._inputs = [];
        this._outputs = [];
        this._name = graph.name;
        this._weight = weight;
        this._flops = 0;
        this._npuFlops = 0;
        var mainGraph = graph;
        for (var op of mainGraph.op) {
            if (!isNodeConst(op)) {
                op.name = (op.name == "") ? "internal_unnamed" : op.name;
                this._nodes.push(new om.Node(metadata, op, mainGraph, this._weight, model));
            }
        }
    }

    get name() {
        return this._name;
    }

    get groups() {
        return false;
    }

    get nodes() {
        return this._nodes;
    }

    get outputs() {
        return this._outputs;
    }

    get inputs() {
        return this._inputs;
    }
};


om.Node = class {
    static enum2Dtype(val) {
        const TYPE_LIST = ["undefined", "float32", "float16", "int8", "uint8", "int16", "uint16", "int32",
            "uint32", "int64", "uint64", "bool", "float64"];
        return TYPE_LIST[val];
    }
    static enum2DtypeInner(val) {
        const TYPE_LIST = ["float32", "float16", "int8", "int32", "uint8", "", "int16", "uint16", "uint32",
            "int64", "uint64", "float64", "bool", "dual", "dual int8", "dual uint8"];
        return TYPE_LIST[val];
    }
    constructor(metadata, op, graph, weight, model) {
        this._model = model;
        this._name = op.name;
        this._weight = weight;
        this._metadata = metadata;
        this._type = metadata.type(op.type) || { name: op.type };
        this._attributes = [];
        this._inputs = [];
        this._outputs = [];
        this._chains = [];
        this._controlDependencies = [];
        this._device = null;

        const ATTR_BLACK_LIST = [];

        var schema = metadata.type(this._type.name);

        if (!schema) {
            schema = metadata.type("Undefined");
        }
        /* The length of input might not equal to input_desc, empty items in input refer to optional inputs,
        which are not in input_desc. */
        let inputIdx = 0;
        let weightDims = null;
        for (let i = 0; i < op.input.length; ++i) {
            if (op.input[i] == "") {
                continue;
            }
            let pos = op.input[i].lastIndexOf(":");
            let name = (pos == 0) ? "internal_unnamed" : op.input[i].slice(0, pos);
            var src_index = op.input[i].slice(pos+1);
            if (src_index == -1) {
                this._controlDependencies.push(name);
                continue;
            }
            let schemaName = '';
            if (i < schema.inputs.length) {
                schemaName = schema.inputs[i].name;
            } else {
                schemaName = schema.inputs[schema.inputs.length-1].name;
            }
            let inputNode = graph.op.find(node => node.name == name);
            let inputFormat = op.input_desc[inputIdx].layout;

            if (isNodeConst(inputNode)) {
                var inputDims = null;
                if (inputNode.attr["value"].t.desc.shape != null) {
                    inputDims = inputNode.attr["value"].t.desc.shape.dim;
                }
                /* For a compiled model, the shape may be a raw shape or a fractal-z shape.
                The following lines ensure getting the raw shape. */
                if ('origin_shape' in inputNode.attr["value"].t.desc.attr) {
                    inputDims = inputNode.attr["value"].t.desc.attr["origin_shape"].list.i;
                }
                let inputDtype = om.Node.enum2Dtype(inputNode.attr["value"].t.desc.dtype);
                if (!weightDims) { //Save the first const as weight
                    weightDims = inputDims;
                }

                var data = null;

                if (inputNode.attr["value"].t.data == '') {
                    if (this._weight == null) {
                        data = null;
                    } else if ('merged_offset' in inputNode.attr['value'].t.desc.attr) {
                        let offset = inputNode.attr['value'].t.desc.attr['merged_offset'].i;
                        data = this._weight.slice(offset, offset + inputNode.attr['value'].t.desc.weight_size);
                    } else {
                        let offset = inputNode.attr['value'].t.desc.data_offset;
                        data = this._weight.slice(offset, offset + inputNode.attr['value'].t.desc.weight_size);
                    }
                } else {
                    data = inputNode.attr["value"].t.data;
                }
                let dataLength = (data == null) ? 0 : data.length;
                let tmpTensorType = new om.TensorType(inputDtype, inputDims, inputFormat,
                    inputNode.attr['value'].t.desc.layout, dataLength);
                let tmpTensor = new om.Tensor('Constant', tmpTensorType, data);
                let tensor = new om.Argument(name, null, tmpTensor);
                this._inputs.push(new om.Parameter(schemaName, true, [tensor]));
            } else {
                let inputDims = op.input_desc[inputIdx].shape ? op.input_desc[inputIdx].shape.dim : undefined;
                let inputDtype = op.input_desc[i] ? om.Node.enum2Dtype(op.input_desc[i].dtype) : "undefined";
                let inputName = src_index == 0 ? name : name + ":" + src_index;
                let tmpTensorType = new om.TensorType(inputDtype, inputDims, inputFormat, null);
                let tmpArgument = new om.Argument(inputName, tmpTensorType, null)
                this._inputs.push(new om.Parameter(schemaName, true, [tmpArgument]));
            }
            ++inputIdx;
        }

        var outputIdx = 0;
        for (let outputDesc of op.output_desc) {
            let outputDims = outputDesc.shape ? outputDesc.shape.dim : undefined;
            let outputDtype = om.Node.enum2Dtype(outputDesc.dtype);
            let outputFormat = outputDesc.layout;
            let outputName = (outputIdx == 0) ? this._name : this._name + ":" + outputIdx;
            let outputSchemaName = '';
            if (outputIdx < schema.outputs.length) {
                outputSchemaName = schema.outputs[outputIdx].name;
            } else {
                outputSchemaName = schema.outputs[schema.outputs.length-1].name
            }
            let tmpTensorType = new om.TensorType(outputDtype, outputDims, outputFormat)
            let tmpArgument = new om.Argument(outputName, tmpTensorType, null)
            this._outputs.push(new om.Parameter(outputSchemaName, true, [tmpArgument]));
            ++outputIdx;
        }

        for (var attr in op.attr) {
            if (!ATTR_BLACK_LIST.includes(attr)) {
                var value = op.attr[attr];
                if (attr == "device") {
                    this._device = value;
                    continue;
                }
                if (Object.prototype.hasOwnProperty.call(value, 'func')) {
                    let attrInFunc = this._extractFunc(value.func, attr+".");
                    for (let [k, v] of attrInFunc) {
                        this._attributes.push(new om.Attribute(null, k, v, schema, true));
                    }
                    continue;
                }
                this._attributes.push(new om.Attribute(null, attr, value, schema, true));
            }
        }

        if (op.type == "Convolution" || op.type == "ConvolutionDepthwise" || op.type == "ConvTranspose") {
            let outputDims = op.output_desc[0].shape ? op.output_desc[0].shape.dim : undefined;
            let inputDims = op.input_desc[0].shape ? op.input_desc[0].shape.dim : undefined;
            let format = "Unknown";

            if ("format" in op.attr) {
                format = formatEnumToString(op.attr["format"].i);
            } else if ("data_format" in op.attr) {
                format = new TextDecoder("utf-8").decode(op.attr["data_format"].s);
            } else if ("NHWC_FORMAT" in op.attr) {
                format = formatEnumToString(op.attr["NHWC_FORMAT"].b) ? "NHWC" : "NCHW";
            } else if (op.input_desc[0].layout != undefined) {
                format = op.input_desc[0].layout;
            }
            let group = 1;
            if ("groups" in op.attr) {
                group = op.attr["groups"].i;
            }

            if (inputDims == undefined || outputDims == undefined) {
                format = "Unknown shape";
            }

            weightDims = op.input_desc[1].shape.dim; // To confirm the format of filter

            var ho = 0;
            var wo = 0;
            var co = 0;
            var ci = 0;
            var kh = 0;
            var kw = 0;
            var hi = 0;
            var wi = 0;

            var strideH = 0;
            var strideW = 0;
            if (op.attr["strides"] != null) {
                strideH = op.attr["strides"].list.i[0];
                strideW = op.attr["strides"].list.i[1];
            } else {
                strideH = op.attr["stride"].list.i[0];
                strideW = op.attr["stride"].list.i[1];
            }

            if (format == "NCHW") {
                ho = outputDims[2];
                wo = outputDims[3];
                co = outputDims[1];
                ci = inputDims[1];
                hi = inputDims[2];
                wi = inputDims[3];
                kh = weightDims[2];
                kw = weightDims[3];
            } else if (format == "NHWC" ) {
                ho = outputDims[1];
                wo = outputDims[2];
                co = outputDims[3];
                ci = inputDims[3];
                hi = inputDims[1];
                wi = inputDims[2];
                kh = weightDims[2];
                kw = weightDims[3];
            }
            let M = ho * wo;
            if (op.type == "Convolution") {
                let N = co;
                let K = kh * kw * ci;
                let flops = M * N * K * 2 / group;
                this._attributes.push(new om.Attribute(null, "FLOPs (CPU)", flopsToString(flops), schema, true));
                model.flops = model.flops + flops;

                let K_ = kh * kw * (~~((ci + 15) / 16)) * 16;
                let N_ = (~~((N + 15) / 16)) * 16;
                let flops_ = M * N_ * K_ * 2 / group;
                this._attributes.push(new om.Attribute(null, "FLOPs (NPU)", flopsToString(flops_), schema, true));
                model.npuFlops = model.npuFlops + flops_;
            } else if (op.type == "ConvolutionDepthwise") {
                let N = 1;
                let K = kh * kw;
                let flops = ci * M * N * K *2;
                this._attributes.push(new om.Attribute(null, "FLOPs (CPU)", flopsToString(flops), schema, true));
                model.flops = model.flops + flops;
                let flops_ = (~~((ci + 15) / 16)) * 16 * M * N * K * 2;
                this._attributes.push(new om.Attribute(null, "FLOPs (NPU)", flopsToString(flops_), schema, true));
                model.npuFlops = model.npuFlops + flops_;
            } else if (op.type == "ConvTranspose") {
                /* Todo */
            }
        }
    }

    _extractFunc(func, prefix="") {
        var result = new Map;
        for (let key in func.attr) {
            let value = func.attr[key];
            if (Object.prototype.hasOwnProperty.call(value, 'func')) {
                let resultNextLevel = this._extractFunc(value.func, prefix+key+".");
                for (let [key2, value2] of resultNextLevel) {
                    result.set(key2, value2);
                }
                continue;
            }
            result.set(prefix+key, value);
        }
        return result;
    }

    get name() {
        return this._name || '';
    }

    get type() {
        return this._type;
    }

    get metadata() {
        let schema = this._metadata.type(this.type);
        return schema;
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    get attributes() {
        return this._attributes;
    }

    get chain() {
        return this._chains;
    }

    get device() {
        return this._device;
    }

    get controlDependencies() {
        return this._controlDependencies;
    }
};

om.Parameter = class {

    constructor(name, visible, args) {
        this._name = name;
        this._visible = visible;
        this._arguments = args;
    }

    get name() {
        return this._name;
    }

    get visible() {
        return this._visible;
    }

    get arguments() {
        return this._arguments;
    }
};

om.Argument = class {

    constructor(name, type, initializer) {
        this._name = name;
        this._type = type || null;
        this._initializer = initializer || null;
    }

    get name() {
        return this._name;
    }

    get type() {
        if (this._initializer) {
            return this._initializer.type;
        }
        return this._type;
    }

    get initializer() {
        return this._initializer;
    }
};

om.Attribute = class {

    constructor(type, name, value, schema, visible) {
        this._type = type;
        this._value = value;
        this._name = name;
        this._visible = visible;

        if (Object.prototype.hasOwnProperty.call(value, 'i')) {
            this._value = value.i;
        } else if (Object.prototype.hasOwnProperty.call(value, 'f')) {
            this._value = value.f;
        } else if (Object.prototype.hasOwnProperty.call(value, 'b')) {
            this._value = value.b;
        } else if (Object.prototype.hasOwnProperty.call(value, 'bt')) {
            if (0 != value.bt.length) {
                this._type = "tensor";
                let tmpTensorType = new om.TensorType("float32", [value.bt.length/4], null);
                this._value = new om.Tensor('Constant', tmpTensorType, value.bt);
            } else {
                this._value = "NIL";
            }
        } else if (Object.prototype.hasOwnProperty.call(value, 's')) {
            if (typeof value.s === "string") {
                this._value = value.s;
            } else if (value.s.filter(c => c <= 32 && c >= 128).length == 0) {
                this._value = om.Metadata.textDecoder.decode(value.s);
            } else {
                this._value = value.s;
            }
        } else if (Object.prototype.hasOwnProperty.call(value, 'list')) {
            let list = value.list;
            this._value = [];
            if (list.s && list.s.length > 0) {
                this._value = list.s.map(v => String.fromCharCode.apply(null, new Uint16Array(v))).join(', ');
            } else if (list.i && list.i.length > 0) {
                this._value = list.i;
            } else if (list.f && list.f.length > 0) {
                this._value = list.f;
            } else if (list.type && list.type.length > 0) {
                this._type = 'type[]';
                this._value = list.type.map((type) => om.Tensor.formatDataType(type));
            } else if (list.shape && list.shape.length > 0) {
                this._type = 'shape[]';
                this._value = list.shape.map((shape) => new om.TensorShape(shape));
            }
        }

        let attrMeta = schema.attributes.find(item => item.name == name);
        if (attrMeta && attrMeta.type) {
            if (attrMeta.type == "Enum") {
                this._value = attrMeta.enum[this._value];
            }
            if (attrMeta.type == "DataType") {
                this._value = om.Node.enum2Dtype(this._value);
            }
            if (attrMeta.type == "DataTypeInner") {
                this._value = om.Node.enum2DtypeInner(this._value);
            }
            if (attrMeta.type == "Format") {
                const FORMAT_LIST = ["NCHW", "NHWC", "ND", "NC1HWC0", "Fractal-Z", "NC1C0HW Pad", "NHWC1C0",
                    "FSR_NCHW", "Fractal-Deconv", "C1HWNC0", "Fractal-Deconv-Transposed", "NC1HWC0(C04)",
                    "Fractal-Z(C04)", "CHWN", "Fractal-Deconc-SP-Stride8-Trans", "HWCN", "NC1KHKWHWC0",
                    "Fractal-Deconv-SP-Stride-Trans", "BN", "Filter HWCK"];
                this._value = FORMAT_LIST[this._value];
            }
            if (attrMeta.type == "Padding") {
                const PADDING_LIST = ["Ceil (Legacy)", "Direct Assign", "Valid (Legacy)", "Same (Legacy)", "Ceil",
                    "Valid", "Same"];
                this._value = PADDING_LIST[this._value];
            }
        }
    }

    toString() {
    }

    get name() {
        return this._name;
    }

    get type() {
        return this._type;
    }

    get value() {
        return this._value;
    }

    get visible() {
        return this._visible;
    }
};

om.Tensor = class {

    constructor(kind, type, value) {
        this._type = type;
        this._name = "";
        this._kind = kind;
        this._data = value;
        this._shape = type.shape.dimensions;
    }

    get name() {
        return this._name;
    }

    get type() {
        return this._type;
    }

    get kind() {
        return this._kind;
    }

    set kind(value) {
        this._kind = value;
    }

    get state() {
        return this._context().state;
    }

    get value() {
        let context = this._context();
        if (context.state) {
            return null;
        }
        context.limit = Number.MAX_SAFE_INTEGER;
        context.shape = this._type.rawShape.dimensions;
        return this._decode(context, 0);
    }

    _context() {
        let context = {};
        context.state = null;
        if (this._data == null) {
            context.state = 'Tensor data is empty.';
            return context;
        }

        context.index = 0;
        context.count = 0;
        context.dataType = this._type.dataType;
        context.shape = this._shape;
        context.rawData = this._data;
        return context;
    }

    _decode(context, dimension) {
        let shape = context.shape;
        if (shape.length == 0) {
            shape = [ 1 ];
        }
        let results = [];
        let size = shape[dimension];
        if (dimension == shape.length - 1) {
            for (let i = 0; i < size; ++i) {
                if (context.count > context.limit) {
                    results.push('...');
                    return results;
                }
                if (context.data) {
                    results.push(this._decodeDataValue(context));
                    context.count++;
                } else {
                    if (context.rawData) {
                        const view = new DataView(context.rawData.buffer, context.rawData.byteOffset,
                            context.rawData.length);
                        switch (context.dataType) {
                            case "float32":
                                var v = view.getFloat32(context.index, true);
                                results.push(v);
                                context.index += 4;
                                context.count++;
                                break;
                            case "int32":
                                var v = view.getInt32(context.index, true);
                                results.push(v);
                                context.index += 4;
                                context.count++;
                                break;
                            case "int64":
                                var v = view.getBigInt64(context.index, true);
                                results.push(Number(v));
                                context.index += 8;
                                context.count++;
                                break;
                            case "uint64":
                                var v = view.getBigUint64(context.index, true);
                                results.push(Number(v));
                                context.index += 8;
                                context.count++;
                                break;
                            case "uint32":
                                var v = view.getUint32(context.index, true);
                                results.push(v);
                                context.index += 4;
                                context.count++;
                                break;
                            case "float16":
                                var v = view.getFloat16(context.index, true);
                                results.push(v);
                                context.index += 2;
                                context.count++;
                                break;
                            case "int8":
                                var v = view.getInt8(context.index, true);
                                results.push(v);
                                context.index += 1;
                                context.count++;
                                break;
                            case "uint8":
                                var v = view.getUint8(context.index, true);
                                results.push(v);
                                context.index += 1;
                                context.count++;
                                break;
                        }
                    }
                }
            }
        } else {
            for (let j = 0; j < size; ++j) {
                if (context.count > context.limit) {
                    results.push('...');
                    return results;
                }
                results.push(this._decode(context, dimension + 1));
            }
        }
        if (context.shape.length == 0) {
            return results[0];
        }
        return results;
    }

    toString() {
        if (this._type.shape != this._type.rawShape) {
            if (this._type.rawShape.unknown) {
                return 'Unresolved format, export as 1-D array';
            } else {
                return 'Visualization unavailable, export for checking out';
            }
        }

        let context = this._context();
        if (context.state) {
            return '';
        }

        if (context.rawData.length == 0) {
            return 'Internal Error';
        }
        context.limit = 50;
        let value = this._decode(context, 0);
        return JSON.stringify(value, null, 4);
    }
};

om.TensorType = class {

    constructor(dtype, shape, format, denotation, size) {
        this._dtype = dtype;
        this._shape = new om.TensorShape(shape);
        this._format = format;
        this._denotation = denotation;
        this._size = size;
    }

    get dataType() {
        return this._dtype;
    }

    set shape(dims) {
        this._shape = dims;
    }

    get shape() {
        return this._shape;
    }

    get size() {
        let typeOf8Bytes = ["float64", "int64", "uint64"];
        let typeOf4Bytes = ["float32", "int32", "uint32"];
        let typeOf2Bytes = ["float16", "int16", "uint16"];
        let typeOf1Bytes = ["int8", "uint8", "bool"];
        if (typeOf1Bytes.indexOf(this.dataType) >= 0) {
            return this._size;
        }
        if (typeOf2Bytes.indexOf(this.dataType) >= 0) {
            return this._size / 2;
        }
        if (typeOf4Bytes.indexOf(this.dataType) >= 0) {
            return this._size / 4;
        }
        if (typeOf8Bytes.indexOf(this.dataType) >= 0) {
            return this._size / 8;
        }
        return -1;
    }

    get rawShape() {
        if (this.denotation == "NCHW" || this.denotation == "NHWC" || this.denotation == "ND") {
            return this.shape;
        }
        let dims = this._shape.dimensions;
        if (this._dtype == "float16") {
            if (dims.length == 1) {
                dims = [1, dims[0], 1, 1];
            }
            if (this._denotation == "NC1HWC0") {
                return new om.TensorShape([dims[0], ~~((parseInt(dims[1])+15)/16), dims[2], dims[3], 16]);
            } else if (this._denotation == "FRACTAL_Z") {
                return new om.TensorShape([~~((parseInt(dims[1])+15)/16), dims[2], dims[3],
                    (~~((parseInt(dims[0])+15)/16))*16, 16]);
            }
        }
        if (this._dtype == "int8") {
            if (this._denotation == "FRACTAL_Z") {
                return new om.TensorShape([~~((parseInt(dims[1])+31)/32), dims[2], dims[3],
                    (~~((parseInt(dims[0])+15)/16))*16, 32]);
            }
        }
        return new om.TensorShape([this.size], true);
    }

    get denotation() {
        return this._denotation;
    }

    get format() {
        return this._format;
    }

    toString() {
        if (this._format) {
            return this.dataType + " " + this._shape.toString() + '   &lt;' + this._format + "&gt;";
        } else {
            return this.dataType + " " + this._shape.toString();
        }
    }
};

om.TensorShape = class {

    constructor(shape, unknown=false) {
        this._shape = shape;
        this._unknown = unknown;
    }

    get dimensions() {
        return this._shape;
    }

    get unknown() {
        return this._unknown;
    }

    toString() {
        if (this._shape && Array.isArray(this._shape) && this._shape.length > 0) {
            return '[' + this._shape.map((dim) => dim ? dim.toString() : '?').join(',') + ']';
        } else if (this._shape) {
            return "[Scalar]";
        }
        return "[Unknown]";
    }
};

om.Error = class extends Error {

    constructor(message) {
        super(message);
        this.name = 'Error loading DaVinci model.';
    }
};

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
    module.exports.ModelFactory = om.ModelFactory;
}
