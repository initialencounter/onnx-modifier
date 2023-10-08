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

import argparse
import logging
import os
import tempfile

from flask import Flask, render_template, request, send_file
from server import register_interface


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5000, help='the port of the webserver. Defaults to 5000.')
    parser.add_argument('--debug', action="store_true", default=False, help='enable debug mode.')
    parser.add_argument('--onnx', type=str, help='onnx file path')
    
    args = parser.parse_args()
    return args


def main():
    args = parse_args()
    app = Flask(__name__, template_folder="static", static_url_path="/")
    
    @app.route('/')
    def index():
        return render_template('index.html')
    
    def send_file_method(file, session_id, **kwargs):
        if hasattr(file, "seek"):
            file.seek(0, os.SEEK_SET)

        return send_file(file, **kwargs)
    
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    with tempfile.TemporaryDirectory() as temp_dir_path:
        register_interface(app, request, send_file_method, temp_dir_path, args.onnx)
        app.run(host='localhost', port=args.port, debug=args.debug)

if __name__ == '__main__':
    main()
