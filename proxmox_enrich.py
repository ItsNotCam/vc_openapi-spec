#!/usr/bin/env python3
"""
Proxmox API live enrichment tool.

Decrypts the api-proxy auth token, calls every known Proxmox GET endpoint
with real path parameters, infers response schemas from live data, and
generates proxmox_enriched.yaml — a typed OpenAPI 3.0 spec ready for re-ingest.

Usage:
    python proxmox_enrich.py                  # full run
    python proxmox_enrich.py --dry-run        # collect data, don't write yaml
    python proxmox_enrich.py --skip-ssl       # skip SSL verification
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import httpx
import yaml
from dotenv import dotenv_values

# ---------------------------------------------------------------------------
# Config paths
# ---------------------------------------------------------------------------
PROXY_DIR = Path(__file__).parent.parent / "mcp_generic-api-passthrough"
PROXY_ENV = PROXY_DIR / ".env"
PROXY_CONFIG = PROXY_DIR / "config.yaml"
API_BASE = "https://gate.home.itsnotcam.dev"
OBSERVATIONS_FILE = Path(__file__).parent / "proxmox_observed.json"
OUTPUT_YAML = Path(__file__).parent / "proxmox_enriched.yaml"


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def load_auth() -> str:
    """Decrypt Proxmox Authorization header from the api-proxy config."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    env = dotenv_values(PROXY_ENV)
    key_hex = env.get("ENCRYPTION_KEY", "")
    if not key_hex:
        raise RuntimeError(f"ENCRYPTION_KEY not found in {PROXY_ENV}")

    config = yaml.safe_load(PROXY_CONFIG.read_text())
    encrypted_b64 = config["apis"]["/proxmox"]["authorization"]["headers"]["Authorization"]

    key = bytes.fromhex(key_hex)
    raw = base64.b64decode(encrypted_b64)
    iv, ciphertext = raw[:12], raw[12:]
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(iv, ciphertext, None).decode()


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def px_get(path: str, auth: str, verify: bool = True, params: dict | None = None) -> Any:
    """GET from Proxmox API. Returns parsed JSON body or None on error."""
    url = f"{API_BASE}{path}"
    try:
        r = httpx.get(
            url,
            headers={"Authorization": auth},
            params=params,
            timeout=15,
            verify=verify,
            follow_redirects=True,
        )
        if r.status_code == 200:
            return r.json()
        return None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Discovery — build context dict with real param values
# ---------------------------------------------------------------------------

