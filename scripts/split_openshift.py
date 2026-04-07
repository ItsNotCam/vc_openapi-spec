#!/usr/bin/env python3
"""
Split the OpenShift mega-spec into domain-grouped sub-specs.
Each output is a valid Swagger 2.0 spec with only relevant paths + definitions.

Usage: python3 scripts/split_openshift.py
Output: specs/openshift-*.json
"""

import json
import re
import sys
from pathlib import Path

INPUT = Path("specs/unused/openshift-api-v2.json")
OUT_DIR = Path("specs")

# Domain groupings: (output_suffix, set_of_api_group_prefixes)
DOMAINS = [
    ("core-k8s", {
        "v1", "apps", "batch", "autoscaling", "policy",
        "storage.k8s.io", "networking.k8s.io", "rbac.authorization.k8s.io",
        "authorization.k8s.io", "authentication.k8s.io", "certificates.k8s.io",
        "coordination.k8s.io", "discovery.k8s.io", "events.k8s.io",
        "flowcontrol.apiserver.k8s.io", "node.k8s.io", "scheduling.k8s.io",
        "apiextensions.k8s.io", "apiregistration.k8s.io", "metrics.k8s.io",
        "migration.k8s.io", "admissionregistration.k8s.io", "resource.k8s.io",
        "authorization.openshift.io", "core",
    }),
    ("openshift", {
        "operator.openshift.io", "config.openshift.io", "route.openshift.io",
        "build.openshift.io", "image.openshift.io", "oauth.openshift.io",
        "user.openshift.io", "project.openshift.io", "security.openshift.io",
        "console.openshift.io", "apps.openshift.io", "template.openshift.io",
        "machine.openshift.io", "machineconfiguration.openshift.io",
        "autoscaling.openshift.io", "helm.openshift.io",
        "quota.openshift.io", "monitoring.openshift.io",
        "imageregistry.operator.openshift.io", "ingress.operator.openshift.io",
        "network.operator.openshift.io", "performance.openshift.io",
        "local.storage.openshift.io", "csiaddons.openshift.io",
        "ocs.openshift.io", "replication.storage.openshift.io",
        "groupsnapshot.storage.openshift.io", "security.internal.openshift.io",
        "cloudcredential.openshift.io", "controlplane.operator.openshift.io",
        "apiserver.openshift.io", "samples.operator.openshift.io",
        "nfd.openshift.io", "ramendr.openshift.io",
    }),
    ("kubevirt", {
        "kubevirt.io", "subresources.kubevirt.io", "cdi.kubevirt.io",
        "snapshot.kubevirt.io", "migrations.kubevirt.io",
        "instancetype.kubevirt.io", "pool.kubevirt.io",
        "clone.kubevirt.io", "export.kubevirt.io", "ssp.kubevirt.io",
        "aaq.kubevirt.io", "hco.kubevirt.io", "forklift.cdi.kubevirt.io",
        "networkaddonsoperator.network.kubevirt.io", "hostpathprovisioner.kubevirt.io",
    }),
    ("storage", {
        "ceph.rook.io", "csi.ceph.io", "noobaa.io",
        "postgresql.cnpg.noobaa.io", "objectbucket.io",
        "snapshot.storage.k8s.io", "populator.storage.k8s.io",
    }),
    ("service-mesh", {
        "networking.istio.io", "security.istio.io", "telemetry.istio.io",
        "extensions.istio.io", "sailoperator.io",
        "gateway.networking.k8s.io", "inference.networking.x-k8s.io",
        "policy.networking.k8s.io", "whereabouts.cni.cncf.io", "k8s.cni.cncf.io",
        "k8s.ovn.org",
    }),
    ("serverless", {
        "serving.knative.dev", "networking.internal.knative.dev",
        "autoscaling.internal.knative.dev", "caching.internal.knative.dev",
        "operator.knative.dev", "operator.serverless.openshift.io",
        "eventing.knative.dev",
    }),
    ("ml-ai", {
        "kubeflow.org", "serving.kserve.io", "ray.io", "kueue.x-k8s.io",
        "pipelines.kubeflow.org", "workload.codeflare.dev",
        "dashboard.opendatahub.io", "trustyai.opendatahub.io",
        "datasciencepipelinesapplications.opendatahub.io",
        "modelregistry.opendatahub.io", "infrastructure.opendatahub.io",
        "nim.opendatahub.io", "opendatahub.io",
        "components.platform.opendatahub.io", "services.platform.opendatahub.io",
        "datasciencecluster.opendatahub.io", "dscinitialization.opendatahub.io",
        "features.opendatahub.io",
    }),
    ("operators-infra", {
        "operators.coreos.com", "olm.operatorframework.io",
        "packages.operators.coreos.com", "argoproj.io",
        "metal3.io", "infrastructure.cluster.x-k8s.io", "ipam.cluster.x-k8s.io",
        "nfd.k8s-sigs.io", "nvidia.com", "spyre.ibm.com",
        "cert-manager.io", "acme.cert-manager.io",
        "app.k8s.io", "workspace.devfile.io", "controller.devfile.io",
    }),
]


