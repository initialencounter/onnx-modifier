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

import json
from io import StringIO
from urllib import parse
from unittest.mock import patch

import pytest
from server import RequestInfo, RpcServer, ServerError


class TestRequestInfo:
    def test_files_given_files_when_has_file_pass(self):
        request_info = RequestInfo()
        request_info.set_json(dict(file=123))
        assert request_info.files.get("file") == 123
    
    def test_files_given_files_when_not_has_file_pass(self):
        request_info = RequestInfo()
        request_info.set_json(dict())

        assert request_info.files.get("file") is None

    def test_set_json_given_none_dict_when_any_pass(self):
        request_info = RequestInfo()
        dict_value = dict()
        request_info.set_json(dict_value)
        assert request_info.get_json() == dict_value

    def test_set_json_given_any_dict_when_any_pass(self):
        request_info = RequestInfo()
        dict_value = dict(test=123)
        request_info.set_json(dict_value)
        assert request_info.get_json() == dict_value

    def test_get_json_given_any_when_any_pass(self):
        request_info = RequestInfo()
        assert request_info.get_json() is not None


class TestRpcServer:

    @pytest.mark.parametrize("msg, status, file, except_out", 
                             [("msg123", 200, None, dict(msg="msg123", status=200, file=None, req_ind=1)),
                                 ("OK", 200, "/home/test/xxx.onnx", 
                                  dict(msg="OK", status=200, file="/home/test/xxx.onnx", req_ind=1)),
                                 ("msg", 440, None, dict(msg="msg", status=440, file=None, req_ind=1))])
    def test_send_message_given_any_when_any_pass(self, msg, status, file, except_out):
        with patch('sys.stdout', new=StringIO()) as fake_out:
            RpcServer.send_message(msg, status, file, 1)
            assert json.loads(parse.unquote(fake_out.getvalue()).replace(">>", "")) == except_out

    def test_send_message_given_line_break_when_any_pass(self):
        with patch('sys.stdout', new=StringIO()) as fake_out:
            RpcServer.send_message("OK\n\n\n", 200, None, 1)
            assert len(fake_out.getvalue().split("\n")) == 6
            except_msg_dict = dict(msg="OK\n\n\n", status=200, file=None, req_ind=1)
            assert json.loads(parse.unquote(fake_out.getvalue()).replace(">>", "")) == except_msg_dict

    def test_send_file_given_any_when_any_pass(self):
        file_msg = RpcServer.send_file("/path/")
        assert file_msg[0].get("file") == "/path/"
        assert file_msg[1] == 200

    def test_route_given_any_when_any_pass(self):
        server = RpcServer()

        def route_test():
            pass

        server.route("test_route")(route_test)
        assert server.path_amp.get("test_route") == route_test
        

    def test_run_given_any_when_any_pass(self):
        server = RpcServer()
        stdin_fake_info = dict(index=-1, strs=[
            "",
            "",
            "{\"path\":\"/exit\"}",
        ])

        def stdin_fake():
            stdin_fake_info["index"] = stdin_fake_info.get("index") + 1
            return stdin_fake_info.get("strs")[stdin_fake_info.get("index") % len(stdin_fake_info.get("strs"))]

        with patch('sys.stdin.readline', new=stdin_fake) as fake_out:
            server.run()
        
    @pytest.mark.parametrize("strs, msg", 
                             [(["", "", "msg_str", "", ""], "msg_str"),
                              (["msg_str", "", ""], "msg_str"),
                              (["", "", "msg_str", "_and_", "msg_str2", "", ""], "msg_str_and_msg_str2")])
    def test_get_std_in_given_any_when_any_pass(self, strs, msg):
        
        server = RpcServer()
        stdin_fake_info = dict(index=-1, strs=strs)

        def stdin_fake():
            stdin_fake_info["index"] = stdin_fake_info.get("index") + 1
            return stdin_fake_info.get("strs")[stdin_fake_info.get("index") % len(stdin_fake_info.get("strs"))]

        with patch('sys.stdin.readline', new=stdin_fake) as fake_out:
            msg_recv = ""
            while not msg_recv:
                msg_recv = server._get_std_in()
            assert  msg_recv == msg


    def test_run_given_large_msg_when_any_pass(self):
        server = RpcServer()
        server.max_msg_len_recv = 100
        stdin_fake_info = dict(index=-1, strs=["large_msg"])

        def stdin_fake():
            stdin_fake_info["index"] = stdin_fake_info.get("index") + 1
            return stdin_fake_info.get("strs")[stdin_fake_info.get("index") % len(stdin_fake_info.get("strs"))]

        with patch('sys.stdin.readline', new=stdin_fake) as fake_out:
            with pytest.raises(ValueError):
                msg_recv = ""
                while not msg_recv:
                    msg_recv = server._get_std_in()

    @pytest.mark.parametrize("msg_pkg, msg", 
                             [(dict(path="test", msg=123), 123)])
    def test_deal_msg_given_any_when_any_pass(self, msg_pkg, msg):
        server = RpcServer()

        def route_test():
            return dict(file="OK"), 200

        server.route("test")(route_test)

        server._deal_msg(msg_pkg, 1)
        assert server.request.get_json() == msg

    @pytest.mark.parametrize("msg_pkg", 
                             [(dict(path_not_exists="/exit")),
                              (dict(path="path_not_exists", msg=123))])
    def test_deal_msg_given_error_msg_when_any_pass(self, msg_pkg):
        server = RpcServer()

        with pytest.raises(ValueError):
            server._deal_msg(msg_pkg, 1)


class TestServerError:
    def test_status_given_any_when_any_pass(self):
        error = ServerError("msg", 404)
        assert error.status == 404
    
    def test_msg_given_any_when_any_pass(self):
        error = ServerError("msg", 404)
        assert error.msg == "msg"
