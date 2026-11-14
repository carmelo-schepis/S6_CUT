"""Fake `truenas_api_client`, the middleware Python client that TrueNAS 25.04's midclt is built on.

Only the surface the installer uses: `Client()` as a context manager and
`call(method, *params, job=False, callback=None)`. As in the real client, a job
call returns the job's result or raises ClientException, and the callback gets
the job dict. Calls are logged to FAKE_TN_LOG as {"tool": "client", "args": [...]}
with the params JSON-encoded. The payload never goes through argv, so
FAKE_TN_ARGV_LIMIT does not apply to this transport.
"""
import json
import os

import fake_middleware


class ClientException(Exception):
    def __init__(self, error):
        super().__init__(error)
        self.error = error

    def __str__(self):
        return self.error


class Client:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def call(self, method, *params, job=False, callback=None, background=False, timeout=None):
        with open(os.environ["FAKE_TN_LOG"], "a") as log:
            log.write(json.dumps({"tool": "client", "args": [method, *map(json.dumps, params)],
                                  "job": job}) + "\n")
        try:
            result = fake_middleware.call(method, list(params), job)
        except fake_middleware.MiddlewareError as e:
            raise ClientException(str(e)) from None
        if job and callback is not None:
            callback({"progress": {"description": "Fake job progress", "percent": 100}})
        return result