def discover(auth: str, verify: bool = True) -> dict[str, Any]:
    ctx: dict[str, Any] = {}

    # Nodes
    r = px_get("/api2/json/nodes", auth, verify)
    nodes = [n["node"] for n in (r or {}).get("data", [])]
    ctx["node"] = nodes[0] if nodes else "prox"
    node = ctx["node"]
    print(f"  node = {node}")

    # QEMU VMs
    r = px_get(f"/api2/json/nodes/{node}/qemu", auth, verify)
    vms = [v["vmid"] for v in (r or {}).get("data", [])]
    ctx["vmid_qemu"] = vms[0] if vms else None
    print(f"  vmid_qemu = {ctx['vmid_qemu']}")

    # LXC containers
    r = px_get(f"/api2/json/nodes/{node}/lxc", auth, verify)
    lxcs = [v["vmid"] for v in (r or {}).get("data", [])]
    ctx["vmid_lxc"] = lxcs[0] if lxcs else None
    print(f"  vmid_lxc = {ctx['vmid_lxc']}")

    # Storage
    r = px_get(f"/api2/json/nodes/{node}/storage", auth, verify)
    storages = [s["storage"] for s in (r or {}).get("data", [])]
    ctx["storage"] = storages[0] if storages else None
    print(f"  storage = {ctx['storage']}")

    # Network interfaces
    r = px_get(f"/api2/json/nodes/{node}/network", auth, verify)
    ifaces = [i["iface"] for i in (r or {}).get("data", [])]
    ctx["iface"] = ifaces[0] if ifaces else None
    print(f"  iface = {ctx['iface']}")

    # Services
    r = px_get(f"/api2/json/nodes/{node}/services", auth, verify)
    svcs = [s["name"] for s in (r or {}).get("data", [])]
    ctx["service"] = svcs[0] if svcs else None
    print(f"  service = {ctx['service']}")

    # Tasks (upid)
    r = px_get(f"/api2/json/nodes/{node}/tasks", auth, verify)
    tasks = [(t.get("upid") or "") for t in (r or {}).get("data", [])]
    ctx["upid"] = tasks[0] if tasks else None
    print(f"  upid = {str(ctx['upid'])[:40] if ctx['upid'] else None}")

    # QEMU snapshots
    if ctx["vmid_qemu"]:
        r = px_get(f"/api2/json/nodes/{node}/qemu/{ctx['vmid_qemu']}/snapshot", auth, verify)
        snaps = [s["name"] for s in (r or {}).get("data", []) if s.get("name") != "current"]
        ctx["snapname"] = snaps[0] if snaps else None
        print(f"  snapname = {ctx['snapname']}")

    # LXC snapshots
    if ctx["vmid_lxc"]:
        r = px_get(f"/api2/json/nodes/{node}/lxc/{ctx['vmid_lxc']}/snapshot", auth, verify)
        snaps = [s["name"] for s in (r or {}).get("data", []) if s.get("name") != "current"]
        ctx["snapname_lxc"] = snaps[0] if snaps else None
    else:
        ctx["snapname_lxc"] = None

    # Backup jobs
    r = px_get("/api2/json/cluster/backup", auth, verify)
    jobs = [j["id"] for j in (r or {}).get("data", [])]
    ctx["backup_id"] = jobs[0] if jobs else None
    print(f"  backup_id = {ctx['backup_id']}")

    # Replication jobs
    r = px_get("/api2/json/cluster/replication", auth, verify)
    reps = [j["id"] for j in (r or {}).get("data", [])]
    ctx["replication_id"] = reps[0] if reps else None

    # HA resources
    r = px_get("/api2/json/cluster/ha/resources", auth, verify)
    hares = [h["sid"] for h in (r or {}).get("data", [])]
    ctx["ha_sid"] = hares[0] if hares else None

    # HA groups
    r = px_get("/api2/json/cluster/ha/groups", auth, verify)
    hagrps = [g["group"] for g in (r or {}).get("data", [])]
    ctx["ha_group"] = hagrps[0] if hagrps else None

    # Firewall rules (cluster level) — get pos=0 if any exist
    r = px_get("/api2/json/cluster/firewall/rules", auth, verify)
    rules = (r or {}).get("data", [])
    ctx["fw_pos"] = rules[0].get("pos", 0) if rules else None

    # Firewall groups
    r = px_get("/api2/json/cluster/firewall/groups", auth, verify)
    grps = [g["group"] for g in (r or {}).get("data", [])]
    ctx["fw_group"] = grps[0] if grps else None

    # Firewall ipsets
    r = px_get("/api2/json/cluster/firewall/ipset", auth, verify)
    ipsets = [i["name"] for i in (r or {}).get("data", [])]
    ctx["ipset_name"] = ipsets[0] if ipsets else None

    # Firewall aliases
    r = px_get("/api2/json/cluster/firewall/aliases", auth, verify)
    aliases = [a["name"] for a in (r or {}).get("data", [])]
    ctx["alias_name"] = aliases[0] if aliases else None

    # SDN vnets
    r = px_get("/api2/json/cluster/sdn/vnets", auth, verify)
    vnets = [v["vnet"] for v in (r or {}).get("data", [])]
    ctx["vnet"] = vnets[0] if vnets else None

    # SDN zones
    r = px_get("/api2/json/cluster/sdn/zones", auth, verify)
    zones = [z["zone"] for z in (r or {}).get("data", [])]
    ctx["sdn_zone"] = zones[0] if zones else None

    # SDN controllers
    r = px_get("/api2/json/cluster/sdn/controllers", auth, verify)
    ctrls = [c["controller"] for c in (r or {}).get("data", [])]
    ctx["sdn_controller"] = ctrls[0] if ctrls else None

    # ACME plugins
    r = px_get("/api2/json/cluster/acme/plugins", auth, verify)
    plugins = [p["plugin"] for p in (r or {}).get("data", [])]
    ctx["acme_plugin"] = plugins[0] if plugins else None

    # Metrics servers
    r = px_get("/api2/json/cluster/metrics/server", auth, verify)
    metrics = [m["id"] for m in (r or {}).get("data", [])]
    ctx["metrics_id"] = metrics[0] if metrics else None

    # Users (for access endpoints)
    r = px_get("/api2/json/access/users", auth, verify)
    users = [u["userid"] for u in (r or {}).get("data", [])]
    ctx["userid"] = users[0] if users else None

    # Auth domains
    r = px_get("/api2/json/access/domains", auth, verify)
    domains = [d["realm"] for d in (r or {}).get("data", [])]
    ctx["realm"] = domains[0] if domains else None

    # Roles
    r = px_get("/api2/json/access/roles", auth, verify)
    roles = [role["roleid"] for role in (r or {}).get("data", [])]
    ctx["roleid"] = roles[0] if roles else None

    # Groups
    r = px_get("/api2/json/access/groups", auth, verify)
    groups = [g["groupid"] for g in (r or {}).get("data", [])]
    ctx["groupid"] = groups[0] if groups else None

    # Pools
    r = px_get("/api2/json/pools", auth, verify)
    pools = [p["poolid"] for p in (r or {}).get("data", [])]
    ctx["poolid"] = pools[0] if pools else None

    # Storage (global)
    r = px_get("/api2/json/storage", auth, verify)
    gstorages = [s["storage"] for s in (r or {}).get("data", [])]
    ctx["global_storage"] = gstorages[0] if gstorages else ctx["storage"]

    # Storage content (to get a volume id)
    if ctx["storage"]:
        r = px_get(f"/api2/json/nodes/{node}/storage/{ctx['storage']}/content", auth, verify)
        volumes = [v["volid"] for v in (r or {}).get("data", [])]
        ctx["volume"] = volumes[0] if volumes else None
    else:
        ctx["volume"] = None

    # VM firewall rules (for pos)
    if ctx["vmid_qemu"]:
        r = px_get(f"/api2/json/nodes/{node}/qemu/{ctx['vmid_qemu']}/firewall/rules", auth, verify)
        rules = (r or {}).get("data", [])
        ctx["vm_fw_pos"] = rules[0].get("pos", 0) if rules else None

    # User token
    if ctx["userid"]:
        r = px_get(f"/api2/json/access/users/{ctx['userid']}/token", auth, verify)
        tokens = [t["tokenid"] for t in (r or {}).get("data", [])]
        ctx["tokenid"] = tokens[0] if tokens else None
    else:
        ctx["tokenid"] = None

    return ctx