def path_group(path: str) -> str:
    m = re.match(r"^/apis?/([^/]+)", path)
    return m.group(1) if m else "core"


def collect_definition_refs(obj, found: set):
    """Recursively find all $ref values pointing to #/definitions/..."""
    if isinstance(obj, dict):
        ref = obj.get("$ref", "")
        if isinstance(ref, str) and ref.startswith("#/definitions/"):
            found.add(ref[len("#/definitions/"):])
        for v in obj.values():
            collect_definition_refs(v, found)
    elif isinstance(obj, list):
        for item in obj:
            collect_definition_refs(item, found)


def resolve_definitions(needed: set, all_defs: dict) -> dict:
    """Pull in definitions transitively."""
    resolved = {}
    queue = list(needed)
    while queue:
        name = queue.pop()
        if name in resolved or name not in all_defs:
            continue
        resolved[name] = all_defs[name]
        extra = set()
        collect_definition_refs(all_defs[name], extra)
        queue.extend(extra - resolved.keys())
    return resolved


def make_chunk(base: dict, paths_subset: dict, title_suffix: str) -> dict:
    needed_defs: set = set()
    collect_definition_refs(paths_subset, needed_defs)
    # Top-level parameters also reference definitions (e.g. body schemas)
    collect_definition_refs(base.get("parameters", {}), needed_defs)
    definitions = resolve_definitions(needed_defs, base.get("definitions", {}))

    chunk = {
        "swagger": base.get("swagger", "2.0"),
        "info": {**base.get("info", {}), "title": f"OpenShift — {title_suffix}"},
        "paths": paths_subset,
    }
    for key in ("host", "basePath", "schemes", "consumes", "produces", "securityDefinitions", "parameters"):
        if key in base:
            chunk[key] = base[key]
    if definitions:
        chunk["definitions"] = definitions
    return chunk


def main():
    print(f"Loading {INPUT} ...")
    with open(INPUT) as f:
        spec = json.load(f)

    all_paths = spec.get("paths", {})
    assigned: set = set()

    for suffix, groups in DOMAINS:
        subset = {p: v for p, v in all_paths.items() if path_group(p) in groups}
        if not subset:
            print(f"  {suffix}: no paths, skipping")
            continue
        assigned.update(subset.keys())
        chunk = make_chunk(spec, subset, suffix)
        out = OUT_DIR / f"openshift-{suffix}.json"
        with open(out, "w") as f:
            json.dump(chunk, f)
        size_kb = out.stat().st_size // 1024
        print(f"  {out.name}: {len(subset)} paths, {len(chunk.get('definitions', {}))} defs, {size_kb} KB")

    # Remainder — anything not matched above
    remainder = {p: v for p, v in all_paths.items() if p not in assigned}
    if remainder:
        chunk = make_chunk(spec, remainder, "misc")
        out = OUT_DIR / "openshift-misc.json"
        with open(out, "w") as f:
            json.dump(chunk, f)
        size_kb = out.stat().st_size // 1024
        print(f"  {out.name}: {len(remainder)} paths (unmatched), {size_kb} KB")

    print("Done.")


if __name__ == "__main__":
    main()
