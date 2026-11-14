"""Fake TrueNAS middleware shared by the installer tests.

Both the `midclt` CLI fake and the `truenas_api_client` fake answer from here,
so either transport sees the same state. State lives in the JSON file named by
FAKE_TN_STATE:
  version, pool, mnt (fake /mnt root), datasets {id: mountpoint},
  apps {name: {state, yaml, ports}},
  fail (method names that must fail),
  app_error (message every app.create/app.update fails with),
  reject_string (true: refuse custom_compose_config_string, as some middleware does).
Payload shapes mirror middlewared 25.04/25.10 (plugins/apps/crud.py, custom_app_utils.py).
"""
import json
import os
import pathlib
import shutil


class MiddlewareError(Exception):
    """A failed call. The message is what TrueNAS would report."""


JOBS = {"app.create", "app.update", "app.redeploy", "app.delete"}


def busy_paths(paths):
    """Processes with a working directory or open file under paths.

    ZFS refuses to unmount (and so to destroy) a dataset while any exist:
    "cannot unmount ...: pool or dataset is busy".
    """
    roots = [os.path.realpath(p) for p in paths]
    users = []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            links = [os.readlink(f"/proc/{pid}/cwd")]
            links += [os.readlink(f"/proc/{pid}/fd/{fd}") for fd in os.listdir(f"/proc/{pid}/fd")]
        except OSError:
            continue
        if any(link == r or link.startswith(r + "/") for link in links for r in roots):
            users.append(pid)
    return users


def match(filters, item):
    return all(item.get(key) == value for key, op, value in filters if op == "=")


def dataset(state, ds_id):
    children = [
        {"id": c, "mountpoint": m, "children": []}
        for c, m in sorted(state["datasets"].items()) if c.startswith(ds_id + "/")
    ]
    return {"id": ds_id, "name": ds_id, "mountpoint": state["datasets"][ds_id], "children": children}


def app(state, name):
    data = state["apps"][name]
    return {
        "id": name, "name": name, "state": data["state"], "custom_app": True,
        "active_workloads": {"used_ports": [
            {"container_port": 8080, "protocol": "tcp",
             "host_ports": [{"host_port": p, "host_ip": "0.0.0.0"} for p in data.get("ports", [])]}
        ] if data["state"] == "RUNNING" else []},  # stopped apps report no workloads (ix_apps/query.py)
    }


def compose_yaml(payload, schema):
    has_string = bool(payload.get("custom_compose_config_string"))
    has_dict = bool(payload.get("custom_compose_config"))
    if has_string == has_dict:
        raise MiddlewareError(f"{schema}.custom_compose_config: provide exactly one compose field")
    allowed = {"custom_compose_config_string", "custom_compose_config", "values"}
    if schema == "app_create":
        allowed |= {"app_name", "custom_app", "catalog_app", "train", "version"}
    if set(payload) - allowed:
        raise MiddlewareError(f"{schema}: unexpected fields {sorted(set(payload) - allowed)}")
    return payload.get("custom_compose_config_string") or json.dumps(payload["custom_compose_config"])


def call(method, params, job=False):
    """Run one middleware method against the fake state and return its result."""
    path = pathlib.Path(os.environ["FAKE_TN_STATE"])
    state = json.loads(path.read_text())

    def save():
        path.write_text(json.dumps(state))

    def fail(message):
        raise MiddlewareError(f"[EFAULT] {message}")

    if method in state.get("fail", []):
        fail(f"{method} failed (test)")
    if (method in JOBS) != job:
        fail(f"{method} {'is' if method in JOBS else 'is not'} a job; check the -j flag")
    if method.startswith("app.") and method in ("app.create", "app.update"):
        if state.get("app_error"):
            raise MiddlewareError(state["app_error"])
        payloads = [p for p in params if isinstance(p, dict)]
        if state.get("reject_string") and any("custom_compose_config_string" in p for p in payloads):
            raise MiddlewareError("[EINVAL] app_create.custom_compose_config_string: Extra inputs are not permitted")

    if method == "system.info":
        return {"version": state["version"], "hostname": "truenas"}
    if method == "docker.config":
        return {"pool": state.get("pool"), "dataset": f"{state.get('pool')}/ix-apps"}
    if method == "pool.dataset.query":
        filters = params[0] if params else []
        return [dataset(state, i) for i in sorted(state["datasets"]) if match(filters, {"id": i})]
    if method == "pool.dataset.create":
        payload = params[0]
        name = payload["name"]
        assert payload.get("type") == "FILESYSTEM", payload
        parent = name.rsplit("/", 1)[0]
        if name in state["datasets"]:
            fail(f"{name} already exists")
        if parent not in state["datasets"]:
            fail(f"Parent dataset {parent} does not exist")
        mountpoint = os.path.join(state["mnt"], name)
        os.makedirs(mountpoint)
        state["datasets"][name] = mountpoint
        save()
        return dataset(state, name)
    if method == "pool.dataset.delete":
        name, options = params[0], params[1] if len(params) > 1 else {}
        children = [d for d in state["datasets"] if d.startswith(name + "/")]
        if children and not options.get("recursive"):
            fail(f"{name} has children; recursive is required")
        if busy_paths([state["datasets"][ds] for ds in [name, *children]]):
            fail(f"Failed to delete dataset: cannot unmount '{name}': pool or dataset is busy")
        for ds in sorted([name, *children], reverse=True):
            shutil.rmtree(state["datasets"].pop(ds), ignore_errors=True)
        save()
        return True
    if method == "app.query":
        filters = params[0] if params else []
        return [app(state, n) for n in sorted(state["apps"]) if match(filters, {"name": n, "id": n})]
    if method == "app.create":
        payload = params[0]
        if payload.get("custom_app") is not True:
            fail("app_create.custom_app must be true for a compose app")
        name = payload["app_name"]
        if name in state["apps"]:
            fail(f"Application {name!r} already exists")
        state["apps"][name] = {"state": "RUNNING", "yaml": compose_yaml(payload, "app_create"),
                               "ports": state.get("app_ports", [])}
        save()
        return app(state, name)
    if method == "app.update":
        name, payload = params[0], params[1]
        if name not in state["apps"]:
            fail(f"{name} does not exist")
        state["apps"][name]["yaml"] = compose_yaml(payload, "app_update")
        # A stopped app only gets its configuration saved (crud.py do_update).
        save()
        return app(state, name)
    if method == "app.redeploy":
        state["apps"][params[0]]["state"] = "RUNNING"
        save()
        return app(state, params[0])
    if method == "app.delete":
        name, options = params[0], params[1] if len(params) > 1 else {}
        allowed = {"remove_images", "remove_ix_volumes", "force_remove_ix_volumes", "force_remove_custom_app"}
        if set(options) - allowed:
            fail(f"app_delete: unexpected fields {sorted(set(options) - allowed)}")
        state["apps"].pop(name)
        save()
        return True
    fail(f"Method {method!r} not stubbed")