# ---------------------------------------------------------------------------
# Endpoint catalog
# ---------------------------------------------------------------------------
# Each entry: (path_template, op_id, tags_csv, params_list)
# params_list items: (name, in, type, source_ctx_key_or_None)
# "type": "string"|"integer"

ENDPOINTS: list[tuple[str, str, str, list]] = [
    # ---- version ----
    ("/version", "getVersion", "version", []),

    # ---- cluster ----
    ("/cluster", "getCluster", "cluster", []),
    ("/cluster/status", "getClusterStatus", "cluster", []),
    ("/cluster/log", "getClusterLog", "cluster", []),
    ("/cluster/options", "getClusterOptions", "cluster", []),
    ("/cluster/tasks", "getClusterTasks", "cluster", []),
    ("/cluster/resources", "getClusterResources", "cluster", []),

    # cluster/config
    ("/cluster/config", "getClusterConfig", "cluster", []),
    ("/cluster/config/apiversion", "getClusterConfigApiversion", "cluster", []),
    ("/cluster/config/nodes", "getClusterConfigNodes", "cluster", []),
    ("/cluster/config/join", "getClusterConfigJoin", "cluster", []),
    ("/cluster/config/qdevice", "getClusterConfigQdevice", "cluster", []),
    ("/cluster/config/totem", "getClusterConfigTotem", "cluster", []),

    # cluster/backup
    ("/cluster/backup", "getClusterBackup", "cluster", []),
    ("/cluster/backup/{id}", "getClusterBackupSingle", "cluster",
     [("id", "path", "string", "backup_id")]),
    ("/cluster/backup/{id}/included_volumes", "getClusterBackupSingleIncludedvolumes", "cluster",
     [("id", "path", "string", "backup_id")]),
    ("/cluster/backupinfo", "getClusterBackupinfo", "cluster", []),
    ("/cluster/backupinfo/not_backed_up", "getClusterBackupinfoNotbackedup", "cluster", []),

    # cluster/replication
    ("/cluster/replication", "getClusterReplication", "cluster", []),
    ("/cluster/replication/{id}", "getClusterReplicationSingle", "cluster",
     [("id", "path", "string", "replication_id")]),

    # cluster/ha
    ("/cluster/ha", "getClusterHa", "cluster", []),
    ("/cluster/ha/status", "getClusterHaStatus", "cluster", []),
    ("/cluster/ha/status/current", "getClusterHaStatusCurrent", "cluster", []),
    ("/cluster/ha/status/manager_status", "getClusterHaStatusManagerstatus", "cluster", []),
    ("/cluster/ha/resources", "getClusterHaResources", "cluster", []),
    ("/cluster/ha/resources/{sid}", "getClusterHaResourcesSingle", "cluster",
     [("sid", "path", "string", "ha_sid")]),
    ("/cluster/ha/groups", "getClusterHaGroups", "cluster", []),
    ("/cluster/ha/groups/{group}", "getClusterHaGroupsSingle", "cluster",
     [("group", "path", "string", "ha_group")]),

    # cluster/firewall
    ("/cluster/firewall", "getClusterFirewall", "cluster", []),
    ("/cluster/firewall/options", "getClusterFirewallOptions", "cluster", []),
    ("/cluster/firewall/rules", "getClusterFirewallRules", "cluster", []),
    ("/cluster/firewall/rules/{pos}", "getClusterFirewallRule", "cluster",
     [("pos", "path", "integer", "fw_pos")]),
    ("/cluster/firewall/aliases", "getClusterFirewallAliases", "cluster", []),
    ("/cluster/firewall/aliases/{name}", "getClusterFirewallAlias", "cluster",
     [("name", "path", "string", "alias_name")]),
    ("/cluster/firewall/macros", "getClusterFirewallMacros", "cluster", []),
    ("/cluster/firewall/refs", "getClusterFirewallRefs", "cluster", []),
    ("/cluster/firewall/groups", "getClusterFirewallGroups", "cluster", []),
    ("/cluster/firewall/groups/{group}", "getClusterFirewallGroupRules", "cluster",
     [("group", "path", "string", "fw_group")]),
    ("/cluster/firewall/groups/{group}/{pos}", "getClusterFirewallGroupRule", "cluster",
     [("group", "path", "string", "fw_group"), ("pos", "path", "integer", "fw_pos")]),
    ("/cluster/firewall/ipset", "getClusterFirewallIPSets", "cluster", []),
    ("/cluster/firewall/ipset/{name}", "getClusterFirewallIPSet", "cluster",
     [("name", "path", "string", "ipset_name")]),

    # cluster/sdn
    ("/cluster/sdn", "getClusterSDN", "cluster", []),
    ("/cluster/sdn/vnets", "getClusterSDNVnets", "cluster", []),
    ("/cluster/sdn/vnets/{vnet}", "getClusterSDNVnet", "cluster",
     [("vnet", "path", "string", "vnet")]),
    ("/cluster/sdn/zones", "getClusterSDNZones", "cluster", []),
    ("/cluster/sdn/zones/{zone}", "getClusterSDNZone", "cluster",
     [("zone", "path", "string", "sdn_zone")]),
    ("/cluster/sdn/controllers", "getClusterSDNControllers", "cluster", []),
    ("/cluster/sdn/controllers/{controller}", "getClusterSDNController", "cluster",
     [("controller", "path", "string", "sdn_controller")]),

    # cluster/acme
    ("/cluster/acme", "getClusterAcme", "cluster", []),
    ("/cluster/acme/tos", "getClusterAcmeTos", "cluster", []),
    ("/cluster/acme/directories", "getClusterAcmeDirectories", "cluster", []),
    ("/cluster/acme/plugins", "getClusterAcmePlugins", "cluster", []),
    ("/cluster/acme/plugins/{id}", "getClusterAcmePlugin", "cluster",
     [("id", "path", "string", "acme_plugin")]),

    # cluster/metrics
    ("/cluster/metrics/server", "getClusterMetricsServer", "cluster", []),
    ("/cluster/metrics/server/{id}", "getClusterMetricsServerSingle", "cluster",
     [("id", "path", "string", "metrics_id")]),

    # cluster/ceph
    ("/cluster/ceph", "getClusterCeph", "cluster", []),

    # ---- nodes ----
    ("/nodes", "getNodes", "nodes", []),
    ("/nodes/{node}", "getNodesSingle", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/status", "getNodesSingleStatus", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/version", "getNodesSingleVersion", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/config", "getNodesSingleConfig", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/dns", "getNodesSingleDns", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/netstat", "getNodesSingleNetstat", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/report", "getNodesSingleReport", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/rrd", "getNodeRRD", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/rrddata", "getNodeRRDData", "nodes",
     [("node", "path", "string", "node")]),

    # nodes/tasks
    ("/nodes/{node}/tasks", "getNodeTasks", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/tasks/{upid}", "getNodeTask", "nodes",
     [("node", "path", "string", "node"), ("upid", "path", "string", "upid")]),
    ("/nodes/{node}/tasks/{upid}/status", "getNodeTaskStatus", "nodes",
     [("node", "path", "string", "node"), ("upid", "path", "string", "upid")]),
    ("/nodes/{node}/tasks/{upid}/log", "getNodeTaskLog", "nodes",
     [("node", "path", "string", "node"), ("upid", "path", "string", "upid")]),

    # nodes/replication
    ("/nodes/{node}/replication", "getNodesSingleReplication", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/replication/{id}/status", "getNodesSingleReplicationSingleStatus", "nodes",
     [("node", "path", "string", "node"), ("id", "path", "string", "replication_id")]),

    # nodes/network
    ("/nodes/{node}/network", "getNodesSingleNetwork", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/network/{iface}", "getNodesSingleNetworkSingle", "nodes",
     [("node", "path", "string", "node"), ("iface", "path", "string", "iface")]),
    ("/nodes/{node}/sdn", "getNodeSDN", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/sdn/zones", "getNodeSDNZones", "nodes",
     [("node", "path", "string", "node")]),

    # nodes/storage
    ("/nodes/{node}/storage", "getNodesSingleStorage", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/storage/{storage}", "getNodesSingleStorageSingle", "nodes",
     [("node", "path", "string", "node"), ("storage", "path", "string", "storage")]),
    ("/nodes/{node}/storage/{storage}/status", "getNodesSingleStorageSingleStatus", "nodes",
     [("node", "path", "string", "node"), ("storage", "path", "string", "storage")]),
    ("/nodes/{node}/storage/{storage}/content", "getNodesSingleStorageSingleContent", "nodes",
     [("node", "path", "string", "node"), ("storage", "path", "string", "storage")]),
    ("/nodes/{node}/storage/{storage}/content/{volume}", "getNodesSingleStorageSingleContentSingle", "nodes",
     [("node", "path", "string", "node"), ("storage", "path", "string", "storage"), ("volume", "path", "string", "volume")]),
    ("/nodes/{node}/storage/{storage}/rrd", "getNodesSingleStorageSingleRrd", "nodes",
     [("node", "path", "string", "node"), ("storage", "path", "string", "storage")]),
    ("/nodes/{node}/storage/{storage}/rrddata", "getNodesSingleStorageSingleRrddata", "nodes",
     [("node", "path", "string", "node"), ("storage", "path", "string", "storage")]),
    ("/nodes/{node}/storage/{storage}/prunebackups", "getNodesSingleStorageSinglePrunebackups", "nodes",
     [("node", "path", "string", "node"), ("storage", "path", "string", "storage")]),

    # nodes/disks
    ("/nodes/{node}/disks", "getNodesSingleDisks", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/disks/list", "getNodesSingleDisksList", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/disks/directory", "getNodesSingleDisksDirectory", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/disks/smart", "getNodesSingleDisksSmart", "nodes",
     [("node", "path", "string", "node")]),

    # nodes/services
    ("/nodes/{node}/services", "getNodesSingleServices", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/services/{service}/state", "getNodesSingleServicesSingleState", "nodes",
     [("node", "path", "string", "node"), ("service", "path", "string", "service")]),

    # nodes/certificates
    ("/nodes/{node}/certificates", "getNodesSingleCertificates", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/certificates/info", "getNodesSingleCertificatesInfo", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/certificates/acme", "getNodesSingleCertificatesAcme", "nodes",
     [("node", "path", "string", "node")]),

    # nodes/firewall
    ("/nodes/{node}/firewall", "getNodeFirewall", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/firewall/options", "getNodeFirewallOptions", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/firewall/rules", "getNodeFirewallRules", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/firewall/log", "getNodesSingleFirewallLog", "nodes",
     [("node", "path", "string", "node")]),

    # nodes/scan
    ("/nodes/{node}/scan", "getNodesSingleScan", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/scan/nfs", "getNodesSingleScanNfs", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/scan/iscsi", "getNodesSingleScanIscsi", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/scan/glusterfs", "getNodesSingleScanGlusterfs", "nodes",
     [("node", "path", "string", "node")]),

    # nodes/ceph
    ("/nodes/{node}/ceph/disks", "getNodesSingleCephDisks", "nodes",
     [("node", "path", "string", "node")]),

    # nodes/vzdump
    ("/nodes/{node}/vzdump/extractconfig", "getNodesSingleVzdumpExtractconfig", "nodes",
     [("node", "path", "string", "node")]),

    # ---- nodes/qemu ----
    ("/nodes/{node}/qemu", "getVMs", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/qemu/{vmid}", "getVM", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/status", "getVMStatus", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/status/current", "getCurrentVMStatus", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/config", "getVMConfig", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/pending", "getVMConfigPending", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/feature", "getNodesSingleQemuSingleFeature", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/migrate", "migrateVM", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/rrd", "getVMRRD", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/rrddata", "getVMRRDData", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/cloudinit/dump", "getNodesSingleQemuSingleCloudinitDump", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),

    # qemu/snapshot
    ("/nodes/{node}/qemu/{vmid}/snapshot", "getVMSnapshots", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/snapshot/{snapname}", "getVMSnapshot", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu"),
      ("snapname", "path", "string", "snapname")]),
    ("/nodes/{node}/qemu/{vmid}/snapshot/{snapname}/config", "getVMSnapshotConfig", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu"),
      ("snapname", "path", "string", "snapname")]),

    # qemu/firewall
    ("/nodes/{node}/qemu/{vmid}/firewall", "getVMFirewall", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/firewall/options", "getVMFirewallOptions", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/firewall/rules", "getVMFirewallRules", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/firewall/rules/{pos}", "getVMFirewallRule", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu"),
      ("pos", "path", "integer", "vm_fw_pos")]),
    ("/nodes/{node}/qemu/{vmid}/firewall/log", "getNodesSingleQemuSingleFirewallLog", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/firewall/aliases", "getNodesSingleQemuSingleFirewallAliases", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/firewall/ipset", "getVMFirewallIPSets", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/firewall/ipset/{name}", "getVMFirewallIPSet", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu"),
      ("name", "path", "string", "ipset_name")]),

    # qemu/agent
    ("/nodes/{node}/qemu/{vmid}/agent", "getNodesSingleQemuSingleAgent", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/agent/info", "getNodesSingleQemuSingleAgentInfo", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/agent/get-osinfo", "getNodesSingleQemuSingleAgentGetosinfo", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/agent/get-fsinfo", "getNodesSingleQemuSingleAgentGetfsinfo", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/agent/get-vcpus", "getNodesSingleQemuSingleAgentGetvcpus", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/agent/get-memory-blocks", "getNodesSingleQemuSingleAgentGetmemoryblocks", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/agent/get-users", "getNodesSingleQemuSingleAgentGetusers", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/agent/get-host-name", "getNodesSingleQemuSingleAgentGethostname", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/agent/get-timezone", "getNodesSingleQemuSingleAgentGettimezone", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/agent/network-get-interfaces", "getNodesSingleQemuSingleAgentNetworkgetinterfaces", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),
    ("/nodes/{node}/qemu/{vmid}/agent/exec-status", "getNodesSingleQemuSingleAgentExecstatus", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_qemu")]),

    # ---- nodes/lxc ----
    ("/nodes/{node}/lxc", "getNodesSingleLxc", "nodes",
     [("node", "path", "string", "node")]),
    ("/nodes/{node}/lxc/{vmid}", "getNodesSingleLxcSingle", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_lxc")]),
    ("/nodes/{node}/lxc/{vmid}/status", "getNodesSingleLxcSingleStatus", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_lxc")]),
    ("/nodes/{node}/lxc/{vmid}/status/current", "getNodesSingleLxcSingleStatusCurrent", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_lxc")]),
    ("/nodes/{node}/lxc/{vmid}/config", "getNodesSingleLxcSingleConfig", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_lxc")]),
    ("/nodes/{node}/lxc/{vmid}/pending", "getNodesSingleLxcSinglePending", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_lxc")]),
    ("/nodes/{node}/lxc/{vmid}/feature", "getNodesSingleLxcSingleFeature", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_lxc")]),
    ("/nodes/{node}/lxc/{vmid}/rrd", "getNodesSingleLxcSingleRrd", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_lxc")]),
    ("/nodes/{node}/lxc/{vmid}/rrddata", "getNodesSingleLxcSingleRrddata", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_lxc")]),
    ("/nodes/{node}/lxc/{vmid}/snapshot", "getNodesSingleLxcSingleSnapshot", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_lxc")]),
    ("/nodes/{node}/lxc/{vmid}/snapshot/{snapname}", "getNodesSingleLxcSingleSnapshotSingle", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_lxc"),
      ("snapname", "path", "string", "snapname_lxc")]),
    ("/nodes/{node}/lxc/{vmid}/snapshot/{snapname}/config", "getNodesSingleLxcSingleSnapshotSingleConfig", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_lxc"),
      ("snapname", "path", "string", "snapname_lxc")]),
    ("/nodes/{node}/lxc/{vmid}/firewall", "getNodesSingleLxcSingleFirewall", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_lxc")]),
    ("/nodes/{node}/lxc/{vmid}/firewall/options", "getNodesSingleLxcSingleFirewallOptions", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_lxc")]),
    ("/nodes/{node}/lxc/{vmid}/firewall/rules", "getNodesSingleLxcSingleFirewallRules", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_lxc")]),
    ("/nodes/{node}/lxc/{vmid}/firewall/log", "getNodesSingleLxcSingleFirewallLog", "nodes",
     [("node", "path", "string", "node"), ("vmid", "path", "integer", "vmid_lxc")]),

    # ---- access ----
    ("/access", "getAccess", "access", []),
    ("/access/acl", "getAccessAcl", "access", []),
    ("/access/permissions", "getAccessPermissions", "access", []),
    ("/access/users", "getAccessUsers", "access", []),
    ("/access/users/{userid}", "getAccessUsersSingle", "access",
     [("userid", "path", "string", "userid")]),
    ("/access/users/{userid}/tfa", "getAccessUsersSingleTfa", "access",
     [("userid", "path", "string", "userid")]),
    ("/access/users/{userid}/token", "getAccessUsersSingleToken", "access",
     [("userid", "path", "string", "userid")]),
    ("/access/users/{userid}/token/{tokenid}", "getAccessUsersSingleTokenSingle", "access",
     [("userid", "path", "string", "userid"), ("tokenid", "path", "string", "tokenid")]),
    ("/access/groups", "getAccessGroups", "access", []),
    ("/access/groups/{groupid}", "getAccessGroupsSingle", "access",
     [("groupid", "path", "string", "groupid")]),
    ("/access/roles", "getAccessRoles", "access", []),
    ("/access/roles/{roleid}", "getAccessRolesSingle", "access",
     [("roleid", "path", "string", "roleid")]),
    ("/access/domains", "getAccessDomains", "access", []),
    ("/access/domains/{realm}", "getAccessDomainsSingle", "access",
     [("realm", "path", "string", "realm")]),

    # ---- pools ----
    ("/pools", "getPools", "pools", []),
    ("/pools/{poolid}", "getPool", "pools",
     [("poolid", "path", "string", "poolid")]),

    # ---- storage ----
    ("/storage", "getStorage", "storage", []),
    ("/storage/{storage}", "getStorageSingle", "storage",
     [("storage", "path", "string", "global_storage")]),
]


# ---------------------------------------------------------------------------
# Schema inference
# ---------------------------------------------------------------------------

def infer_schema(value: Any, depth: int = 0) -> dict:
    """Convert a Python value to a minimal OpenAPI schema dict."""
    if depth > 3:
        return {}
    if value is None:
        return {"nullable": True}
    if isinstance(value, bool):
        return {"type": "boolean"}
    if isinstance(value, int):
        return {"type": "integer"}
    if isinstance(value, float):
        return {"type": "number"}
    if isinstance(value, str):
        return {"type": "string"}
    if isinstance(value, list):
        if not value:
            return {"type": "array", "items": {}}
        # Merge keys across first 5 items
        if all(isinstance(item, dict) for item in value[:5]):
            merged: dict = {}
            for item in value[:5]:
                merged.update(item)
            return {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {k: infer_schema(v, depth + 1) for k, v in merged.items()},
                },
            }
        return {"type": "array", "items": infer_schema(value[0], depth + 1)}
    if isinstance(value, dict):
        return {
            "type": "object",
            "properties": {k: infer_schema(v, depth + 1) for k, v in value.items()},
        }
    return {}


def schema_to_str(schema: dict) -> str:
    """Compact human-readable representation of a schema dict for display."""
    t = schema.get("type", "")
    if t == "array":
        items = schema.get("items", {})
        props = items.get("properties", {})
        if props:
            fields = ", ".join(f"{k}: {schema_to_str(v)}" for k, v in props.items())
            return f"array of {{ {fields} }}"
        return "array"
    if t == "object":
        props = schema.get("properties", {})
        if not props:
            return "object"
        fields = ", ".join(f"{k}: {schema_to_str(v)}" for k, v in props.items())
        return f"{{ {fields} }}"
    return t or "unknown"


# ---------------------------------------------------------------------------
# Collect
# ---------------------------------------------------------------------------

def substitute(template: str, params: list, ctx: dict) -> str | None:
    """Fill in all path params from ctx. Returns None if any param is missing."""
    path = template
    for name, _, ptype, ctx_key in params:
        if "{" + name + "}" not in path:
            continue
        val = ctx.get(ctx_key)
        if val is None:
            return None
        path = path.replace("{" + name + "}", str(val))
    return path


def collect(auth: str, ctx: dict, verify: bool = True) -> dict[str, dict]:
    observations: dict[str, dict] = {}

    for path_template, op_id, tags, params in ENDPOINTS:
        doc_id = f"proxmox:endpoint:GET:{path_template}"
        concrete = substitute(path_template, params, ctx)
        if concrete is None:
            print(f"  SKIP (missing param): GET {path_template}")
            observations[doc_id] = {
                "path_template": path_template,
                "concrete_path": None,
                "op_id": op_id,
                "tags": tags,
                "params": [(n, loc, t) for n, loc, t, _ in params],
                "raw_data": None,
                "inferred_schema": None,
                "skipped_reason": "missing_param",
            }
            continue

        url_path = f"/api2/json{concrete}"
        resp = px_get(url_path, auth, verify)
        if resp is None:
            print(f"  FAIL: GET {concrete}")
            observations[doc_id] = {
                "path_template": path_template,
                "concrete_path": concrete,
                "op_id": op_id,
                "tags": tags,
                "params": [(n, loc, t) for n, loc, t, _ in params],
                "raw_data": None,
                "inferred_schema": None,
                "skipped_reason": "request_failed",
            }
            continue

        data = resp.get("data")
        schema = infer_schema(data) if data is not None else None
        schema_str = schema_to_str(schema) if schema else "(empty)"
        print(f"  OK: GET {concrete}  →  {schema_str[:80]}")

        observations[doc_id] = {
            "path_template": path_template,
            "concrete_path": concrete,
            "op_id": op_id,
            "tags": tags,
            "params": [(n, loc, t) for n, loc, t, _ in params],
            "raw_data": data,
            "inferred_schema": schema,
            "schema_str": schema_str,
        }

    return observations


# ---------------------------------------------------------------------------
# OpenAPI YAML generation
# ---------------------------------------------------------------------------

def build_openapi(observations: dict[str, dict]) -> dict:
    paths: dict = {}

    for doc_id, obs in observations.items():
        template = obs["path_template"]
        op_id = obs["op_id"]
        tags = obs["tags"]
        params_list = obs["params"]
        data_schema = obs.get("inferred_schema")
        schema_str = obs.get("schema_str", "(empty)")

        # Build parameters
        parameters = []
        for name, loc, ptype in params_list:
            parameters.append({
                "name": name,
                "in": loc,
                "required": True,
                "schema": {"type": ptype},
            })

        # Build response schema — expose data fields directly so chunker renders real field names
        resp_schema: dict = data_schema if data_schema else {"type": "object"}

        operation: dict = {
            "operationId": op_id,
            "summary": op_id,
            "tags": [tags],
            "responses": {
                "200": {
                    "description": f"{op_id}Response",
                    "content": {
                        "application/json": {
                            "schema": resp_schema,
                        }
                    },
                }
            },
        }
        if parameters:
            operation["parameters"] = parameters

        path_entry = template.replace("{", "{").replace("}", "}")  # no-op, keep as-is
        if path_entry not in paths:
            paths[path_entry] = {}
        paths[path_entry]["get"] = operation

    return {
        "openapi": "3.0.0",
        "info": {
            "title": "Proxmox VE API (enriched)",
            "version": "1.0.0",
            "description": (
                "Proxmox VE REST API with response schemas inferred from live instance. "
                "Generated by proxmox_enrich.py."
            ),
        },
        "paths": paths,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Enrich Proxmox OpenAPI spec from live API")
    parser.add_argument("--dry-run", action="store_true", help="Don't write output files")
    parser.add_argument("--skip-ssl", action="store_true", help="Skip SSL cert verification")
    args = parser.parse_args()

    verify = not args.skip_ssl

    print("=== Loading auth ===")
    auth = load_auth()
    print("  Auth decrypted OK")

    print("\n=== Discovering live resources ===")
    ctx = discover(auth, verify)

    print(f"\n=== Collecting responses for {len(ENDPOINTS)} endpoints ===")
    observations = collect(auth, ctx, verify)

    ok = sum(1 for o in observations.values() if o.get("inferred_schema") is not None)
    skipped = sum(1 for o in observations.values() if o.get("skipped_reason") == "missing_param")
    failed = sum(1 for o in observations.values() if o.get("skipped_reason") == "request_failed")
    print(f"\nResults: {ok} enriched, {skipped} skipped (missing param), {failed} failed")

    if not args.dry_run:
        # Save observations
        OBSERVATIONS_FILE.write_text(
            json.dumps(observations, indent=2, default=str)
        )
        print(f"\nSaved observations → {OBSERVATIONS_FILE}")

        # Generate enriched OpenAPI YAML
        spec = build_openapi(observations)
        OUTPUT_YAML.write_text(yaml.dump(spec, allow_unicode=True, sort_keys=False))
        print(f"Saved enriched spec  → {OUTPUT_YAML}")
        print("\nNext step: push proxmox_enriched.yaml to GitHub, then call")
        print("  mcp__openapi-spec__ingest_spec with the raw GitHub URL")
    else:
        print("\n[dry-run] No files written.")


if __name__ == "__main__":
    main()
